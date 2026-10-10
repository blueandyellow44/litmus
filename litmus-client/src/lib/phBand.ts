// The one place the client turns a composite into a band, a colour, and a word.
//
// There were four. PHBadge kept a label -> Tailwind class map, TheMap kept a
// composite -> hex ladder, ClusterCard kept its own labelForComposite, and
// StorySpread's consensus strip kept a fourth cascade for its own wording. Each
// was written from the same table and each could drift from it independently,
// so the same score could arrive on one surface as a word, on another as a
// colour, and on a third as a number, with nothing holding the three together.
// The audit found exactly that shape of bug elsewhere in the app and it is only
// luck it had not landed here yet.
//
// This file mirrors litmus-server/src/scoring/calibration.ts. There is no shared
// package by design (docs/architecture.md decision #1), so the two copies are
// held together by `scripts/check-band-parity.ts`, which reads both files and
// fails when a number moves in one and not the other.

import type { Label } from "./types.ts";

export interface ClientBand {
  // The PUBLISHED boundaries, as the About page states them. Both inclusive.
  min: number;
  max: number;
  // The boundary the CODE selects on: this band holds every v where
  // v < below. Infinity on the top band. See the server's note — reading the
  // published boundaries literally leaves 1.45 in no band at all.
  below: number;
  label: Label;
  // Hex, not a Tailwind class: SVG fills cannot resolve a class from arbitrary
  // data, and the two representations must be the same colour.
  hex: string;
  // The Tailwind background class for a swatch filled with this band.
  bg: string;
}

// The Quiet Reader temperature ramp (design/rebrand-2026-09-13/quiet-reader/
// brand.md section 2), replacing the broadsheet green-to-red set on 2026-09-13.
//
// Two things changed, and the second is the one that matters:
//
// 1. The ramp is ordered by LIGHTNESS. Each step is about 8 OKLCH lightness
//    points darker than the one before, so the order survives red-green colour
//    blindness and greyscale. The old palette was not: its darkest step was
//    Practical, so a greyscale reader saw the calmest band as the heaviest.
//    phBand.test.ts computes the luminance of each step and fails if the order
//    breaks.
// 2. Ramp colour only ever FILLS A MARK (a dot, a swatch). It never colours text
//    and text is never set on it. The two pale steps sit at 1.48:1 and 1.95:1
//    against the ground, far too light to read as text, and white on them is
//    worse. So the contrast that matters is the text beside the mark (ink on the
//    ground) and the mark's own edge, which is why every mark carries
//    MARK_STROKE. The number and the band word always travel with the colour.
//
// Hexes from the OKLCH sources: oklch(0.83 0.012 235), oklch(0.75 0.045 95),
// oklch(0.67 0.115 72), oklch(0.585 0.15 48), oklch(0.50 0.165 33).
export const PH_BANDS: readonly ClientBand[] = [
  { min: 1.0, max: 1.4, below: 1.5,      label: "Proportionate",     hex: "#C0C9CE", bg: "bg-ph-practical" },
  { min: 1.5, max: 2.4, below: 2.5,      label: "Grounded",      hex: "#B7AE8E", bg: "bg-ph-grounded" },
  { min: 2.5, max: 3.4, below: 3.5,      label: "Mixed Signals", hex: "#C1893C", bg: "bg-ph-mixed" },
  { min: 3.5, max: 4.4, below: 4.5,      label: "Running Hot",   hex: "#C05A16", bg: "bg-ph-hot" },
  { min: 4.5, max: 5.0, below: Infinity, label: "Hyperbolic",    hex: "#AD3118", bg: "bg-ph-hysterical" },
] as const;

// The grounds a ramp mark is placed on anywhere in the app. Both are checked by
// the contrast test; adding a third ground means adding it here.
export const CONTRAST_GROUNDS = { ground: "#F1F0ED", surface: "#FAF9F7" } as const;

// The edge every ramp mark carries: ink at this alpha. It is what keeps the two
// pale steps visible on the light ground and gives the mark a boundary above the
// 3:1 non-text threshold. The design allows .50 to .55; .55 is used because .50
// clears the threshold by only 0.11 on the ground.
export const MARK_STROKE_INK = "#1E1F22";
export const MARK_STROKE_ALPHA = 0.55;
export const MARK_STROKE = `rgba(30, 31, 34, ${MARK_STROKE_ALPHA})`;

// Neutral for a score that cannot be believed. Deliberately not one of the five
// ramp colours: an invalid composite has no temperature, and painting it calm or
// hot would be the same lie in a different direction.
export const UNRATED_HEX = "#63646A"; // the `ink3` token
export const UNRATED_LABEL = "Not rated";

// A composite is only a composite if it is a finite number inside the published
// scale. The server computes it, clamps it to [1.0, 5.0] and rounds it, so
// anything outside that arriving on the client is corrupt data, not a hot score.
export function isValidComposite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 5;
}

// Gapless across the whole scale, and NULL for anything that is not a composite.
//
// This used to return `PH_BANDS[0]` — Practical — for a non-finite value, on the
// reasoning that a render path must not throw. The reasoning was right and the
// answer was wrong: it took corrupt data and printed the calmest, most reassuring
// verdict on the scale beside it, in green, with a number the reader could not
// see was NaN. A page that renders "Practical" for a score that does not exist is
// worse than a page that renders nothing, because the reader cannot tell.
// Returning null makes every call site decide, and the compiler names them.
export function bandForComposite(composite: unknown): ClientBand | null {
  if (!isValidComposite(composite)) return null;
  for (const b of PH_BANDS) {
    if (composite < b.below) return b;
  }
  return PH_BANDS[PH_BANDS.length - 1]!;
}

// The colour for a composite, including the neutral one for an invalid score.
// Safe to use directly in a `fill` or a `style`, which is why it returns a hex
// rather than a nullable band.
export function colorForComposite(composite: unknown): string {
  return bandForComposite(composite)?.hex ?? UNRATED_HEX;
}

export function labelForComposite(composite: unknown): Label | null {
  return bandForComposite(composite)?.label ?? null;
}

// The word to show for a composite: the band, or an explicit "Not rated".
export function bandWord(composite: unknown): string {
  return bandForComposite(composite)?.label ?? UNRATED_LABEL;
}

// The band to DISPLAY for a stored score.
//
// A row carries both a number and a label, written at different times by
// different code paths. When they disagree the number is authoritative: it is
// what the composite arithmetic produced, it is what the colour and the position
// on The Map are derived from, and a label contradicting it would put a word on
// screen that the dot beside it denies. Recomputing here is what makes a stale
// label impossible to render. A row whose NUMBER is unusable renders as unrated
// regardless of how confident its stored label sounds.
export function bandForScore(score: { composite: unknown; label?: string | null }): ClientBand | null {
  return bandForComposite(score.composite);
}

// Whether a stored label still matches its own number. Not used to decide what
// to render — `bandForScore` already settled that — but available to a check
// that wants to count how often the stored labels have gone stale. An invalid
// composite can never make a label current: there is nothing to agree with.
export function labelIsCurrent(score: { composite: unknown; label?: string | null }): boolean {
  const band = bandForComposite(score.composite);
  if (!band) return false;
  return !score.label || score.label === band.label;
}
