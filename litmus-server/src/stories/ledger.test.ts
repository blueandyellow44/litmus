import { describe, expect, it } from "vitest";
import { storyMemberKind } from "./ledger.js";
import type { StoryArticle } from "./retrieval.js";

function article(over: Partial<StoryArticle> = {}): StoryArticle {
  return {
    id: 1,
    title: "Test",
    url: "https://example.test/1",
    outletKey: "example",
    outletName: "Example",
    sourceLean: "center",
    publishedAt: new Date(),
    fetchedAt: new Date(),
    extractionStatus: "full",
    wordCount: 500,
    syndicatedOfArticleId: null,
    articleSummary: null,
    reactingTo: null,
    section: null,
    ...over,
  };
}

describe("storyMemberKind", () => {
  it("keeps unread and sub-floor coverage hollow", () => {
    expect(storyMemberKind(article({ extractionStatus: "failed", wordCount: 0 }))).toBe("headline_only");
    expect(storyMemberKind(article({ extractionStatus: "partial", wordCount: 199 }))).toBe("headline_only");
    expect(storyMemberKind(article({ extractionStatus: "partial", wordCount: 200 }))).toBe("full");
  });

  it("lets a syndication pointer win over body state", () => {
    expect(storyMemberKind(article({ syndicatedOfArticleId: 9, wordCount: 0, extractionStatus: "failed" }))).toBe(
      "syndicated",
    );
  });
});
