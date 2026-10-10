// The two honesty helpers around the featured pair.
//
// Neither of them SELECTS anything. The pair's axis is P/H temperature and
// political lean plays no part in choosing it — Max's ruling, 2026-09-02,
// docs/decisions/002-featured-pair-axis.md, locked. `pickContrast.test.ts`
// holds that. What these do is describe the pair the temperature axis produced,
// so a caption cannot imply a breadth the selection never claimed.

import { describe, expect, it } from "vitest";
import { breadthNote, noPairReason, pairBreadthState, spansBothWings, storyBreadth, wingOf } from "./StorySpread.tsx";
import type { SectionArticleDTO } from "../lib/types.ts";

let nextId = 1;
function article(over: Partial<SectionArticleDTO> = {}): SectionArticleDTO {
  const id = nextId++;
  return {
    id,
    sourceId: id,
    sourceName: `Source ${id}`,
    sourceLean: "center",
    url: `https://example.test/${id}`,
    title: `Headline ${id}`,
    author: null,
    publishedAt: "2026-09-04T12:00:00Z",
    politicalLean: 0,
    composite: 2.0,
    label: "Grounded",
    articleSummary: "",
    rationale: null,
    excerpt: { paragraphs: ["a paragraph"], markers: [] },
    ...over,
  };
}

describe("spansBothWings", () => {
  it.each([
    ["left", "right", true],
    ["right", "left", true],
    ["center-left", "center-right", true],
    ["left", "center-right", true],
    ["left", "center-left", false],
    ["right", "center-right", false],
    ["center", "center", false],
    ["left", "center", false],
    ["center", "right", false],
  ])("%s beside %s spans both wings: %s", (left, right, expected) => {
    expect(
      spansBothWings({
        left: article({ sourceLean: left as SectionArticleDTO["sourceLean"] }),
        right: article({ sourceLean: right as SectionArticleDTO["sourceLean"] }),
      }),
    ).toBe(expected);
  });

  it("treats an unrated baseline as neither wing rather than throwing", () => {
    expect(
      spansBothWings({
        left: article({ sourceLean: "nonsense" as SectionArticleDTO["sourceLean"] }),
        right: article({ sourceLean: "right" }),
      }),
    ).toBe(false);
  });
});

describe("noPairReason", () => {
  it("names an unscored story", () => {
    expect(noPairReason([article({ composite: null }), article({ composite: null })])).toMatch(
      /has been scored and excerpted/,
    );
  });

  it("names an excerpt-less story, which is unusable for the same reason", () => {
    expect(noPairReason([article({ excerpt: null }), article({ excerpt: { paragraphs: [], markers: [] } })])).toMatch(
      /scored and excerpted/,
    );
  });

  it("names a single available telling", () => {
    expect(noPairReason([article(), article({ composite: null })])).toMatch(/Only one outlet/);
  });

  it("names the outlet when every telling comes from one source", () => {
    // This is the case `pickContrast` returns null for: the widest temperature
    // gap on the story is one outlet against itself, which is not a comparison.
    const reason = noPairReason([
      article({ sourceId: 7, sourceName: "The Daily Example", composite: 1.2 }),
      article({ sourceId: 7, sourceName: "The Daily Example", composite: 4.1 }),
    ]);
    expect(reason).toContain("The Daily Example");
    expect(reason).toMatch(/against itself/);
  });

  it("handles an empty story", () => {
    expect(noPairReason([])).toMatch(/scored and excerpted/);
  });
});

describe("storyBreadth measures the COMPLETE article set", () => {
  it("counts distinct sources per wing, not articles", () => {
    const b = storyBreadth([
      article({ sourceId: 1, sourceName: "The Nation", sourceLean: "left" }),
      article({ sourceId: 1, sourceName: "The Nation", sourceLean: "left" }),
      article({ sourceId: 2, sourceName: "Fox News", sourceLean: "right" }),
    ]);
    expect(b.left).toEqual(["The Nation"]);
    expect(b.right).toEqual(["Fox News"]);
    expect(b.bilateral).toBe(true);
  });

  it("includes articles that could never be featured", () => {
    // An unscored, un-excerpted right-leaning piece still means a right-leaning
    // outlet covered the story. Telling the reader otherwise would be false.
    const b = storyBreadth([
      article({ sourceLean: "left" }),
      article({ sourceLean: "right", composite: null, excerpt: null }),
    ]);
    expect(b.bilateral).toBe(true);
  });

  it("treats centre as neither wing", () => {
    const b = storyBreadth([article({ sourceLean: "center" }), article({ sourceLean: "center" })]);
    expect(b.bilateral).toBe(false);
    expect(b.center).toHaveLength(2);
  });
});

describe("pairBreadthState separates the pair from the story", () => {
  const L = () => article({ sourceId: 1, sourceName: "The Nation", sourceLean: "left" });
  const R = () => article({ sourceId: 2, sourceName: "The Federalist", sourceLean: "right" });
  const C = () => article({ sourceId: 3, sourceName: "Reuters", sourceLean: "center" });
  const C2 = () => article({ sourceId: 4, sourceName: "BBC News", sourceLean: "center" });

  it("says nothing when the featured pair already spans both wings", () => {
    const left = L();
    const right = R();
    const s = pairBreadthState({ left, right }, [left, right, C()]);
    expect(s.kind).toBe("pair-bilateral");
    expect(breadthNote(s)).toBeNull();
  });

  it("does NOT call it a coverage gap when the story is bilateral and only the pair is not", () => {
    // The defect this fixes. Two centrist tellings happened to be the calmest
    // and the hottest; The Nation and The Federalist both covered the story and
    // are sitting in the coverage list. Calling that a coverage gap is a false
    // claim about the edition.
    const left = C();
    const right = C2();
    const s = pairBreadthState({ left, right }, [left, right, L(), R()]);
    expect(s.kind).toBe("pair-not-bilateral");
    const note = breadthNote(s)!;
    expect(note).not.toContain("Coverage gap");
    expect(note).toContain("do not span");
    expect(note).toContain("coverage list below");
  });

  it("names the wing that is missing from the pair and where to find it", () => {
    const left = C();
    const right = R();
    const s = pairBreadthState({ left, right }, [left, right, L()]);
    expect(s.kind).toBe("pair-not-bilateral");
    expect(breadthNote(s)).toContain("Left-leaning");
    expect(breadthNote(s)).toContain("The Nation");
  });

  it("calls it a coverage gap only when the story genuinely lacks a wing", () => {
    const left = R();
    const right = article({ sourceId: 5, sourceName: "New York Post", sourceLean: "right" });
    const s = pairBreadthState({ left, right }, [left, right, C()]);
    expect(s.kind).toBe("story-one-sided");
    const note = breadthNote(s)!;
    expect(note).toContain("Coverage gap");
    expect(note).toContain("left-leaning");
  });

  it("never calls a centre-plus-wing pair 'the same side'", () => {
    // A centrist outlet has not been shown to agree with a right-leaning one,
    // and the baselines do not support saying so.
    const left = C();
    const right = R();
    for (const others of [[], [L()]]) {
      const s = pairBreadthState({ left, right }, [left, right, ...others]);
      const note = breadthNote(s);
      if (note) expect(note.toLowerCase()).not.toContain("same side");
    }
  });

  it("handles a story where every outlet is centrist", () => {
    const left = C();
    const right = C2();
    const s = pairBreadthState({ left, right }, [left, right]);
    expect(s.kind).toBe("story-one-sided");
    const note = breadthNote(s)!;
    expect(note).toContain("left-leaning and right-leaning");
  });

  it("counts one outlet publishing twice as one outlet", () => {
    // A duplicate-source story must not read as broader than it is.
    const a = article({ sourceId: 7, sourceName: "Axios", sourceLean: "center-left" });
    const b = article({ sourceId: 7, sourceName: "Axios", sourceLean: "center-left" });
    const breadth = storyBreadth([a, b]);
    expect(breadth.left).toEqual(["Axios"]);
    expect(breadth.bilateral).toBe(false);
  });

  it("treats an unrecognised baseline as centre rather than throwing", () => {
    expect(wingOf("nonsense" as never)).toBe("C");
    expect(storyBreadth([article({ sourceLean: "nonsense" as never })]).bilateral).toBe(false);
  });
});
