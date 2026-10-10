// Paragraph splitting + excerpt selection. THE split rule below is a shared
// invariant: rawText is stored with paragraph breaks as "\n\n" (see
// ingestion/extractor.ts stripHtml), and BOTH the server (scoring payload
// numbering, excerpt building) and the client (litmus-client/src/lib/paragraphs.ts)
// MUST split identically, or the [P#] indices the scorer returns won't line up
// with the paragraphs the reader sees.

import type { PHMarker } from "../scoring/calibration.js";

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// How many markers appear verbatim in a paragraph.
function markerHits(paragraph: string, markers: PHMarker[]): number {
  return markers.reduce((n, m) => (m.text && paragraph.includes(m.text) ? n + 1 : n), 0);
}

// The window of up to `size` consecutive paragraphs with the most marker hits.
// Tie-break to the earlier window. Fallback only — the LLM's own pick is
// preferred (see resolveExcerptIndices).
export function densestWindow(paragraphs: string[], markers: PHMarker[], size = 3): number[] {
  if (paragraphs.length <= size) return paragraphs.map((_, i) => i);
  const counts = paragraphs.map((p) => markerHits(p, markers));
  let bestStart = 0;
  let bestSum = -1;
  for (let start = 0; start + size <= paragraphs.length; start++) {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += counts[i]!;
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = start;
    }
  }
  return Array.from({ length: size }, (_, k) => bestStart + k);
}

function countWords(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

// A contiguous paragraph window of ~min..max WORDS, seeded at the LLM's anchor
// (or the densest marker paragraph, or paragraph 0), grown forward then backward
// until it covers at least `min` words without overshooting `max`. This replaces
// fixed paragraph counts — excerpts read as a substantial 250–500 word passage.
export function wordWindow(
  paragraphs: string[],
  anchorIndices: number[],
  markers: PHMarker[],
  min = 250,
  max = 500,
): number[] {
  if (paragraphs.length === 0) return [];
  const valid = anchorIndices
    .filter((i) => Number.isInteger(i) && i >= 0 && i < paragraphs.length)
    .sort((a, b) => a - b);
  let start: number;
  if (valid.length > 0) start = valid[0]!;
  else if (markers.length > 0) start = densestWindow(paragraphs, markers, 1)[0]!;
  else start = 0;

  const chosen: number[] = [];
  let words = 0;
  // grow forward from the anchor
  for (let i = start; i < paragraphs.length && words < max; i++) {
    const w = countWords(paragraphs[i]!);
    if (words > 0 && words + w > max) break;
    chosen.push(i);
    words += w;
    if (words >= min) break;
  }
  // still short — extend backward
  for (let j = start - 1; j >= 0 && words < min; j--) {
    const w = countWords(paragraphs[j]!);
    if (words > 0 && words + w > max) break;
    chosen.unshift(j);
    words += w;
  }
  return chosen;
}

// ── Display cap ────────────────────────────────────────────────────────────
// What a reader is shown is at most EXCERPT_MAX_WORDS words and never more than
// EXCERPT_MAX_SHARE of the article (the excerpt policy). Fair use weighs the
// amount taken against the WHOLE work, so a short article gets a
// proportionally short excerpt. Measured on the 2026-09-13 edition before this
// cap: median excerpt 269 words, and 136 of 440 excerpts were over half their
// article.
//
// The cap is applied ONLY here, in buildExcerptWindow. wordWindow keeps its
// 250–500 defaults because scoring/markExcerpt.ts sends that window to the
// marking model; trimming inside an already-marked window changes what a
// reader sees without changing a single score or marker.
export const EXCERPT_MAX_WORDS = 200;
export const EXCERPT_MAX_SHARE = 0.25;

export function excerptWordCap(totalWords: number): number {
  return Math.max(0, Math.min(EXCERPT_MAX_WORDS, Math.floor(totalWords * EXCERPT_MAX_SHARE)));
}

// Sentence spans as [start, end) offsets into the paragraph. Offsets, never
// split-and-rejoin: rejoining would alter the text ("U.S." -> "U. S."), and
// markers and quotes are matched verbatim against it. A boundary is terminal
// punctuation (plus closing quotes/brackets) followed by whitespace and then
// something that can start a sentence.
function sentenceSpans(p: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /[.!?]+["'”’)\]]*\s+(?=["'“‘(\[]?[A-Z0-9])/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p)) !== null) {
    spans.push([start, m.index + m[0].trimEnd().length]);
    start = m.index + m[0].length;
  }
  if (start < p.length) spans.push([start, p.length]);
  return spans.filter(([a, b]) => p.slice(a, b).trim().length > 0);
}

interface SentenceUnit {
  para: number;
  start: number;
  end: number;
  words: number;
}

const ELLIPSIS = "…";

// Trim a paragraph window to at most `cap` words: the contiguous run of whole
// sentences holding the most markers (ties: more words, then earlier). Cuts
// that land inside a paragraph are shown with an ellipsis attached to the
// neighbouring word, so the word count stays within the cap.
export function capExcerpt(paragraphs: string[], markers: PHMarker[], cap: number): string[] {
  if (cap <= 0) return [];
  const total = paragraphs.reduce((n, p) => n + countWords(p), 0);
  if (total <= cap) return paragraphs;

  const units: SentenceUnit[] = [];
  paragraphs.forEach((p, para) => {
    for (const [start, end] of sentenceSpans(p)) {
      units.push({ para, start, end, words: countWords(p.slice(start, end)) });
    }
  });

  // Locate each marker once, as the unit range its first occurrence covers.
  const unitAt = (para: number, offset: number) =>
    units.findIndex((u) => u.para === para && offset >= u.start && offset < u.end);
  const spans: Array<[number, number]> = [];
  for (const m of markers) {
    if (!m.text) continue;
    const para = paragraphs.findIndex((p) => p.includes(m.text));
    if (para < 0) continue;
    const at = paragraphs[para]!.indexOf(m.text);
    const a = unitAt(para, at);
    const b = unitAt(para, at + m.text.length - 1);
    if (a >= 0 && b >= 0) spans.push([a, b]);
  }

  // Windows prefer to start at the beginning of a paragraph. Chasing the
  // densest run of highlights let a third of excerpts open mid-paragraph on a
  // sentence whose subject was in the sentence before it, which read as a
  // fragment. A mid-paragraph start is used only when every paragraph opening
  // would keep fewer than half the highlights the best window could show (for
  // example, one long paragraph whose marked sentence sits past the cap).
  const opensParagraph = (i: number) => i === 0 || units[i - 1]!.para !== units[i]!.para;
  type Window = { from: number; to: number; hits: number; words: number };
  const search = (allowMidParagraph: boolean): Window | null => {
    let found: Window | null = null;
    for (let from = 0; from < units.length; from++) {
      if (!allowMidParagraph && !opensParagraph(from)) continue;
      let words = 0;
      for (let to = from; to < units.length; to++) {
        words += units[to]!.words;
        if (words > cap) break;
        const hits = spans.filter(([a, b]) => a >= from && b <= to).length;
        if (!found || hits > found.hits || (hits === found.hits && words > found.words)) {
          found = { from, to, hits, words };
        }
      }
    }
    return found;
  };
  const atOpening = search(false);
  const anywhere = search(true);
  const best = atOpening && (!anywhere || atOpening.hits * 2 >= anywhere.hits) ? atOpening : anywhere;

  if (!best) {
    // Every sentence alone is longer than the cap. Show the opening `cap` words
    // of the sentence with the most markers.
    let pick = 0;
    let pickHits = -1;
    units.forEach((_, i) => {
      const hits = spans.filter(([a, b]) => a === i && b === i).length;
      if (hits > pickHits) {
        pick = i;
        pickHits = hits;
      }
    });
    const u = units[pick]!;
    const p = paragraphs[u.para]!;
    const head = p.slice(u.start, u.end).trim().split(/\s+/).slice(0, cap).join(" ");
    return [`${u.start > 0 ? ELLIPSIS : ""}${head}${ELLIPSIS}`];
  }

  const out: string[] = [];
  let i = best.from;
  while (i <= best.to) {
    const para = units[i]!.para;
    let j = i;
    while (j + 1 <= best.to && units[j + 1]!.para === para) j++;
    const p = paragraphs[para]!;
    const start = units[i]!.start;
    const end = units[j]!.end;
    const body = p.slice(start, end).trim();
    const lead = start > 0 && p.slice(0, start).trim().length > 0 ? ELLIPSIS : "";
    const tail = end < p.length && p.slice(end).trim().length > 0 ? ELLIPSIS : "";
    out.push(`${lead}${body}${tail}`);
    i = j + 1;
  }
  return out;
}

// The single shared excerpt builder: the 250–500 word marked window (anchored
// at the LLM's pick, densest-marker / first-paragraph fallback), trimmed to the
// display cap, with markers filtered to what survived. The flat feed and the
// section pages MUST both go through this function — duplicated copies drift.
export interface ExcerptWindow {
  paragraphs: string[];
  markers: PHMarker[];
}

export function buildExcerptWindow(
  rawText: string,
  excerptIndices: number[],
  markers: PHMarker[],
): ExcerptWindow | null {
  const paragraphs = splitParagraphs(rawText);
  if (paragraphs.length === 0) return null;
  const totalWords = paragraphs.reduce((n, p) => n + countWords(p), 0);
  const indices = wordWindow(paragraphs, excerptIndices, markers);
  const chosen = indices.map((i) => paragraphs[i]).filter((p): p is string => !!p);
  const shown = capExcerpt(chosen, markers, excerptWordCap(totalWords));
  if (shown.length === 0) return null;
  return {
    paragraphs: shown,
    markers: markers.filter((m) => shown.some((p) => p.includes(m.text))),
  };
}

// Resolve which paragraph indices form the excerpt. Prefer the LLM's picks
// (validated to be in range), then the densest marker window, then the first N.
export function resolveExcerptIndices(
  paragraphs: string[],
  excerptIndices: number[],
  markers: PHMarker[],
  size = 3,
): number[] {
  const valid = excerptIndices
    .filter((i) => Number.isInteger(i) && i >= 0 && i < paragraphs.length)
    .slice(0, size);
  if (valid.length > 0) return valid;
  if (markers.length > 0) return densestWindow(paragraphs, markers, size);
  return paragraphs.slice(0, size).map((_, i) => i);
}
