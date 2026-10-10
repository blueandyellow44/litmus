import { describe, expect, it } from "vitest";
import { PH_BANDS } from "./phBand.ts";
import { stripFraction, stripGeometry, stripSegments } from "./stripGeometry.ts";

describe("stripFraction", () => {
  it("maps the fixed scale to 0..1 and clamps outside it", () => {
    expect(stripFraction(1)).toBe(0);
    expect(stripFraction(5)).toBe(1);
    expect(stripFraction(3)).toBe(0.5);
    expect(stripFraction(0)).toBe(0);
    expect(stripFraction(9)).toBe(1);
  });
});

describe("stripSegments", () => {
  it("tiles the whole scale, gapless, in band order", () => {
    const segs = stripSegments();
    expect(segs.map((s) => s.band.label)).toEqual(PH_BANDS.map((b) => b.label));
    expect(segs[0]?.from).toBe(0);
    expect(segs[segs.length - 1]?.to).toBe(1);
    for (let i = 1; i < segs.length; i++) expect(segs[i]?.from).toBe(segs[i - 1]?.to);
  });
  it("splits at the selection boundary the badge uses, so 1.45 is in the same band on both", () => {
    const segs = stripSegments();
    const practical = segs[0]!;
    expect(stripFraction(1.45)).toBeLessThan(practical.to);
    expect(stripFraction(1.5)).toBe(practical.to);
  });
});

describe("stripGeometry", () => {
  it("draws one tick per scored member and a bracket from min to max, written as number and word", () => {
    const g = stripGeometry([2.4, 1.5, null, NaN, "3", 2]);
    expect(g.ticks).toHaveLength(3);
    expect(g.ticks.map((t) => t.band.label)).toEqual(["Grounded", "Grounded", "Grounded"]);
    expect(g.bracket).toEqual({ from: stripFraction(1.5), to: stripFraction(2.4), min: 1.5, max: 2.4 });
    expect(g.rangeText).toBe("1.5 Grounded to 2.4 Grounded");
  });
  it("has no bracket and says so when nothing is scored", () => {
    const g = stripGeometry([null, undefined, 0, 6]);
    expect(g.ticks).toHaveLength(0);
    expect(g.bracket).toBeNull();
    expect(g.rangeText).toBe("Not yet scored");
  });
  it("collapses a single score to a point", () => {
    const g = stripGeometry([4.7]);
    expect(g.bracket?.from).toBe(g.bracket?.to);
    expect(g.rangeText).toBe("4.7 Hyperbolic");
  });
});
