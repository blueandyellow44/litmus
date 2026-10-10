// Is this thing an article at all?
//
// The pipeline had no answer to that question, and it published the consequence.
// NBC's Nightly News video index page was ingested four times (snapshot articles
// 1440, 1441, 1442, 1444), and each copy is a list of video titles and mm:ss
// durations with "Now Playing" and "UP NEXT" in it. All four were scored, banded,
// sectioned and published. Article 1440 came out 3.5 Running Hot in World.
// Article 1444, which is the SAME PAGE one video later, came out 1.0 Practical in
// Politics. The instrument produced two answers three bands apart for one piece
// of furniture, which is the plainest available proof that a P/H number means
// nothing when the input is not an article.
//
// The model was not confused about what it was looking at. It wrote, in its own
// rationale: "This is not a news article; it is a video aggregator page with a
// loaded title and no reporting." It wrote that, and then returned five
// dimensions, and the pipeline used them.
//
// So there are two gates, and neither of them reads that sentence:
//
//   1. A REQUIRED, STRUCTURED classification the model must return
//      (`content_type` in the tool schema). Parsing a verdict back out of
//      free-form rationale prose would be building the product's own failure mode
//      into its guard: the whole premise of LITMUS is that prose is where meaning
//      goes to be argued with, and a gate has to be a field.
//
//   2. A DETERMINISTIC SHAPE CHECK on the extracted body, which needs no model at
//      all. This one exists because the first gate depends on the model
//      cooperating, and on these four pages it demonstrably would not have. The
//      shape check is what makes the fixture test meaningful rather than
//      circular.
//
// Either gate rejecting is enough to keep the item out of an edition.

export const CONTENT_TYPES = [
  // Publishable.
  "article", // reported news, analysis, opinion, review — anything written to be read
  "transcript", // a broadcast or video transcript, which IS the reporting in text form
  // Not publishable.
  "listing", // an index, playlist, or roundup of links to other pieces
  "navigation", // a section front, tag page, or menu scaffolding
  "furniture", // a subscription wall, error page, advertisement, or boilerplate
  "other", // recognisably none of the above
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

const PUBLISHABLE = new Set<ContentType>(["article", "transcript"]);

export function isPublishableType(t: ContentType): boolean {
  return PUBLISHABLE.has(t);
}

export function parseContentType(raw: unknown): ContentType | null {
  return typeof raw === "string" && (CONTENT_TYPES as readonly string[]).includes(raw)
    ? (raw as ContentType)
    : null;
}

// ── The deterministic shape check ──────────────────────────────────────────

// A paragraph that is nothing but a duration or a clock time: "02:10", "1:09".
const TIMESTAMP_ONLY = /^\d{1,2}:\d{2}$/;

// The words a media player puts around a playlist. Not content, and no article
// uses them as its own prose.
const PLAYLIST_CUES = /\b(now playing|up next|watch next|more videos|play all|autoplay)\b/i;

// A paragraph that reads like a sentence someone wrote: it ends in terminal
// punctuation and is long enough not to be a caption or a label. Twelve words is
// deliberately generous — a short wire lede clears it easily.
const MIN_PROSE_WORDS = 12;
function isProseParagraph(p: string): boolean {
  return /[.!?]["'”’]?$/.test(p) && p.split(/\s+/).length >= MIN_PROSE_WORDS;
}

export interface ShapeSignals {
  paragraphs: number;
  timestampRatio: number;
  playlistCues: number;
  proseRatio: number;
  // Which of the three independent signals fired.
  fired: string[];
}

// Thresholds are measured, not guessed. Across all 152 articles in the bundled
// 2026-08-03 edition:
//
//   timestampRatio  the four index pages sit at 0.456; the highest real article
//                   is The Bulwark at 0.048, a ~9x margin
//   playlistCues    the four index pages carry 4 each; every real article has 0
//   proseRatio      the four index pages have ZERO sentence-shaped paragraphs in
//                   57; the lowest real article is BBC Sport at 0.091
//
// Two of three must fire. One signal alone is not enough: a legitimate match
// report can run short on prose paragraphs, and a genuine transcript can carry
// timestamps. Requiring corroboration is what protects the short reports and the
// video transcripts the edition is supposed to keep.
const TIMESTAMP_RATIO_LIMIT = 0.2;
const PROSE_RATIO_FLOOR = 0.05;
const MIN_PARAGRAPHS_FOR_PROSE_SIGNAL = 8;
const SIGNALS_REQUIRED = 2;

export function measureShape(rawText: string): ShapeSignals {
  const paras = rawText
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const n = paras.length;
  const stamps = paras.filter((p) => TIMESTAMP_ONLY.test(p)).length;
  const cues = (rawText.match(new RegExp(PLAYLIST_CUES.source, "gi")) ?? []).length;
  const prose = paras.filter(isProseParagraph).length;

  const timestampRatio = n === 0 ? 0 : stamps / n;
  const proseRatio = n === 0 ? 0 : prose / n;

  const fired: string[] = [];
  if (timestampRatio >= TIMESTAMP_RATIO_LIMIT) fired.push("timestamp-paragraphs");
  if (cues > 0) fired.push("playlist-cues");
  if (n >= MIN_PARAGRAPHS_FOR_PROSE_SIGNAL && proseRatio <= PROSE_RATIO_FLOOR) {
    fired.push("no-sentences");
  }

  return { paragraphs: n, timestampRatio, playlistCues: cues, proseRatio, fired };
}

export interface ShapeVerdict {
  looksLikeListing: boolean;
  signals: ShapeSignals;
  reason: string | null;
}

// Model-independent. Give it the extracted body and it says whether the SHAPE is
// an index page rather than a piece of writing.
export function judgeShape(rawText: string): ShapeVerdict {
  const signals = measureShape(rawText);
  const looksLikeListing = signals.fired.length >= SIGNALS_REQUIRED;
  return {
    looksLikeListing,
    signals,
    reason: looksLikeListing
      ? `body has the shape of an index page (${signals.fired.join(", ")}: ` +
        `${(signals.timestampRatio * 100).toFixed(0)}% timestamp-only paragraphs, ` +
        `${signals.playlistCues} playlist cue(s), ` +
        `${(signals.proseRatio * 100).toFixed(0)}% sentence-shaped paragraphs)`
      : null,
  };
}

export interface ContentAdmission {
  admit: boolean;
  contentType: ContentType | null;
  reasons: string[];
}

// The whole gate. Both layers, either one sufficient to refuse.
export function admitContent(rawContentType: unknown, rawText: string): ContentAdmission {
  const reasons: string[] = [];
  const contentType = parseContentType(rawContentType);

  if (contentType === null) {
    reasons.push(
      `content_type is missing or not one of ${CONTENT_TYPES.join(", ")} (received ${JSON.stringify(rawContentType)})`,
    );
  } else if (!isPublishableType(contentType)) {
    reasons.push(`content_type is "${contentType}", which is not publishable as an article`);
  }

  const shape = judgeShape(rawText);
  if (shape.looksLikeListing) {
    reasons.push(shape.reason!);
  }

  return { admit: reasons.length === 0, contentType, reasons };
}
