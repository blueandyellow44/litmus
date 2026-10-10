// Jev judges, Haiku writes (Max, 2026-09-27). scoreBatch with a stubbed Haiku
// and a stubbed Jev: Jev's numbers are the ones published, Haiku is told them,
// a Jev failure falls back to Haiku, and either judge can refuse a non-article.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Article } from "../types.js";
import { deriveFlags } from "./jevJudge.js";

let nextInput: unknown = { scores: [] };
let lastSystem = "";
let lastUser = "";
vi.mock("../lib/anthropic.js", () => ({
  models: { scorer: "test-model" },
  anthropic: () => ({
    messages: {
      create: async (req: { system: string; messages: Array<{ content: string }> }) => {
        lastSystem = req.system;
        lastUser = req.messages[0]!.content;
        return { stop_reason: "tool_use", usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "tool_use", id: "t", name: "submit_scores", input: nextInput }] };
      },
    },
  }),
}));

// Jev answers per article id (read from the state's body), or throws.
const jevAnswers = new Map<string, Record<string, unknown> | Error>();
vi.mock("../lib/jev.js", () => ({
  JEV_MODEL: "typesafe/jev",
  jevAvailable: () => true,
  askJev: async (state: { body: string }) => {
    const id = /ARTICLE-(\d+)/.exec(state.body)?.[1] ?? "";
    const a = jevAnswers.get(id);
    if (!a) throw new Error("no stub");
    if (a instanceof Error) throw a;
    return { answers: a, inputTokens: 123 };
  },
}));

const { scoreBatch, JEV_SET_SCORES_NOTE } = await import("./phScorer.js");
const { leanFrom } = await import("./jevJudge.js");

describe("leanFrom", () => {
  it("maps Jev's 0-4 answer onto -100..+100 through the five anchors", () => {
    expect([0, 1, 2, 3, 4].map((score) => leanFrom({ type: "score", score }))).toEqual([-100, -50, 0, 50, 100]);
    expect(leanFrom({ type: "score", score: 2.3 })).toBe(15);
    expect(leanFrom(undefined)).toBeNull();
    expect(leanFrom({ type: "score", score: Number.NaN })).toBeNull();
  });
});

const body = (id: number) => Array.from({ length: 6 }, (_, i) => `ARTICLE-${id} paragraph ${i} of an ordinary report about something that happened today.`).join("\n\n");
function article(id: number): Article {
  return {
    id, sourceId: id, url: `https://example.test/${id}`, title: `Headline ${id}`, author: null,
    publishedAt: new Date("2026-09-27T12:00:00Z"), rawText: body(id), wordCount: 400, extractionStatus: "full",
    paywallFlag: false, contentHash: `h${id}`, extractedVia: "publisher", syndicatedOfArticleId: null,
    fetchedAt: new Date("2026-09-27T12:30:00Z"), sourceRegister: null,
  };
}
// Haiku's own (calm) numbers: if these are published, Jev was ignored.
function haikuEntry(article_id: number, over: Record<string, unknown> = {}) {
  return {
    article_id, content_type: "article", headline: 1.2, language: 1.3, sourcing: 1.4, fallacies: 1.1, structure: 1.2, band: "Proportionate",
    flags: { emotional_lede: false, loaded_headline: false, fallacy_count: 0, one_sided_sourcing: false, opinion_column: false, register: "news" },
    rationale: { headline: "h", language: "l", sourcing: "s", fallacies: "f", structure: "st", summary: "A plain headline and neutral language keep it calm." },
    markers: [], excerpt_paragraphs: [0], political_lean: 0, article_summary: "Something happened.", reacting_to: "none", section: "Politics", ...over,
  };
}
// A hot Jev judgement. Score indices are 0-4 (Jev's scale); 4 -> 5.0.
function hotJev(over: Record<string, unknown> = {}) {
  return {
    content_type: { type: "choice", choice: "article" },
    headline: { type: "score", score: 4 }, language: { type: "score", score: 4 }, sourcing: { type: "score", score: 0 },
    fallacies: { type: "score", score: 0 }, structure: { type: "score", score: 4 },
    fallacy_count: { type: "choice", choice: "n0" }, loaded_headline: { type: "noul", noul: 0.9 },
    emotional_lede: { type: "noul", noul: 0.8 }, opinion_column: { type: "noul", noul: 0.1 },
    register: { type: "choice", choice: "news" }, band: { type: "choice", choice: "Hyperbolic" }, ...over,
  };
}

beforeEach(() => { jevAnswers.clear(); lastSystem = ""; lastUser = ""; });

describe("Jev judges, Haiku writes", () => {
  it("publishes Jev's numbers, not Haiku's, and marks the model used", async () => {
    jevAnswers.set("1", hotJev());
    nextInput = { scores: [haikuEntry(1)] };
    const [s] = await scoreBatch([article(1)], { judge: "jev", markExcerpt: false });
    expect(s!.headline).toBe(5);
    expect(s!.language).toBe(5);
    // 5/5/1/1/5 with an alarm headline and extreme language: the Hyperbolic pairing floor.
    expect(s!.composite).toBe(4.5);
    expect(s!.label).toBe("Hyperbolic");
    expect(s!.modelUsed).toBe("typesafe/jev+test-model");
    // Haiku still wrote the text.
    expect(s!.rationale.summary).toBe("A plain headline and neutral language keep it calm.");
  });

  it("publishes Jev's political lean over Haiku's, and Haiku's only when Jev gave none", async () => {
    jevAnswers.set("1", hotJev({ political_lean: { type: "score", score: 3.4 } }));
    jevAnswers.set("2", hotJev());
    nextInput = { scores: [haikuEntry(1), haikuEntry(2)] };
    const scores = await scoreBatch([article(1), article(2)], { judge: "jev", markExcerpt: false });
    const byId = new Map(scores.map((x) => [x.articleId, x]));
    expect(byId.get(1)!.politicalLean).toBe(70);
    expect(byId.get(2)!.politicalLean).toBe(haikuEntry(2).political_lean);
    expect(lastUser).toContain('"political_lean": 70');
  });

  it("tells Haiku the set scores so its text explains the published number", async () => {
    jevAnswers.set("1", hotJev());
    nextInput = { scores: [haikuEntry(1)] };
    await scoreBatch([article(1)], { judge: "jev", markExcerpt: false });
    expect(lastSystem.endsWith(JEV_SET_SCORES_NOTE)).toBe(true);
    expect(lastUser).toContain('"set_scores"');
  });

  it("falls back to Haiku's own judgement when Jev fails", async () => {
    jevAnswers.set("1", new Error("gateway down"));
    nextInput = { scores: [haikuEntry(1)] };
    const [s] = await scoreBatch([article(1)], { judge: "jev", markExcerpt: false });
    expect(s!.composite).toBe(1.2);
    expect(s!.modelUsed).toBe("test-model");
    expect(lastSystem.endsWith(JEV_SET_SCORES_NOTE)).toBe(false);
  });

  it("refuses a page Jev says is not an article, even when Haiku says it is", async () => {
    jevAnswers.set("1", hotJev({ content_type: { type: "choice", choice: "listing" } }));
    nextInput = { scores: [haikuEntry(1)] };
    expect(await scoreBatch([article(1)], { judge: "jev", markExcerpt: false })).toEqual([]);
  });

  it("publishes, with a warning, when only Jev's separate band answer disagrees", async () => {
    // Calm numbers but a Hyperbolic band answer: 4 bands apart.
    jevAnswers.set("1", hotJev({ headline: { type: "score", score: 0 }, language: { type: "score", score: 0 }, structure: { type: "score", score: 0 }, loaded_headline: { type: "noul", noul: 0 }, emotional_lede: { type: "noul", noul: 0 } }));
    nextInput = { scores: [haikuEntry(1)] };
    const [s] = await scoreBatch([article(1)], { judge: "jev", markExcerpt: false });
    expect(s!.composite).toBe(1);
  });

  it("leaves the Haiku-only path exactly as it was", async () => {
    jevAnswers.set("1", hotJev());
    nextInput = { scores: [haikuEntry(1)] };
    const [s] = await scoreBatch([article(1)], { judge: "haiku", markExcerpt: false });
    expect(s!.composite).toBe(1.2);
    expect(lastUser).not.toContain("set_scores");
  });
});

describe("deriveFlags reads the one-sided flag and fallacy count off the single answer", () => {
  const dims = { headline: 1, language: 1, sourcing: 1, fallacies: 1, structure: 1 };
  it("a sourcing score above the no-flag ceiling means one-sided sourcing", () => {
    expect(deriveFlags({ ...dims, sourcing: 2.6 }, {}).oneSidedSourcing).toBe(true);
    expect(deriveFlags({ ...dims, sourcing: 2.0 }, {}).oneSidedSourcing).toBe(false);
  });
  it("a fallacies score above the ceiling implies at least one fallacy, never fewer than Jev counted", () => {
    expect(deriveFlags({ ...dims, fallacies: 3.0 }, { fallacy_count: { type: "choice", choice: "n0" } }).fallacyCount).toBe(1);
    expect(deriveFlags({ ...dims, fallacies: 4.0 }, {}).fallacyCount).toBe(2);
    expect(deriveFlags({ ...dims, fallacies: 1.0 }, { fallacy_count: { type: "choice", choice: "n2" } }).fallacyCount).toBe(2);
  });
});
