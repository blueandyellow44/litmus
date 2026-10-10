import { describe, expect, it } from "vitest";
import type { ArticleDetailDTO, ScoreDTO } from "../../lib/types.ts";
import { articleView, parseArticleId, readAtSourceLabel } from "./articleView.ts";

const SCORE: ScoreDTO = {
  headline: 2,
  language: 2,
  sourcing: 2,
  fallacies: 2,
  structure: 2,
  composite: 2,
  label: "Grounded",
  rationale: { headline: "", language: "", sourcing: "", fallacies: "", structure: "", summary: "Plain report." },
  markers: [],
  excerptIndices: [],
  politicalLean: 0,
  articleSummary: "A thing happened.",
  section: "World",
  modelUsed: "m",
  scoredAt: "2026-09-13T00:00:00Z",
};

function article(over: Partial<ArticleDetailDTO> = {}): ArticleDetailDTO {
  return {
    id: 1,
    sourceId: 1,
    sourceName: "Outlet",
    sourceLean: "center",
    url: "https://example.com/a",
    title: "Title",
    author: null,
    publishedAt: null,
    wordCount: 500,
    extractionStatus: "full",
    paywallFlag: false,
    fetchedAt: "2026-09-13T00:00:00Z",
    score: SCORE,
    excerpt: { paragraphs: ["One."], markers: [] },
    translation: null,
    ...over,
  };
}

describe("parseArticleId", () => {
  it("accepts a positive integer", () => expect(parseArticleId("42")).toBe(42));
  it.each([undefined, "", " ", "0", "-3", "1.5", "abc", "NaN"])("refuses %s", (raw) =>
    expect(parseArticleId(raw)).toBeNull(),
  );
});

describe("articleView", () => {
  it("passes a full scored article through", () => {
    const v = articleView(article());
    expect(v.section).toBe("World");
    expect(v.why).toBe("Plain report.");
    expect(v.facts).toBe("A thing happened.");
    expect(v.excerpt?.paragraphs).toEqual(["One."]);
    expect(v.showPaywall).toBe(false);
  });

  it("treats an excerpt with no paragraphs as the no-excerpt state", () => {
    expect(articleView(article({ excerpt: { paragraphs: [], markers: [] } })).excerpt).toBeNull();
    expect(articleView(article({ excerpt: null })).excerpt).toBeNull();
  });

  it("drops an empty facts summary and a missing section", () => {
    const v = articleView(article({ score: { ...SCORE, articleSummary: "  ", section: null } }));
    expect(v.facts).toBeNull();
    expect(v.section).toBeNull();
  });

  it("has no verdict fields without a score", () => {
    const v = articleView(article({ score: null }));
    expect(v.score).toBeNull();
    expect(v.why).toBeNull();
    expect(v.facts).toBeNull();
    expect(v.section).toBeNull();
  });

  it("shows the paywall note for a paywall or a partial or failed body", () => {
    expect(articleView(article({ paywallFlag: true })).showPaywall).toBe(true);
    expect(articleView(article({ extractionStatus: "partial" })).showPaywall).toBe(true);
    expect(articleView(article({ extractionStatus: "failed" })).showPaywall).toBe(true);
  });

  it("names the outlet in the link out", () => {
    expect(readAtSourceLabel("Reuters")).toBe("Read the full article at Reuters →");
  });
});
