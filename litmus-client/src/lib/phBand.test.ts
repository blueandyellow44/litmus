// The client's band table: gapless, monotone, and legible.

import { describe, expect, it } from "vitest";
import {
  CONTRAST_GROUNDS,
  MARK_STROKE_ALPHA,
  MARK_STROKE_INK,
  PH_BANDS,
  bandForComposite,
  bandForScore,
  colorForComposite,
  labelForComposite,
  labelIsCurrent,
  bandWord,
  isValidComposite,
  UNRATED_HEX,
  UNRATED_LABEL,
} from "./phBand.ts";
import { AA_NON_TEXT, AA_NORMAL_TEXT, composite, contrastRatio, relativeLuminance } from "./contrast.ts";
import { PALETTE } from "./palette.ts";

const HUNDREDTHS = Array.from({ length: 401 }, (_, i) => Math.round((1.0 + i * 0.01) * 100) / 100);

describe("the client band table", () => {
  it("meets its own cuts: each band's cut is the next band's published minimum", () => {
    for (let i = 0; i < PH_BANDS.length - 1; i++) {
      expect(PH_BANDS[i]!.below, PH_BANDS[i]!.label).toBe(PH_BANDS[i + 1]!.min);
    }
    expect(PH_BANDS.at(-1)!.below).toBe(Infinity);
  });

  it("covers every hundredth exactly once", () => {
    for (const v of HUNDREDTHS) {
      expect(PH_BANDS.filter((b) => v >= b.min && v < b.below), `composite ${v}`).toHaveLength(1);
    }
  });

  it("is monotone", () => {
    for (let i = 1; i < HUNDREDTHS.length; i++) {
      const prev = PH_BANDS.findIndex((b) => b.label === bandForComposite(HUNDREDTHS[i - 1]!)!.label);
      const cur = PH_BANDS.findIndex((b) => b.label === bandForComposite(HUNDREDTHS[i]!)!.label);
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });

  it("puts the old gap values in the lower band rather than nowhere", () => {
    expect(labelForComposite(1.45)).toBe("Proportionate");
    expect(labelForComposite(2.45)).toBe("Grounded");
    expect(labelForComposite(3.45)).toBe("Mixed Signals");
    expect(labelForComposite(4.45)).toBe("Running Hot");
  });

  it("does not throw on a non-finite composite in a render path", () => {
    // The server throws, because that is where the number is produced. Here a
    // throw would take a page down over one bad row.
    expect(() => bandForComposite(NaN)).not.toThrow();
  });

  it("gives colorForComposite and bandForComposite the same hex", () => {
    for (const v of HUNDREDTHS) {
      expect(colorForComposite(v)).toBe(bandForComposite(v)!.hex);
    }
  });
});

describe("the temperature ramp", () => {
  // Ratios computed from the hexes and rounded to two places. They are written
  // out so a palette edit shows up as a named, reviewable number change rather
  // than a silent shift, and so the design document's table can be checked
  // against the code rather than trusted.
  const MEASURED: Record<string, { luminance: number; ground: number; surface: number }> = {
    Proportionate: { luminance: 0.5744, ground: 1.48, surface: 1.6 },
    Grounded: { luminance: 0.4229, ground: 1.95, surface: 2.11 },
    "Mixed Signals": { luminance: 0.2956, ground: 2.67, surface: 2.89 },
    "Running Hot": { luminance: 0.1858, ground: 3.91, surface: 4.23 },
    Hyperbolic: { luminance: 0.1115, ground: 5.71, surface: 6.18 },
  };

  it.each(PH_BANDS.map((b) => [b.label, b.hex] as const))("%s measures what the table says", (label, hex) => {
    const m = MEASURED[label]!;
    expect(relativeLuminance(hex)).toBeCloseTo(m.luminance, 4);
    expect(contrastRatio(hex, CONTRAST_GROUNDS.ground)).toBeCloseTo(m.ground, 2);
    expect(contrastRatio(hex, CONTRAST_GROUNDS.surface)).toBeCloseTo(m.surface, 2);
  });

  it("is ordered by lightness, calm lightest, so the order survives without hue", () => {
    for (let i = 1; i < PH_BANDS.length; i++) {
      expect(
        relativeLuminance(PH_BANDS[i]!.hex),
        `${PH_BANDS[i]!.label} must be darker than ${PH_BANDS[i - 1]!.label}`,
      ).toBeLessThan(relativeLuminance(PH_BANDS[i - 1]!.hex));
    }
  });

  it("keeps every step separable from its neighbours by lightness alone", () => {
    // Measured minimum is 1.32:1 (Proportionate to Grounded).
    const MIN_NEIGHBOUR_RATIO = 1.3;
    for (let i = 0; i < PH_BANDS.length - 1; i++) {
      expect(
        contrastRatio(PH_BANDS[i]!.hex, PH_BANDS[i + 1]!.hex),
        `${PH_BANDS[i]!.label} vs ${PH_BANDS[i + 1]!.label}`,
      ).toBeGreaterThanOrEqual(MIN_NEIGHBOUR_RATIO);
    }
  });

  it("gives every mark an edge that clears 3:1 non-text contrast on both grounds", () => {
    // The pale fills cannot carry their own boundary (Proportionate is 1.48:1 on the
    // ground), so the stroke does. Measured: 3.61:1 on ground, 3.70:1 on surface.
    const onGround = composite(MARK_STROKE_INK, MARK_STROKE_ALPHA, CONTRAST_GROUNDS.ground);
    const onSurface = composite(MARK_STROKE_INK, MARK_STROKE_ALPHA, CONTRAST_GROUNDS.surface);
    expect(contrastRatio(onGround, CONTRAST_GROUNDS.ground)).toBeCloseTo(3.61, 2);
    expect(contrastRatio(onSurface, CONTRAST_GROUNDS.surface)).toBeCloseTo(3.7, 2);
    expect(contrastRatio(onGround, CONTRAST_GROUNDS.ground)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrastRatio(onSurface, CONTRAST_GROUNDS.surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it("shows why the stroke is .55 and not .50: .50 barely clears on the ground", () => {
    const half = composite(MARK_STROKE_INK, 0.5, CONTRAST_GROUNDS.ground);
    expect(contrastRatio(half, CONTRAST_GROUNDS.ground)).toBeCloseTo(3.11, 2);
  });

  it("cannot carry text: neither white nor ink reads on every step, so text is never set on it", () => {
    // White on the ramp: 1.68, 2.22, 3.04, 4.45, 6.50. Ink on the ramp: 9.80,
    // 7.42, 5.42, 3.70, 2.53. Each fails somewhere, which is the reason the
    // badge is a swatch beside ink text rather than text on a coloured pill.
    const whiteFails = PH_BANDS.filter((b) => contrastRatio("#ffffff", b.hex) < AA_NORMAL_TEXT).map((b) => b.label);
    const inkFails = PH_BANDS.filter((b) => contrastRatio(PALETTE.ink, b.hex) < AA_NORMAL_TEXT).map((b) => b.label);
    expect(whiteFails).toEqual(["Proportionate", "Grounded", "Mixed Signals", "Running Hot"]);
    expect(inkFails).toEqual(["Running Hot", "Hyperbolic"]);
  });

  it("proves the broadsheet palette was not ordered by lightness, so the ordering test measures something", () => {
    // Watched to fail: the retired hexes, Proportionate to Hyperbolic.
    const OLD = ["#166534", "#55701a", "#854d0e", "#b23c0b", "#b91c1c"];
    const decreasing = OLD.every((hex, i) => i === 0 || relativeLuminance(hex) < relativeLuminance(OLD[i - 1]!));
    expect(decreasing).toBe(false);
    // Its calmest step was its darkest.
    expect(relativeLuminance(OLD[0]!)).toBeLessThan(relativeLuminance(OLD[4]!));
  });

  it("keeps the unrated neutral legible as text and outside the ramp", () => {
    expect(UNRATED_HEX).toBe(PALETTE.ink3);
    expect(contrastRatio(UNRATED_HEX, CONTRAST_GROUNDS.ground)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe("a stored label never overrides its own number", () => {
  it("renders the band the composite computes, not the label the row carries", () => {
    // The failure this prevents: a row written before a band boundary moved
    // renders the stale word next to the current number in the current colour.
    expect(bandForScore({ composite: 2.0, label: "Hyperbolic" })!.label).toBe("Grounded");
  });

  it("reports whether a stored label has gone stale", () => {
    expect(labelIsCurrent({ composite: 2.0, label: "Grounded" })).toBe(true);
    expect(labelIsCurrent({ composite: 2.0, label: "Hyperbolic" })).toBe(false);
    expect(labelIsCurrent({ composite: 2.0, label: null })).toBe(true);
  });
});

describe("a composite that is not a composite", () => {
  // The regression this pins: bandForComposite used to return PH_BANDS[0] for a
  // non-finite value. Corrupt data came out labelled "Proportionate", in green, with
  // a number the reader could not see was NaN — the calmest, most reassuring
  // verdict on the scale, produced by an absence of data.
  const INVALID = [
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["null", null],
    ["undefined", undefined],
    ["a numeric string", "2.4"],
    ["a non-numeric string", "Grounded"],
    ["an object", {}],
    ["an array", [2.4]],
    ["a boolean", true],
    ["below the scale", 0.4],
    ["above the scale", 7.2],
    ["far above the scale", 1e9],
    ["far below the scale", -1e9],
  ] as const;

  it.each(INVALID)("refuses %s rather than calling it a band", (_label, v) => {
    expect(bandForComposite(v)).toBeNull();
    expect(labelForComposite(v)).toBeNull();
  });

  it.each(INVALID)("gives %s the neutral colour, not a band colour", (_label, v) => {
    expect(colorForComposite(v)).toBe(UNRATED_HEX);
    expect(PH_BANDS.map((b) => b.hex)).not.toContain(colorForComposite(v));
  });

  it.each(INVALID)("says 'Not rated' for %s rather than borrowing a band's word", (_label, v) => {
    expect(bandWord(v)).toBe(UNRATED_LABEL);
  });

  it("proves the old fall-through called NaN Proportionate", () => {
    // Watched to fail. The old body, verbatim.
    const OLD = (composite: number) => {
      if (!Number.isFinite(composite)) return PH_BANDS[0]!;
      const clamped = Math.max(1.0, Math.min(5.0, composite));
      for (const b of PH_BANDS) if (clamped < b.below) return b;
      return PH_BANDS[PH_BANDS.length - 1]!;
    };
    // Every non-finite value hit the early return, so Infinity — the most
    // extreme possible input — also came out Proportionate. Only the out-of-range
    // FINITE values were clamped, and those landed on a real band too.
    expect(OLD(NaN).label).toBe("Proportionate");
    expect(OLD(Infinity).label).toBe("Proportionate");
    expect(OLD(-Infinity).label).toBe("Proportionate");
    expect(OLD(-1e9).label).toBe("Proportionate");
    expect(OLD(7.2).label).toBe("Hyperbolic");
  });

  it("accepts the ends of the scale exactly", () => {
    expect(isValidComposite(1)).toBe(true);
    expect(isValidComposite(5)).toBe(true);
    expect(isValidComposite(0.999999)).toBe(false);
    expect(isValidComposite(5.000001)).toBe(false);
  });

  it("never treats a stored label as current when the number is unusable", () => {
    // A row whose composite is corrupt cannot have a "correct" label: there is
    // nothing for the label to agree with.
    expect(labelIsCurrent({ composite: NaN, label: "Proportionate" })).toBe(false);
    expect(labelIsCurrent({ composite: "2.0", label: "Grounded" })).toBe(false);
    expect(bandForScore({ composite: NaN, label: "Grounded" })).toBeNull();
  });
});
