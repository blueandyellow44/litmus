import { describe, expect, it } from "vitest";
import type { StoryModelClient } from "./assignment.js";
import {
  anchorArticleId,
  mergeCandidatePairs,
  needsSplitReview,
  reviewMerge,
  reviewSplit,
  type CriticStory,
} from "./critic.js";
import type { StoryCard } from "./retrieval.js";

function card(id: string, headline = "White House announces policy", hour = 0): StoryCard {
  return {
    id,
    headline,
    eventStatement: `${headline} at one event.`,
    section: "politics",
    firstSeenAt: new Date(Date.UTC(2026, 8, 13, hour)),
    updatedAt: new Date(Date.UTC(2026, 8, 13, hour)),
    memberHeadlines: [],
    memberArticleIds: [],
    outletKeys: [],
  };
}

function criticStory(
  members: CriticStory["primaryMembers"],
  anchorArticleId: number | null = members[0]?.articleId ?? null,
): CriticStory {
  return { card: card("st_a"), primaryMembers: members, anchorArticleId };
}

function member(articleId: number, over: Partial<CriticStory["primaryMembers"][number]> = {}) {
  return {
    articleId,
    title: `Article ${articleId}`,
    publishedAt: new Date(Date.UTC(2026, 8, 13, articleId)),
    confidence: "high" as const,
    gainedThisRun: true,
    ...over,
  };
}

function fake(name: string, input: unknown, stopReason: string = "tool_use"): StoryModelClient {
  return {
    messages: {
      create: async () => ({
        stop_reason: stopReason,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", name, input }],
      }),
    },
  };
}

describe("critic selection", () => {
  it("covers every split trigger and skips unchanged stories", () => {
    expect(needsSplitReview(criticStory([member(1, { gainedThisRun: false }), member(2, { gainedThisRun: false })]))).toBe(false);
    expect(needsSplitReview(criticStory([member(1), member(2), member(3)]))).toBe(true);
    expect(needsSplitReview(criticStory([member(1, { confidence: "medium" })]))).toBe(true);
    expect(needsSplitReview(criticStory([
      member(1, { publishedAt: new Date("2026-09-11T00:00:00Z") }),
      member(2, { publishedAt: new Date("2026-09-13T00:00:01Z") }),
    ]))).toBe(true);
  });

  it("uses the earliest dated primary as the stable anchor", () => {
    expect(anchorArticleId(criticStory([member(5), member(2), member(1, { publishedAt: null })], null))).toBe(2);
  });

  it("keeps a stored anchor even when a newer primary joined", () => {
    expect(
      anchorArticleId(criticStory([
        member(10),
        member(2),
        member(1),
        member(9, { publishedAt: new Date("2020-01-01T00:00:00Z") }),
      ], 9))
    ).toBe(9);
  });

  it("only proposes pairs within 48h that share two whole names", () => {
    const a = card("a", "Dario Amodei announces policy", 0);
    const b = card("b", "Dario Amodei responds", 47);
    const late = card("late", "Dario Amodei responds", 100);
    const other = card("other", "Markets close higher", 1);
    expect(mergeCandidatePairs([a, b, late, other]).map((pair) => [pair.left.id, pair.right.id])).toEqual([["a", "b"]]);
    // One shared name is no longer enough (2026-09-22): "Trump" alone paired
    // most of a day's political stories.
    expect(mergeCandidatePairs([
      card("full", "Donald Trump speaks", 0),
      card("short", "Trump responds", 1),
    ])).toHaveLength(0);
  });

  it("does not count title-case headline words as names", () => {
    expect(mergeCandidatePairs([
      card("x", "How The Senate Will Vote", 0),
      card("y", "How The Markets Will React", 1),
    ])).toHaveLength(0);
  });

  it("ranks pairs by shared names, strongest first", () => {
    const pairs = mergeCandidatePairs([
      card("p", "Supreme Court Justice Kagan dissents", 0),
      card("q", "Supreme Court Justice Kagan writes", 1),
      card("r", "Supreme Court ruling lands", 2),
    ]);
    expect(pairs.map((pair) => pair.sharedNames)).toEqual([...pairs.map((pair) => pair.sharedNames)].sort((x, y) => y - x));
    expect([pairs[0]!.left.id, pairs[0]!.right.id]).toEqual(["p", "q"]);
  });
});

describe("critic model validation", () => {
  it("accepts a complete split partition whose anchor group keeps the id", async () => {
    const story: CriticStory = {
      ...criticStory([member(1), member(2), member(3)]),
      anchorArticleId: null,
    };
    const result = await reviewSplit(story, {
      client: fake("submit_split_review", {
        groups: [
          { headline: "First", event_statement: "First act.", article_ids: [1, 2] },
          { headline: "Second", event_statement: "Second act.", article_ids: [3] },
        ],
        reason: "Two acts.",
      }),
    });
    expect(result.valid).toBe(true);
    expect(result.anchorArticleId).toBe(1);
  });

  it("rejects missing, duplicated, or foreign member ids", async () => {
    const story = criticStory([member(1), member(2), member(3)]);
    for (const articleIds of [[1, 2], [1, 2, 2], [1, 2, 99]]) {
      const result = await reviewSplit(story, {
        client: fake("submit_split_review", {
          groups: [{ headline: "Bad", event_statement: "Bad partition.", article_ids: articleIds }],
          reason: "Bad.",
        }),
      });
      expect(result.valid).toBe(false);
    }
  });

  it("treats anything but an explicit yes as no mutation authority", async () => {
    const left = card("a");
    const right = card("b");
    const malformed = await reviewMerge(left, right, { client: fake("submit_merge_review", { decision: "maybe", reason: "Unsure." }) });
    expect(malformed.decision).toBe("unsure");
    const yes = await reviewMerge(left, right, { client: fake("submit_merge_review", { decision: "yes", reason: "Same event." }) });
    expect(yes.decision).toBe("yes");
  });

  it("treats a non-tool-use merge stop as unsure", async () => {
    const left = card("a");
    const right = card("b");
    const result = await reviewMerge(left, right, {
      client: fake("submit_merge_review", { decision: "yes", reason: "Too much." }, "max_tokens"),
    });
    expect(result.decision).toBe("unsure");
  });

  it("flags truncated split results as invalid", async () => {
    const story = criticStory([member(1), member(2)]);
    const result = await reviewSplit(story, {
      client: fake("submit_split_review", {
        groups: [{ headline: "x", event_statement: "y", article_ids: [1, 2] }],
        reason: "Truncated.",
      }, "max_tokens"),
    });
    expect(result.valid).toBe(false);
  });
});
