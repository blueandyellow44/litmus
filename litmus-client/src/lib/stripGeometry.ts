// Geometry for the temperature strip (graft 1 from the Signal Strip direction,
// docs/plans/story-first-build-2026-09-13.md): a thin bar of the five ramp
// steps with one tick per scored member and a bracket from the story's calmest
// telling to its hottest. Pure, so the layout is unit-tested without an SVG.
//
// Positions are fractions of the strip's length, 0 at P/H 1.0 and 1 at 5.0.
// The scale is fixed and never zoomed to the data: a story whose tellings all
// sit at 2.0 shows a short bracket near the cool end, which is the finding.

import { PH_BANDS, isValidComposite, type ClientBand } from "./phBand.ts";
import { phRangeText } from "./storyModel.ts";

export const PH_SCALE_MIN = 1;
export const PH_SCALE_MAX = 5;
const PH_SCALE_SPAN = PH_SCALE_MAX - PH_SCALE_MIN;

export function stripFraction(composite: number): number {
  const clamped = Math.min(PH_SCALE_MAX, Math.max(PH_SCALE_MIN, composite));
  return (clamped - PH_SCALE_MIN) / PH_SCALE_SPAN;
}

export interface StripSegment {
  band: ClientBand;
  from: number; // fraction
  to: number; // fraction
}

export interface StripTick {
  composite: number;
  fraction: number;
  band: ClientBand;
}

export interface StripBracket {
  from: number;
  to: number;
  min: number;
  max: number;
}

export interface StripGeometry {
  segments: StripSegment[];
  ticks: StripTick[];
  bracket: StripBracket | null;
  // "1.5 Grounded to 2.4 Grounded": number and band word, never colour alone.
  rangeText: string;
}

// The five segments follow the band table's selection boundary (`below`), so a
// composite of 1.45 lands in the same segment the badge beside it names. They
// are gapless and tile the whole scale.
export function stripSegments(): StripSegment[] {
  return PH_BANDS.map((band) => ({
    band,
    from: stripFraction(band.min),
    to: stripFraction(Number.isFinite(band.below) ? band.below : PH_SCALE_MAX),
  }));
}

export function stripGeometry(composites: readonly unknown[]): StripGeometry {
  const scored = composites.filter(isValidComposite);
  const ticks: StripTick[] = scored.map((c) => {
    const band = PH_BANDS.find((b) => c < b.below) ?? PH_BANDS[PH_BANDS.length - 1]!;
    return { composite: c, fraction: stripFraction(c), band };
  });
  let bracket: StripBracket | null = null;
  if (scored.length > 0) {
    const min = Math.min(...scored);
    const max = Math.max(...scored);
    bracket = { from: stripFraction(min), to: stripFraction(max), min, max };
  }
  return {
    segments: stripSegments(),
    ticks,
    bracket,
    rangeText: phRangeText(bracket?.min ?? null, bracket?.max ?? null),
  };
}
