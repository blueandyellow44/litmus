// The band table and the function that reads it.
//
// The defect this pins: BANDS listed inclusive ranges with gaps between them
// (1.0-1.4 then 1.5-2.4), and bandFor scanned for `v >= min && v <= max`. Any
// value in a gap — 1.45, 2.45, 3.45, 4.45 — matched nothing, fell out of the
// loop, and returned the LAST band. A composite one hundredth above Proportionate
// came back labelled Hyperbolic.

import { describe, expect, it } from "vitest";
import { BANDS, LABELS, bandFor, checkBandTable } from "./calibration.js";

// The old implementation, kept verbatim so the counterfactual is faithful
// rather than a description of it.
function bandFor_OLD(composite: number) {
  const clamped = Math.max(1.0, Math.min(5.0, composite));
  for (const b of BANDS) {
    if (clamped >= b.min && clamped <= b.max) return b;
  }
  return BANDS[BANDS.length - 1]!;
}

// Every one-decimal composite the production path can actually produce.
const ONE_DECIMAL = Array.from({ length: 41 }, (_, i) => Math.round((1.0 + i * 0.1) * 10) / 10);

// Every hundredth across the scale, which is what a reusable function must
// survive even though today's callers round first.
const HUNDREDTHS = Array.from({ length: 401 }, (_, i) => Math.round((1.0 + i * 0.01) * 100) / 100);

describe("the band table", () => {
  it("has no gap and no overlap between the published copy and the cuts", () => {
    expect(checkBandTable()).toEqual([]);
  });

  it("lists the five labels in scale order", () => {
    expect(BANDS.map((b) => b.label)).toEqual([...LABELS]);
  });
});

describe("bandFor", () => {
  it("agrees with the old function on every value the old one handled", () => {
    // The guarantee that matters for stored data: the `label` column was
    // written by the old function over one-decimal composites. If the new one
    // disagreed anywhere in that set, every published score would be relabelled.
    for (const v of ONE_DECIMAL) {
      expect(bandFor(v).label, `composite ${v}`).toBe(bandFor_OLD(v).label);
    }
  });

  it("covers every hundredth, including the values that used to match nothing", () => {
    for (const v of HUNDREDTHS) {
      const b = bandFor(v);
      expect(LABELS, `composite ${v}`).toContain(b.label);
    }
  });

  // A band runs from its published minimum up to the NEXT band's minimum. The
  // published maximum is simply the last tenth inside it, so a value in the old
  // gap belongs to the lower band. The alternative — round to one decimal first
  // and take the higher band — is not viable: 1.45 * 10 is 14.499999999999998
  // in IEEE 754, so Math.round would send it DOWN anyway, and the rule would
  // hold or fail per value depending on binary representation.
  it.each([
    [1.45, "Proportionate"],
    [2.45, "Grounded"],
    [3.45, "Mixed Signals"],
    [4.45, "Running Hot"],
  ])("puts %s in %s, where the old table sent it to Hyperbolic", (value, label) => {
    expect(bandFor(value).label).toBe(label);
  });

  it("is monotone: a higher composite never returns a calmer band", () => {
    for (let i = 1; i < HUNDREDTHS.length; i++) {
      const prev = LABELS.indexOf(bandFor(HUNDREDTHS[i - 1]!).label);
      const cur = LABELS.indexOf(bandFor(HUNDREDTHS[i]!).label);
      expect(cur, `composite ${HUNDREDTHS[i]}`).toBeGreaterThanOrEqual(prev);
    }
  });

  it("proves the gap was real: the old function called every gap value Hyperbolic", () => {
    // A guard nobody has watched fail is an untested claim. 4.45 is included
    // because the old function reached Hyperbolic there by falling through the
    // loop, not by matching — the same defect, invisible in the answer.
    for (const v of [1.45, 2.45, 3.45, 4.45]) {
      expect(bandFor_OLD(v).label, `old bandFor(${v})`).toBe("Hyperbolic");
    }
  });

  it("holds the published boundaries exactly", () => {
    expect(bandFor(1.0).label).toBe("Proportionate");
    expect(bandFor(1.4).label).toBe("Proportionate");
    expect(bandFor(1.5).label).toBe("Grounded");
    expect(bandFor(2.4).label).toBe("Grounded");
    expect(bandFor(2.5).label).toBe("Mixed Signals");
    expect(bandFor(3.4).label).toBe("Mixed Signals");
    expect(bandFor(3.5).label).toBe("Running Hot");
    expect(bandFor(4.4).label).toBe("Running Hot");
    expect(bandFor(4.5).label).toBe("Hyperbolic");
    expect(bandFor(5.0).label).toBe("Hyperbolic");
  });

  it("clamps outside the scale rather than falling through", () => {
    expect(bandFor(0).label).toBe("Proportionate");
    expect(bandFor(-1000).label).toBe("Proportionate");
    expect(bandFor(5.9).label).toBe("Hyperbolic");
    expect(bandFor(1e9).label).toBe("Hyperbolic");
  });

  it.each([NaN, Infinity, -Infinity])("throws on %s rather than inventing a band", (v) => {
    expect(() => bandFor(v)).toThrow(TypeError);
  });
});
