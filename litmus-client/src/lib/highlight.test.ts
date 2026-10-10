import { describe, expect, it } from "vitest";
import { computeHighlightRanges, highlightKind, highlightTitle, HIGHLIGHT_CLASS, HIGHLIGHT_KEY_LABEL } from "./highlight.ts";
import type { MarkerCategory } from "./types.ts";
import type { StoryExcerptDTO } from "./storyTypes.ts";

// Every category the scorer emits, with the kind it must be drawn as. Written
// out rather than derived so adding a category to types.ts without deciding its
// kind fails here instead of silently drawing nothing.
const EXPECTED: Record<MarkerCategory, "loaded" | "grounded"> = {
  grounded: "grounded",
  hedging: "grounded",
  emotional_language: "loaded",
  loaded_terms: "loaded",
  headline_framing: "loaded",
  language_intensity: "loaded",
  logical_fallacy: "loaded",
  structural_manipulation: "loaded",
  speculation: "loaded",
};

describe("highlight encoding", () => {
  it.each(Object.entries(EXPECTED))("draws %s as %s", (category, kind) => {
    expect(highlightKind(category)).toBe(kind);
  });

  it("draws an unknown category as nothing, never as loaded or grounded", () => {
    expect(highlightKind("sarcasm")).toBeNull();
    expect(highlightKind("")).toBeNull();
  });

  it("has exactly two treatments, each with a class and a key label", () => {
    expect(Object.keys(HIGHLIGHT_CLASS).sort()).toEqual(["grounded", "loaded"]);
    expect(Object.keys(HIGHLIGHT_KEY_LABEL).sort()).toEqual(["grounded", "loaded"]);
    expect(HIGHLIGHT_CLASS.loaded).not.toBe(HIGHLIGHT_CLASS.grounded);
  });

  it("titles a mark with its kind, category and intensity", () => {
    expect(highlightTitle({ text: "x", category: "loaded_terms", intensity: 4 })).toBe("Loaded wording: loaded terms · intensity 4");
    expect(highlightTitle({ text: "x", category: "hedging" })).toBe("Grounded wording: hedging");
  });
});

describe("computeHighlightRanges", () => {
  it("lets a phrase beat a word nested inside it", () => {
    const text = "The senator issued a blistering attack on the bill.";
    const ranges = computeHighlightRanges(text, [
      { text: "blistering", category: "emotional_language", intensity: 3 },
      { text: "a blistering attack", category: "loaded_terms", intensity: 4 },
    ]);
    expect(ranges.map((r) => text.slice(r.start, r.end))).toEqual(["a blistering attack"]);
  });

  it("drops a marker that is not a verbatim substring", () => {
    expect(computeHighlightRanges("Plain text.", [{ text: "missing", category: "grounded", intensity: 1 }])).toEqual([]);
  });

  it("accepts a published story excerpt's markers, whose category is a plain string", () => {
    const excerpt: StoryExcerptDTO["markers"] = [{ text: "said", category: "grounded", intensity: 1 }];
    const ranges = computeHighlightRanges("The agency said so.", excerpt);
    expect(ranges).toHaveLength(1);
    expect(highlightKind(ranges[0]!.marker.category)).toBe("grounded");
  });
});
