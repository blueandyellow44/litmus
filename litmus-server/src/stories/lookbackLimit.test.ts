import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { resolveStoryLookbackDays, StoryLookbackError, DEFAULT_DAYS, MAX_LOOKBACK_DAYS } from "./lookbackLimit.js";

// The dangerous direction is upward: a large window means a large unbounded
// backlog of real model calls with no cost watchdog on this path (2026-09-21 -
// the first production run silently ran candidate retrieval past a 25-minute
// timeout at the old hardcoded 14-day default). Unlike resolveScoreLimit,
// falling back to the CEILING when unset would reproduce that exact bug, so
// the unset case must default to DEFAULT_DAYS, never MAX_LOOKBACK_DAYS.
describe("resolveStoryLookbackDays boundaries", () => {
  it("falls back to the safe default when unset or empty, NOT the ceiling", () => {
    expect(resolveStoryLookbackDays(undefined)).toBe(DEFAULT_DAYS);
    expect(resolveStoryLookbackDays("")).toBe(DEFAULT_DAYS);
    expect(resolveStoryLookbackDays("   ")).toBe(DEFAULT_DAYS);
    expect(DEFAULT_DAYS).toBeLessThan(MAX_LOOKBACK_DAYS);
  });

  it("REFUSES a value above the ceiling instead of honouring it", () => {
    expect(() => resolveStoryLookbackDays("15")).toThrow(StoryLookbackError);
    expect(() => resolveStoryLookbackDays("15")).toThrow(/exceeds MAX_LOOKBACK_DAYS=14/);
    expect(() => resolveStoryLookbackDays("400")).toThrow(/can only/);
  });

  it("accepts exactly the ceiling", () => {
    expect(resolveStoryLookbackDays("14")).toBe(14);
  });

  it("REFUSES zero", () => {
    expect(() => resolveStoryLookbackDays("0")).toThrow(/at least 1/);
  });

  it("REFUSES a fraction rather than rounding it", () => {
    expect(() => resolveStoryLookbackDays("2.5")).toThrow(/positive whole number/);
  });

  it("REFUSES a negative", () => {
    expect(() => resolveStoryLookbackDays("-5")).toThrow(/positive whole number/);
  });

  it("REFUSES values that Number() would quietly accept", () => {
    expect(() => resolveStoryLookbackDays("1e3")).toThrow();
    expect(() => resolveStoryLookbackDays("0x10")).toThrow();
    expect(() => resolveStoryLookbackDays("5abc")).toThrow();
  });

  it("accepts a value below the ceiling", () => {
    expect(resolveStoryLookbackDays("1")).toBe(1);
    expect(resolveStoryLookbackDays(" 3 ")).toBe(3);
  });
});

// The 09-21 fix narrowed one window and left the same "14 days" in four other
// places (2026-09-22). Any literal day window in the ledger's own source has
// to come from resolveStoryLookbackDays instead; this fails if one comes back.
describe("no hard-coded story window", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    ...readdirSync(here)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "lookbackLimit.ts")
      .map((name) => path.join(here, name)),
    path.join(here, "..", "workers", "storyCron.ts"),
  ];
  const WINDOW_LITERAL = /INTERVAL\s+'\d+\s+days?'|make_interval\(days\s*=>\s*\d+\)|days\s*=\s*\d+\b|(?:listOpenStoryCards|listUnassignedStoryArticles|loadCriticStories)\([^)]*\b\d+\b/;

  it("finds the ledger's source files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${path.basename(file)} takes its window from the lookback, not a literal`, () => {
      const offending = readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => !line.startsWith("//") && WINDOW_LITERAL.test(line));
      expect(offending).toEqual([]);
    });
  }
});
