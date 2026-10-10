// The furniture filter and its place in scoring, with Jev stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Article } from "../types.js";

// Per-paragraph class probabilities, keyed by paragraph text.
const verdicts = new Map<string, Record<string, number>>();
let fail = false;
vi.mock("../lib/jev.js", () => ({
  JEV_MODEL: "typesafe/jev",
  jevAvailable: () => true,
  askJev: async (_state: unknown, questions: Record<string, { instructions: string }>) => {
    if (fail) throw new Error("gateway down");
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries(questions)) {
      const text = /Paragraph: "([\s\S]*)"$/.exec(q.instructions)?.[1] ?? "";
      const probabilities = verdicts.get(text) ?? { story: 0.95, caption: 0.05 };
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
      answers[k] = { type: "choice", choice, probabilities };
    }
    return { answers, inputTokens: 10 };
  },
}));
vi.mock("../lib/env.js", () => ({ env: { FURNITURE_FILTER: "jev", ANTHROPIC_FAKE: false } }));

const { filterFurniture, isAllCapsLink, DROP_AT } = await import("./furniture.js");
const { prepareForScoring } = await import("./batchRunner.js");

const STORY = "The city council voted 6-3 on Monday to approve the budget, which raises property taxes by 2 percent.";
const CAPTION = "Robert F. Bukaty/AP Photo";
const PROMO = "Sign up for our free daily newsletter.";
const LINK = "TRUMP SAYS US WILL LET UKRAINE MAKE PATRIOT MISSILES IN MAJOR POLICY SHIFT";

beforeEach(() => { verdicts.clear(); fail = false; });

describe("filterFurniture", () => {
  it("sets aside confident furniture and keeps the story text, in order", async () => {
    verdicts.set(CAPTION, { caption: 0.9, story: 0.1 });
    verdicts.set(PROMO, { promo: 0.8, story: 0.2 });
    const r = await filterFurniture("Budget passes", [STORY, CAPTION, STORY + " More.", PROMO].join("\n\n"));
    expect(r.cleanText).toBe([STORY, STORY + " More."].join("\n\n"));
    expect(r.furniture.map((f) => [f.index, f.class])).toEqual([[1, "caption"], [3, "promo"]]);
    expect(r.furniture[0]!.text).toBe(CAPTION);
  });

  it("keeps a paragraph when the furniture classes fall short of the bar", async () => {
    verdicts.set(CAPTION, { caption: DROP_AT - 0.05, story: 1 - (DROP_AT - 0.05) });
    const r = await filterFurniture("t", [STORY, CAPTION].join("\n\n"));
    expect(r.furniture).toEqual([]);
  });

  it("sets aside an all-caps link to another story even when Jev calls it a subheading", async () => {
    verdicts.set(LINK, { subheading: 0.9, promo: 0.1 });
    const r = await filterFurniture("t", [STORY, LINK].join("\n\n"));
    expect(r.furniture.map((f) => f.class)).toEqual(["promo"]);
    expect(isAllCapsLink("NATO")).toBe(false); // too short to be a link line
  });

  it("keeps a caption glued to a story sentence rather than lose the sentence", async () => {
    const glued = `Pope Leo waves to the crowd. AFP via Getty Images\n${STORY} ${STORY}`;
    verdicts.set(glued, { caption: 0.9, story: 0.1 });
    const r = await filterFurniture("t", [STORY, glued].join("\n\n"));
    expect(r.furniture).toEqual([]);
  });

  it("never leaves an article empty", async () => {
    verdicts.set(CAPTION, { caption: 0.99, story: 0.01 });
    const r = await filterFurniture("t", CAPTION);
    expect(r.cleanText).toBe(CAPTION);
    expect(r.furniture).toEqual([]);
  });
});

function article(id: number, rawText: string, cleaned = false): Article {
  return { id, sourceId: 1, url: `https://e.test/${id}`, title: "t", author: null, publishedAt: null, rawText, wordCount: 100,
    extractionStatus: "full", paywallFlag: false, contentHash: "h", extractedVia: "publisher", syndicatedOfArticleId: null, fetchedAt: new Date(), cleaned };
}

describe("prepareForScoring", () => {
  it("stores the result before scoring and hands the scorer the clean text", async () => {
    verdicts.set(CAPTION, { caption: 0.9, story: 0.1 });
    const stored: Array<[number, string]> = [];
    const [a] = await prepareForScoring([article(7, [STORY, CAPTION].join("\n\n"))], async (id, clean) => { stored.push([id, clean]); });
    expect(stored).toEqual([[7, STORY]]);
    expect(a!.rawText).toBe(STORY);
    expect(a!.cleaned).toBe(true);
  });

  it("does not filter an article twice", async () => {
    const persist = vi.fn(async () => {});
    const [a] = await prepareForScoring([article(7, STORY, true)], persist);
    expect(persist).not.toHaveBeenCalled();
    expect(a!.rawText).toBe(STORY);
  });

  it("scores the raw text when the filter fails", async () => {
    fail = true;
    const persist = vi.fn(async () => {});
    const raw = [STORY, CAPTION].join("\n\n");
    const [a] = await prepareForScoring([article(7, raw)], persist);
    expect(persist).not.toHaveBeenCalled();
    expect(a!.rawText).toBe(raw);
  });
});
