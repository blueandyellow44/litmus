import { describe, expect, it } from "vitest";
import { toHeat } from "./stories.js";
import { firstSentence } from "../stories/assessment.js";

const excerpt = { paragraphs: ["Sen. Smith said the U.S. vote was a rout. Critics disagreed."], markers: [] };
const row = {
  composite: 3.5,
  breakdown: { effectiveDimensions: { headline: 4, language: 2, sourcing: 2, fallacies: 1, structure: 3 }, raised: ["loaded headline together with an emotional lede"] },
  flags: { loadedHeadline: true, emotionalLede: true, oneSidedSourcing: false, fallacyCount: 0 },
  rationale_json: { summary: "s", headline: "The headline calls it a rout." },
  raw_text: "Sen. Smith said the U.S. vote was a rout. Critics disagreed.\n\nMore followed.",
};

describe("toHeat: what set the number, from the score's own record", () => {
  it("names the driver, the flags, the floors, the driver's note and the lede when the lede is in the excerpt", () => {
    expect(toHeat(row, excerpt)).toEqual({
      driver: "headline",
      dimensions: { headline: 4, language: 2, sourcing: 2, fallacies: 1, structure: 3 },
      loadedHeadline: true, emotionalLede: true, oneSidedSourcing: false, fallacyCount: 0,
      floors: ["loaded headline together with an emotional lede"],
      note: "The headline calls it a rout.",
      lede: "Sen. Smith said the U.S. vote was a rout.",
    });
  });
  it("withholds the lede when the first paragraph is not in the published excerpt", () => {
    expect(toHeat(row, { paragraphs: ["More followed."], markers: [] })!.lede).toBeNull();
    expect(toHeat(row, null)!.lede).toBeNull();
  });
  it("is null when unscored, or when the stored breakdown has no dimensions", () => {
    expect(toHeat({ ...row, composite: null }, excerpt)).toBeNull();
    expect(toHeat({ ...row, breakdown: {} }, excerpt)).toBeNull();
    expect(toHeat({ ...row, breakdown: null }, excerpt)).toBeNull();
    expect(toHeat({ ...row, breakdown: { effectiveDimensions: { headline: 4 } } }, excerpt)).toBeNull();
  });
  it("tolerates missing flags and notes, and a malformed raised list", () => {
    const h = toHeat({ ...row, flags: null, rationale_json: null, breakdown: { ...row.breakdown, raised: "no" } }, excerpt)!;
    expect(h.loadedHeadline).toBe(false);
    expect(h.fallacyCount).toBe(0);
    expect(h.floors).toEqual([]);
    expect(h.note).toBeNull();
  });
});

describe("firstSentence", () => {
  it("stops at the first terminator followed by a capital, past abbreviations", () => {
    expect(firstSentence("Sen. Smith said the U.S. vote was a rout. Critics disagreed.")).toBe("Sen. Smith said the U.S. vote was a rout.");
    expect(firstSentence("Is it over? Nobody knows.")).toBe("Is it over?");
    expect(firstSentence("“It is over,” he said. Then he left.")).toBe("“It is over,” he said.");
  });
  it("returns the whole paragraph when there is no break", () => {
    expect(firstSentence("  A single line with no end  ")).toBe("A single line with no end");
  });
});
