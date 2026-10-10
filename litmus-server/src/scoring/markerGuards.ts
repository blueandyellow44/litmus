import { nonStaffSpeechSpans } from "./speakerTurns.js";

// Guards shared by both marker passes (phScorer's whole-article pass and
// markExcerpt's passage pass).
//
// They live here rather than in either pass because each pass needs both, and
// importing one from the other creates a cycle. They are also exactly the kind
// of rule the file-level warning on quotedSpans is about: two implementations of
// "is this span quoted" would silo different text in each scope, so there is one
// implementation and both callers use it.

// True when `text` appears at least once in `haystack` starting OUTSIDE quoted
// speech.
//
// The naive form — indexOf(text), then test that one position — silos on the
// first occurrence, which is not necessarily the occurrence the model meant. A
// phrase used both in the reporter's narration and inside a quotation was
// therefore adjudicated on whichever came first in the text: a narration
// instance got dropped because an earlier quoted one existed, and a quoted
// instance got published because an earlier narration one did. Walking every
// occurrence resolves it in the direction the instrument already argues for —
// the markers describe the OUTLET's words, so if the outlet used the phrase in
// its own voice anywhere, that is the instance being marked. Only when every
// occurrence sits inside a quote is the span genuinely quoted speech.
export function occursOutsideQuotes(
  haystack: string,
  text: string,
  startsInQuote: (i: number) => boolean,
): boolean {
  let at = haystack.indexOf(text);
  if (at === -1) return false; // not a verbatim substring; discarded as before
  while (at !== -1) {
    if (!startsInQuote(at)) return true;
    at = haystack.indexOf(text, at + 1);
  }
  return false;
}

// Extraction chrome: text that survives into the body from the page AROUND the
// article. It is not the reporter's prose, so it cannot carry the outlet's
// framing, and marking it paints a highlight over furniture. Both observed in
// the live corpus: "Unlimited Cashback Match" (card advertising inside a CNN
// piece) tagged loaded_terms, and Axios's standing "Why it matters:" label
// tagged structural_manipulation.
//
// Deliberately narrow, and anchored so it matches a standing label on its own
// rather than a sentence containing those words. A false negative here costs a
// single highlight; a false positive would silently delete a real mark.
// Standing section labels. A model will mark the label ALONE, and it will also
// mark a span that opens with the label and runs on into the sentence after it —
// observed live as `"Why it matters: Controversial vaccine policy changes appear
// to be roaring back ahead of the midterms."`, which an exact-match list let
// straight through. So each label is matched two ways: on its own (with or
// without the colon), or as a colon-terminated prefix of a longer span.
//
// The colon is what makes the prefix form safe. "Why it matters to the families
// involved is still unclear" is ordinary prose that happens to begin with those
// words, carries no colon, and must survive — dropping it would delete a real
// mark, which is the expensive direction of this trade.
const SECTION_LABELS = [
  "why it matters",
  "the big picture",
  "go deeper",
  "the bottom line",
  "between the lines",
  "catch up quick",
  "by the numbers",
  "driving the news",
  "what's next",
  "yes, but",
];

// Boilerplate that is never article prose, matched from the start of the span.
const BOILERPLATE: RegExp[] = [
  /^read more\b/i,
  /^sign up\b/i,
  /^subscribe\b/i,
  /^advertisement$/i,
  /^unlimited cashback match$/i,
  /^photo(graph)? (by|credit)\b/i,
  /^getty images$/i,
  /^copyright\b/i,
  /^all rights reserved\b/i,
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LABEL_PATTERNS: RegExp[] = SECTION_LABELS.flatMap((label) => [
  new RegExp(`^${escapeRe(label)}:?$`, "i"), // the label on its own
  new RegExp(`^${escapeRe(label)}:`, "i"),   // the label introducing a longer span
]);

export function isPageFurniture(text: string): boolean {
  const t = text.trim();
  return LABEL_PATTERNS.some((re) => re.test(t)) || BOILERPLATE.some((re) => re.test(t));
}

// Speech by someone other than the outlet's host and reporters in a broadcast
// transcript, where there are no quotation marks to silo on (speakerTurns.ts).
// Applied to the FINAL marker set, after both passes merge, because the
// excerpt pass sees only a passage and cannot tell whose turn it is in.
export function dropNonStaffSpeech<M extends { text: string }>(markers: M[], rawText: string): M[] {
  const spans = nonStaffSpeechSpans(rawText);
  if (spans.length === 0) return markers;
  const inSpeech = (i: number) => spans.some(([a, b]) => i >= a && i < b);
  return markers.filter((m) => occursOutsideQuotes(rawText, m.text, inSpeech));
}

// A loaded mark too weak to paint. Loaded wording is drawn as a warm highlight
// and can be quoted as a story's MOST HYSTERICAL line, so a mark the scorer
// itself rated 1 of 5 ("barely veers") claims far more than the scorer did.
// Observed live 2026-10-02: PBS's plain "But" (language_intensity, 1) was
// painted as loaded wording. A lone function word is never loaded wording on
// its own, whatever intensity it was given.
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "so", "yet", "for", "if", "then", "though", "although",
  "however", "still", "also", "even", "just", "only", "now", "as", "at", "by", "in", "of", "on", "to",
  "with", "from", "that", "this", "these", "those", "it", "its", "he", "she", "they", "we", "is", "was",
]);
const LOADED_CATEGORIES = new Set([
  "emotional_language", "loaded_terms", "headline_framing", "language_intensity",
  "logical_fallacy", "structural_manipulation", "speculation",
]);
export const MIN_LOADED_INTENSITY = 2;

export function isTooWeakToMark(m: { text: string; category: string; intensity: number }): boolean {
  const words = m.text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s'’-]/gu, "").split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.every((w) => FUNCTION_WORDS.has(w))) return true;
  return LOADED_CATEGORIES.has(m.category) && m.intensity < MIN_LOADED_INTENSITY;
}

// The marker's reason, when the model gave a usable one. Spread into the
// marker so an absent reason leaves no key at all rather than an empty string.
const MAX_WHY_CHARS = 140;
export function markerWhy(raw: unknown): { why?: string } {
  if (typeof raw !== "string") return {};
  const why = raw.replace(/\s+/g, " ").trim();
  if (why.length === 0) return {};
  return { why: why.length > MAX_WHY_CHARS ? `${why.slice(0, MAX_WHY_CHARS - 1).trimEnd()}…` : why };
}
