import { describe, expect, it } from "vitest";
import { ABOUT_SECTIONS, aboutBandRows } from "./aboutContent.ts";

describe("aboutBandRows", () => {
  it("states the same five ranges and descriptions the page published before the band table was derived", () => {
    // The literal strings the hardcoded About page carried. If a boundary moves
    // in lib/phBand.ts this fails, which is the point: the published copy
    // changes on purpose, not as a side effect.
    expect(aboutBandRows().map((r) => `${r.range} ${r.label}. ${r.description}`)).toEqual([
      "1.0 – 1.4 Proportionate. Wire-service-style. Tells you what happened.",
      "1.5 – 2.4 Grounded. Mostly factual with some editorial voice.",
      "2.5 – 3.4 Mixed Signals. Information mixed with framing.",
      "3.5 – 4.4 Running Hot. Loaded language, one-sided sourcing, structural manipulation.",
      "4.5 – 5.0 Hyperbolic. Catastrophizing, fallacies, designed to make you feel before it tells you anything.",
    ]);
  });

  it("gives every row a description and a colour", () => {
    for (const r of aboutBandRows()) {
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("ABOUT_SECTIONS", () => {
  it("has unique anchor ids, since both versions jump to them", () => {
    const ids = ABOUT_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
