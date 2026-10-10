// Dimension parsing. The defect pinned here: a missing, null, string, NaN or
// Infinity dimension silently became 3.0 — the most plausible-looking number on
// the scale, invented, and then weighted into a published composite and shown
// to a reader as part of a term-by-term breakdown.

import { describe, expect, it } from "vitest";
import { parseDim, parseDimensions } from "./phScorer.js";

// The pre-fix implementation, verbatim, so the counterfactual is faithful.
function clampDim_OLD(n: unknown): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 3.0;
  return Math.max(1.0, Math.min(5.0, Math.round(n * 10) / 10));
}

const MALFORMED: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["a numeric string", "3.4"],
  ["a non-numeric string", "high"],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["an object", { value: 3 }],
  ["an array", [3]],
  ["a boolean", true],
];

describe("parseDim", () => {
  it.each(MALFORMED)("refuses %s rather than inventing a score", (_label, value) => {
    expect(parseDim(value)).toBeNull();
  });

  it("proves the old behaviour: every one of those produced a publishable number", () => {
    // Watched to fail. The point is not that they all became 3.0 — it is that
    // none of them was ever refused. Every malformed input left the old parser
    // as a real point on the 1-5 scale, indistinguishable downstream from a
    // judgement the model actually made.
    for (const [label, value] of MALFORMED) {
      const old = clampDim_OLD(value);
      expect(Number.isFinite(old), `old clampDim(${label}) = ${old}`).toBe(true);
      expect(old, `old clampDim(${label})`).toBeGreaterThanOrEqual(1);
      expect(old, `old clampDim(${label})`).toBeLessThanOrEqual(5);
    }
    // The three shapes, each fabricating a different verdict:
    expect(clampDim_OLD(undefined)).toBe(3.0); // a plausible middle
    expect(clampDim_OLD(Infinity)).toBe(5.0); // a fabricated Hysterical
    expect(clampDim_OLD(-Infinity)).toBe(1.0); // a fabricated Practical
  });

  it("accepts a well-formed score and rounds it to one decimal", () => {
    expect(parseDim(2.34)).toBe(2.3);
    expect(parseDim(2.35)).toBe(2.4);
    expect(parseDim(1)).toBe(1);
    expect(parseDim(5)).toBe(5);
  });

  it("clamps an out-of-range NUMBER rather than rejecting it", () => {
    // A model overshooting a scale it was told the ends of has an unambiguous
    // intent. NaN does not, which is why the two are handled differently.
    expect(parseDim(5.4)).toBe(5);
    expect(parseDim(0.2)).toBe(1);
    expect(parseDim(-40)).toBe(1);
  });
});

describe("parseDimensions", () => {
  const good = { headline: 2, language: 2.2, sourcing: 1.5, fallacies: 1, structure: 3 };

  it("returns all five when all five parse", () => {
    const r = parseDimensions(good);
    expect(r).toEqual({ dimensions: { headline: 2, language: 2.2, sourcing: 1.5, fallacies: 1, structure: 3 } });
  });

  it("names the one that did not parse", () => {
    const r = parseDimensions({ ...good, sourcing: null });
    expect(r).toEqual({ missing: ["sourcing"] });
  });

  it("names every one that did not parse, not just the first", () => {
    const r = parseDimensions({ headline: 2, language: NaN, sourcing: "x", fallacies: 1, structure: undefined });
    expect(r).toEqual({ missing: ["language", "sourcing", "structure"] });
  });

  it("rejects an entirely empty object", () => {
    const r = parseDimensions({});
    expect(r).toEqual({ missing: ["headline", "language", "sourcing", "fallacies", "structure"] });
  });

  it("ignores extra keys", () => {
    const r = parseDimensions({ ...good, composite: 9, band: "Hysterical" });
    expect("dimensions" in r).toBe(true);
  });
});
