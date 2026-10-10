// The About page's structure and the band table, shared by AboutDesktop.tsx and
// AboutMobile.tsx so both versions state the same sections and the same bands.
// The prose itself lives in AboutCopy.tsx (it carries inline emphasis, so it is
// JSX); this file stays pure so it can be tested without rendering.

import { PH_BANDS } from "../../lib/phBand.ts";
import type { Label } from "../../lib/types.ts";

export const ABOUT_TITLE = "About LITMUS";

// The sections in reading order. `id` is the in-page anchor both versions jump
// to; `title` is the heading AND the entry in the section index / jump menu, so
// the two can never disagree.
export interface AboutSection {
  id: string;
  title: string;
}

export const ABOUT_SECTIONS: readonly AboutSection[] = [
  { id: "readings", title: "The two readings" },
  { id: "bands", title: "The bands" },
  { id: "scored", title: "What gets scored" },
  { id: "not", title: "What it is not" },
] as const;

// What each band reads like. Keyed by Label so the compiler fails if a band is
// added, renamed, or removed in lib/phBand.ts without this page following.
const BAND_DESCRIPTIONS: Record<Label, string> = {
  Proportionate: "Wire-service-style. Tells you what happened.",
  Grounded: "Mostly factual with some editorial voice.",
  "Mixed Signals": "Information mixed with framing.",
  "Running Hot": "Loaded language, one-sided sourcing, structural manipulation.",
  Hyperbolic: "Catastrophizing, fallacies, designed to make you feel before it tells you anything.",
};

export interface AboutBandRow {
  label: Label;
  // The PUBLISHED range, e.g. "1.0 – 1.4" (en dash, as the page always wrote it).
  range: string;
  description: string;
  hex: string;
}

// The band rows, read from PH_BANDS rather than typed out a second time. This
// page used to hardcode the five ranges, which made it a fourth copy of the
// table that scripts/check-band-parity.ts does not read. Deriving them means the
// boundaries a reader is told are the boundaries the code publishes.
export function aboutBandRows(): AboutBandRow[] {
  return PH_BANDS.map((b) => ({
    label: b.label,
    range: `${b.min.toFixed(1)} – ${b.max.toFixed(1)}`,
    description: BAND_DESCRIPTIONS[b.label],
    hex: b.hex,
  }));
}
