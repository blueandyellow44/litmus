// The front page scroll: one repeated item per story. Pure helpers only, so the
// selection rules are unit-testable (lib/wire.test.ts).
//
// Why this shape (Max's ruling, 2026-09-13, after an audit of the spread layout
// and a research pass): products that read as one flow repeat one unit with the
// same grammar, and put the verdict next to the evidence for it. Each item here
// is the score, one plain framing line, and ONE quoted line from the outlet with
// its highlight, then the link out. Depth (the Map, every telling side by side)
// stays one click away on the story and article pages.
//
// Every item must carry a quote or say plainly that it has none. When only some
// items are annotated, readers take the bare ones as vetted (the implied truth
// effect, Pennycook et al. 2020), which would be a false claim about the paper.

import type {
  ArticleExcerptDTO,
  ArticleSummaryDTO,
  ClusterArticleDTO,
  ClusterDTO,
  DimensionRationale,
  PHMarker,
} from "./types.ts";
import { computeHighlightRanges } from "./highlight.ts";
import { PH_BANDS, bandForComposite } from "./phBand.ts";

const GREEN = new Set(["grounded", "hedging"]);
export const isLoadedMarker = (m: PHMarker) => !GREEN.has(m.category);

// A quoted line longer than this is trimmed around its highlight. The quote is
// evidence for the score, not a second excerpt.
export const QUOTE_MAX_WORDS = 45;
export const FRAMING_MAX_WORDS = 40;

const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// Sentence spans as [start, end) offsets. Offsets, never split-and-rejoin, so the
// quoted text stays byte-identical to what the outlet published and markers
// still match it. The boundary rule matches the server's excerpt cap, plus an
// abbreviation guard: the cap only cuts BETWEEN units, so splitting "U.S." there
// costs nothing, but a quote is a single unit and must not open on "Senate".
const ABBREVIATION = /(?:\b(?:[A-Z]\.){1,3}|\b(?:Mr|Mrs|Ms|Dr|St|Sen|Rep|Gov|Gen|Jr|Sr|Lt|Col|Sgt|No|vs|Inc|Corp|Ltd|Co|a\.m|p\.m)\.)$/;

export function sentenceSpans(p: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /[.!?]+["'”’)\]]*\s+(?=["'“‘(\[]?[A-Z0-9])/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p)) !== null) {
    if (ABBREVIATION.test(p.slice(start, m.index + m[0].trimEnd().length))) continue;
    spans.push([start, m.index + m[0].trimEnd().length]);
    start = m.index + m[0].length;
  }
  if (start < p.length) spans.push([start, p.length]);
  return spans.filter(([a, b]) => p.slice(a, b).trim().length > 0);
}

export interface WireQuote {
  text: string;
  markers: PHMarker[];
  tone: "loaded" | "grounded";
}

// The line that best shows how the piece was told: the sentence holding the
// most intense LOADED highlight in the outlet's own voice; if the piece has
// none, its most intense GROUNDED one. Highlights inside a named speaker's
// quotation never count (computeHighlightRanges drops them), because a quote
// is the speaker's voice, not the outlet's.
export function pickQuote(excerpt: ArticleExcerptDTO | null | undefined): WireQuote | null {
  if (!excerpt || excerpt.paragraphs.length === 0) return null;
  let best: { para: string; start: number; marker: PHMarker; loaded: boolean } | null = null;
  for (const raw of excerpt.paragraphs) {
    const para = raw.replace(/^…/, "").replace(/…$/, "");
    for (const r of computeHighlightRanges(para, excerpt.markers)) {
      const loaded = isLoadedMarker(r.marker);
      const better =
        !best ||
        (loaded && !best.loaded) ||
        (loaded === best.loaded && r.marker.intensity > best.marker.intensity);
      if (better) best = { para, start: r.start, marker: r.marker, loaded };
    }
  }
  if (!best) return null;

  const span = sentenceSpans(best.para).find(([a, b]) => best!.start >= a && best!.start < b);
  if (!span) return null;
  let text = best.para.slice(span[0], span[1]).trim();
  if (countWords(text) > QUOTE_MAX_WORDS) text = trimAround(text, best.marker.text, QUOTE_MAX_WORDS);
  return {
    text,
    markers: excerpt.markers.filter((m) => m.text && text.includes(m.text)),
    tone: best.loaded ? "loaded" : "grounded",
  };
}

// Keep a window of whole words around the highlighted phrase, with ellipses
// where it cuts. The phrase itself is never split.
function trimAround(text: string, phrase: string, maxWords: number): string {
  const at = text.indexOf(phrase);
  const words = text.split(/\s+/);
  if (at < 0) return `${words.slice(0, maxWords).join(" ")}…`;
  const before = countWords(text.slice(0, at));
  const phraseWords = countWords(phrase);
  const pad = Math.max(0, Math.floor((maxWords - phraseWords) / 2));
  const from = Math.max(0, Math.min(before - pad, words.length - maxWords));
  const to = Math.min(words.length, from + maxWords);
  return `${from > 0 ? "…" : ""}${words.slice(from, to).join(" ")}${to < words.length ? "…" : ""}`;
}

// Words that show a sentence is about HOW the piece was told rather than what
// happened. The scorer's summary line sometimes just restates the story, and a
// restatement in the framing slot reads as a second headline.
const CRAFT = /\b(language|framing|framed|frames|tone|sourc|attribut|neutral|loaded|emotional|headline|lede|hyperbol|fallac|restrained|measured|alarm|sensational|wire-service|opinion|column|verb|adjective|caveat|hedg|balanced|one-sided|speculat|catastroph|inflammatory|editorializ|contempt|reporting|narration|plain)/i;

function firstSentence(s: string | undefined | null): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  const span = sentenceSpans(t)[0];
  return span ? t.slice(span[0], span[1]).trim() : t;
}

function capWords(s: string, max: number): string {
  const words = s.split(/\s+/);
  return words.length <= max ? s : `${words.slice(0, max).join(" ")}…`;
}

// One plain sentence on how the piece was told. Prefer the scorer's summary when
// it talks about the telling; otherwise its note on the language; otherwise the
// summary as it stands.
export function framingLine(rationale: DimensionRationale | null | undefined): string | null {
  if (!rationale) return null;
  const summary = firstSentence(rationale.summary);
  const language = firstSentence(rationale.language);
  const pick = CRAFT.test(summary) ? summary : language || summary;
  return pick ? capWords(pick, FRAMING_MAX_WORDS) : null;
}

export interface WireSingle {
  kind: "single";
  article: ArticleSummaryDTO;
}

export interface WireStory {
  kind: "story";
  cluster: ClusterDTO;
  // The telling shown in full: the hottest member that has a quote.
  lead: ArticleSummaryDTO;
  // Everyone else who covered it, hottest first.
  others: Array<{ id: number; sourceName: string; composite: number | null }>;
}

export type WireItem = WireSingle | WireStory;

const compositeOf = (a: { score: { composite: number } | null }) =>
  typeof a.score?.composite === "number" && Number.isFinite(a.score.composite) ? a.score.composite : null;

// Multi-outlet stories first (widest P/H gap first, since that gap is what the
// paper exists to show), then every remaining article in edition order, which
// the server already sorts newest first. An article appears once.
export function buildWire(
  articles: ArticleSummaryDTO[],
  clusters: ClusterDTO[],
  membersByCluster: Record<number, ClusterArticleDTO[]>,
): WireItem[] {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const used = new Set<number>();
  const stories: WireStory[] = [];

  for (const cluster of clusters) {
    const members = membersByCluster[cluster.id] ?? [];
    const inFeed = members.map((m) => byId.get(m.id)).filter((a): a is ArticleSummaryDTO => !!a);
    if (members.length < 2 || inFeed.length === 0) continue;
    const ranked = [...inFeed].sort((a, b) => (compositeOf(b) ?? -1) - (compositeOf(a) ?? -1));
    const lead = ranked.find((a) => pickQuote(a.excerpt)) ?? ranked[0]!;
    const others = members
      .filter((m) => m.id !== lead.id)
      .map((m) => ({ id: m.id, sourceName: m.sourceName, composite: compositeOf(m) }))
      .sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
    for (const m of members) used.add(m.id);
    stories.push({ kind: "story", cluster, lead, others });
  }

  const spread = (s: WireStory) => (s.cluster.phMax ?? 0) - (s.cluster.phMin ?? 0);
  stories.sort((a, b) => spread(b) - spread(a));

  const singles: WireSingle[] = articles.filter((a) => !used.has(a.id)).map((article) => ({ kind: "single", article }));
  return [...stories, ...singles];
}

export interface EditionStats {
  total: number;
  stories: number;
  // Every band in scale order, including empty ones, so the bar keeps its shape.
  byBand: Array<{ label: string; hex: string; count: number }>;
  unrated: number;
  // Sections in descending size.
  bySection: Array<{ section: string; count: number }>;
}

// The desktop version's edition summary. Counts the whole edition, not the
// items currently shown, so the numbers do not change as the reader scrolls.
export function editionStats(articles: ArticleSummaryDTO[], items: WireItem[]): EditionStats {
  const byBand = PH_BANDS.map((b) => ({ label: b.label, hex: b.hex, count: 0 }));
  let unrated = 0;
  const sections = new Map<string, number>();
  for (const a of articles) {
    const band = bandForComposite(a.score?.composite);
    const slot = band ? byBand.find((b) => b.label === band.label) : undefined;
    if (slot) slot.count++;
    else unrated++;
    const section = a.score?.section;
    if (section) sections.set(section, (sections.get(section) ?? 0) + 1);
  }
  return {
    total: articles.length,
    stories: items.filter((i) => i.kind === "story").length,
    byBand,
    unrated,
    bySection: [...sections.entries()].map(([section, count]) => ({ section, count })).sort((x, y) => y.count - x.count),
  };
}
