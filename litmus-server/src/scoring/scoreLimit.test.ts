import { describe, it, expect } from "vitest";
import { resolveScoreLimit, ScoreLimitError } from "./scoreLimit.js";

const MAX = 40;

// The dangerous direction is upward: this reads from the environment and spends
// money, so the boundary that matters most is the one at and above MAX.
describe("resolveScoreLimit boundaries", () => {
  it("REFUSES a value above the ceiling instead of honouring it", () => {
    expect(() => resolveScoreLimit("41", MAX)).toThrow(ScoreLimitError);
    expect(() => resolveScoreLimit("41", MAX)).toThrow(/exceeds MAX_PER_CYCLE=40/);
    expect(() => resolveScoreLimit("400", MAX)).toThrow(/can only/);
  });

  it("accepts exactly the ceiling", () => {
    expect(resolveScoreLimit("40", MAX)).toBe(40);
  });

  it("REFUSES zero, which would score nothing while looking deliberate", () => {
    expect(() => resolveScoreLimit("0", MAX)).toThrow(/at least 1/);
  });

  it("REFUSES a fraction rather than rounding it", () => {
    expect(() => resolveScoreLimit("2.5", MAX)).toThrow(/positive whole number/);
    expect(() => resolveScoreLimit("0.5", MAX)).toThrow(/positive whole number/);
  });

  it("REFUSES a negative", () => {
    expect(() => resolveScoreLimit("-5", MAX)).toThrow(/positive whole number/);
  });

  it("REFUSES values that Number() would quietly accept", () => {
    // Number("1e3") is 1000 and Number("0x10") is 16 — both would raise spend
    // through a variable that looks like a typo.
    expect(() => resolveScoreLimit("1e3", MAX)).toThrow();
    expect(() => resolveScoreLimit("0x10", MAX)).toThrow();
    expect(() => resolveScoreLimit("5abc", MAX)).toThrow();
    expect(() => resolveScoreLimit("abc", MAX)).toThrow();
  });

  it("accepts a value below the ceiling", () => {
    expect(resolveScoreLimit("1", MAX)).toBe(1);
    expect(resolveScoreLimit("5", MAX)).toBe(5);
    expect(resolveScoreLimit(" 5 ", MAX)).toBe(5);
  });

  it("falls back to the ceiling when unset or empty", () => {
    expect(resolveScoreLimit(undefined, MAX)).toBe(MAX);
    expect(resolveScoreLimit("", MAX)).toBe(MAX);
    expect(resolveScoreLimit("   ", MAX)).toBe(MAX);
  });
});
