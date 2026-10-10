// Pure helpers for P/H phrase highlighting, kept out of the React component so
// the matching and the encoding are unit-testable.
//
// Encoding (Quiet Reader, design/rebrand-2026-09-13/quiet-reader/brand.md
// section 4): two states, not a colour ramp.
//   loaded   : warm tint fill plus a warm underline (.hl-loaded in tokens.css)
//   grounded : a cool underline and no fill (.hl-grounded); hedging shares it
// The retired encoding painted loaded red and grounded green and darkened the
// fill with intensity. Red against green is the pair colour-blind readers lose
// first, and five alpha steps were not distinguishable as five things. Intensity
// is still carried on the mark's title for anyone who wants it.

import type { MarkerCategory } from "./types.ts";
import { quotedSpans } from "./loadedLexicon.ts";

// Structural, so a published story excerpt (whose category is a plain string in
// the contract) and an article PHMarker both fit.
export interface HighlightMarker {
  text: string;
  category: string;
  intensity?: number;
}

export type HighlightKind = "loaded" | "grounded";

const GROUNDED_CATEGORIES: ReadonlySet<string> = new Set<MarkerCategory>(["grounded", "hedging"]);
const LOADED_CATEGORIES: ReadonlySet<string> = new Set<MarkerCategory>([
  "emotional_language",
  "loaded_terms",
  "headline_framing",
  "language_intensity",
  "logical_fallacy",
  "structural_manipulation",
  "speculation",
]);

// The kind a category is drawn as, or null for a category this client does not
// know. Unknown is not "loaded" and not "grounded": painting a mark the scorer
// never asserted would put a claim on the page. The phrase renders as plain text.
export function highlightKind(category: string): HighlightKind | null {
  if (GROUNDED_CATEGORIES.has(category)) return "grounded";
  if (LOADED_CATEGORIES.has(category)) return "loaded";
  return null;
}

// Class names defined in src/styles/tokens.css.
export const HIGHLIGHT_CLASS: Readonly<Record<HighlightKind, string>> = {
  loaded: "hl-loaded",
  grounded: "hl-grounded",
};

// The words the key uses for each kind. One place, so every key on every page
// names the marks the same way.
export const HIGHLIGHT_KEY_LABEL: Readonly<Record<HighlightKind, string>> = {
  loaded: "loaded wording",
  grounded: "grounded wording",
};

export function highlightTitle(marker: HighlightMarker): string {
  const kind = highlightKind(marker.category);
  const category = marker.category.replace(/_/g, " ");
  const intensity = typeof marker.intensity === "number" ? ` · intensity ${marker.intensity}` : "";
  const prefix = kind === "loaded" ? "Loaded wording" : kind === "grounded" ? "Grounded wording" : "Marked";
  return `${prefix}: ${category}${intensity}`;
}

export interface HighlightRange<M extends HighlightMarker = HighlightMarker> {
  start: number;
  end: number;
  marker: M;
}

// Non-overlapping highlight ranges for `text`. Each marker is matched as a
// VERBATIM substring (first occurrence); non-matches are dropped. On overlap,
// the earliest, and on a tie the longest, span wins, so a phrase beats a word
// nested inside it.
export function computeHighlightRanges<M extends HighlightMarker>(text: string, markers: readonly M[]): HighlightRange<M>[] {
  // Hard silo: a span inside a named speaker's quotation is the speaker's voice,
  // not the outlet's. Drop ANY highlight that starts inside a quote, so quoted
  // speech is never marked.
  const quotes = quotedSpans(text);
  const inQuote = (i: number) => quotes.some(([a, b]) => i >= a && i < b);

  // Highlights come ONLY from the context-aware model markers. A regex word list
  // cannot tell "lies" (deceit) from "lies" (is located), or catch loaded
  // FRAMING like "held particular contempt".
  const found: HighlightRange<M>[] = [];
  for (const marker of markers) {
    if (!marker.text) continue;
    const start = text.indexOf(marker.text);
    if (start === -1 || inQuote(start)) continue;
    found.push({ start, end: start + marker.text.length, marker });
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);

  const out: HighlightRange<M>[] = [];
  let cursor = 0;
  for (const r of found) {
    if (r.start < cursor) continue;
    out.push(r);
    cursor = r.end;
  }
  return out;
}
