// scoreBatch end to end, against a stubbed model client.
//
// The unit tests beside this one prove each parser refuses what it should. This
// one proves the thing that actually matters to an edition: a batch containing
// one bad entry still publishes the good ones, and the bad one is left unscored
// for the next cycle rather than being published with invented parts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "./__fixtures__/nonArticleFixtures.json" with { type: "json" };
import type { Article } from "../types.js";

// The model response for the current test, set per case.
let nextInput: unknown = { scores: [] };

vi.mock("../lib/anthropic.js", () => ({
  models: { scorer: "test-model" },
  anthropic: () => ({
    messages: {
      create: async () => ({
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: "tool_use", id: "t", name: "submit_scores", input: nextInput }],
      }),
    },
  }),
}));

const { scoreBatch } = await import("./phScorer.js");

const BODY = Array.from(
  { length: 6 },
  (_, i) => `Paragraph ${i} of a perfectly ordinary wire report about something that happened today.`,
).join("\n\n");

function article(id: number, over: Partial<Article> = {}): Article {
  return {
    id,
    sourceId: id,
    url: `https://example.test/${id}`,
    title: `Headline ${id}`,
    author: null,
    publishedAt: new Date("2026-09-04T12:00:00Z"),
    rawText: BODY,
    wordCount: 400,
    extractionStatus: "full",
    paywallFlag: false,
    contentHash: `hash-${id}`,
    extractedVia: "publisher",
    syndicatedOfArticleId: null,
    fetchedAt: new Date("2026-09-04T12:30:00Z"),
    sourceRegister: null,
    ...over,
  };
}

// A complete, internally consistent entry. Calm dimensions, no flags set, and a
// declared band that agrees with what they compute to.
function goodEntry(article_id: number, over: Record<string, unknown> = {}) {
  return {
    article_id,
    content_type: "article",
    headline: 1.2,
    language: 1.3,
    sourcing: 1.4,
    fallacies: 1.1,
    structure: 1.2,
    band: "Practical",
    flags: {
      emotional_lede: false,
      loaded_headline: false,
      fallacy_count: 0,
      one_sided_sourcing: false,
      opinion_column: false,
      register: "news",
    },
    rationale: { headline: "", language: "", sourcing: "", fallacies: "", structure: "", summary: "calm" },
    markers: [],
    excerpt_paragraphs: [0],
    political_lean: 0,
    article_summary: "Something happened.",
    section: "Politics",
    ...over,
  };
}

const run = (articles: Article[], scores: unknown[]) => {
  nextInput = { scores };
  return scoreBatch(articles, { markExcerpt: false });
};

beforeEach(() => {
  nextInput = { scores: [] };
});

describe("the happy path still works", () => {
  it("publishes a clean batch", async () => {
    const arts = [article(1), article(2), article(3)];
    const out = await run(arts, arts.map((a) => goodEntry(a.id)));
    expect(out.map((s) => s.articleId)).toEqual([1, 2, 3]);
    expect(out[0]!.composite).toBeGreaterThanOrEqual(1);
    expect(out[0]!.politicalLean).toBe(0);
  });

  it("publishes an empty batch as empty rather than throwing", async () => {
    expect(await run([], [])).toEqual([]);
  });

  it("publishes a single-article batch", async () => {
    const out = await run([article(1)], [goodEntry(1)]);
    expect(out).toHaveLength(1);
  });
});

describe("one bad entry does not take the batch with it", () => {
  it.each([
    ["absent flags", { flags: undefined }],
    ["malformed flags", { flags: "none" }],
    ["a non-boolean flag", { flags: { ...goodEntry(0).flags, loaded_headline: "true" } }],
    ["an invalid register", { flags: { ...goodEntry(0).flags, register: "sport" } }],
    ["a missing political_lean", { political_lean: undefined }],
    ["a non-finite political_lean", { political_lean: NaN }],
    ["a string political_lean", { political_lean: "0" }],
    ["a missing band", { band: undefined }],
    ["an invalid band", { band: "Calm" }],
    ["a malformed dimension", { sourcing: null }],
    ["a NaN dimension", { language: NaN }],
    ["a missing content_type", { content_type: undefined }],
    ["a non-article content_type", { content_type: "listing" }],
  ])("drops the article with %s and keeps the other two", async (_label, bad) => {
    const arts = [article(1), article(2), article(3)];
    const out = await run(arts, [goodEntry(1), goodEntry(2, bad), goodEntry(3)]);
    expect(out.map((s) => s.articleId)).toEqual([1, 3]);
  });

  it("never substitutes a plausible value for the part that was missing", async () => {
    // The specific regression: an absent political_lean used to become 0, which
    // publishes as "Article framing: Center".
    const out = await run([article(1)], [goodEntry(1, { political_lean: undefined })]);
    expect(out).toHaveLength(0);
  });

  it("drops an article whose flags contradict its own dimensions", async () => {
    // one_sided_sourcing false beside a sourcing score of 3.0.
    const out = await run(
      [article(1), article(2)],
      [goodEntry(1), goodEntry(2, { sourcing: 3.0, band: "Grounded" })],
    );
    expect(out.map((s) => s.articleId)).toEqual([1]);
  });
});

describe("id reconciliation", () => {
  it("drops both copies when one article is answered twice", async () => {
    const arts = [article(1), article(2)];
    const out = await run(arts, [
      goodEntry(1, { headline: 1.1 }),
      goodEntry(1, { headline: 4.8, band: "Running Hot" }),
      goodEntry(2),
    ]);
    expect(out.map((s) => s.articleId)).toEqual([2]);
  });

  it("ignores an entry for an article it never sent", async () => {
    const out = await run([article(1)], [goodEntry(1), goodEntry(999)]);
    expect(out.map((s) => s.articleId)).toEqual([1]);
  });

  it("returns only what came back when the model skips articles", async () => {
    const out = await run([article(1), article(2), article(3)], [goodEntry(2)]);
    expect(out.map((s) => s.articleId)).toEqual([2]);
  });

  it("survives a batch that is entirely duplicates, missing and strangers", async () => {
    const out = await run(
      [article(1), article(2), article(3)],
      [goodEntry(1), goodEntry(1), goodEntry(42)],
    );
    expect(out).toEqual([]);
  });
});

describe("the non-article gate, on real published pages", () => {
  const indexPage = (id: number) =>
    article(id, { rawText: (fixtures as Record<string, { rawText: string }>)[String(id)]!.rawText });

  it.each([1440, 1441, 1442, 1444])(
    "refuses snapshot article %s even when the model calls it a scorable article",
    async (id) => {
      // This is the case that actually happened. The model filled in every field
      // and the page was published; a gate that trusted the classification alone
      // would still let it through, which is why the shape check exists.
      const out = await run([indexPage(id)], [goodEntry(id, { content_type: "article" })]);
      expect(out).toEqual([]);
    },
  );

  it("keeps a genuine short article in the same batch as an index page", async () => {
    const arts = [indexPage(1440), article(2)];
    const out = await run(arts, [
      goodEntry(1440, { content_type: "article" }),
      goodEntry(2),
    ]);
    expect(out.map((s) => s.articleId)).toEqual([2]);
  });
});

describe("realistic volume", () => {
  it("publishes a full 50-article batch and drops exactly the seeded bad ones", async () => {
    const arts = Array.from({ length: 50 }, (_, i) => article(i + 1));
    const scores = arts.map((a, i) => {
      if (i === 7) return goodEntry(a.id, { flags: undefined });
      if (i === 21) return goodEntry(a.id, { political_lean: "x" });
      if (i === 33) return goodEntry(a.id, { content_type: "navigation" });
      return goodEntry(a.id);
    });
    const out = await run(arts, scores);
    expect(out).toHaveLength(47);
    expect(out.map((s) => s.articleId)).not.toContain(8);
    expect(out.map((s) => s.articleId)).not.toContain(22);
    expect(out.map((s) => s.articleId)).not.toContain(34);
  });
});
