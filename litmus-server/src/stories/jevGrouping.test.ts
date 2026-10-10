// Jev makes the ledger's same-event decisions (Max, 2026-10-02), with Jev
// stubbed: confident answers decide, everything else goes back to Haiku or
// stands, and a failed call never reads as "not the same event".
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoryArticle, StoryCard } from "./retrieval.js";

// What Jev "thinks" for each article id: the headline it matches and how sure
// it is, or "none" with its probability. Roundup answers are keyed by id too.
const verdicts = new Map<number, { headline: string | null; p: number }>();
const roundups = new Set<number>();
// Articles whose pick fails the moment-or-reaction check.
const notMoment = new Set<number>();
// Story headlines Jev calls a bundle of several developments.
const bundleHeadlines = new Set<string>();
let mergeP: number | null = 0.5;
let fail = false;
const calls: Array<Record<string, unknown>> = [];
vi.mock("../lib/jev.js", () => ({
  JEV_MODEL: "typesafe/jev",
  jevAvailable: () => true,
  askJev: async (state: Record<string, unknown>, questions: Record<string, { type: string; criteria: Record<string, string> }>) => {
    calls.push(state);
    if (fail) throw new Error("gateway down");
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries(questions)) {
      if (k === "same") { answers[k] = { type: "noul", noul: mergeP ?? undefined }; continue; }
      if (k === "one") { answers[k] = { type: "noul", noul: bundleHeadlines.has((state.story as { headline: string }).headline) ? 0.1 : 0.9 }; continue; }
      const id = Number(k.slice(1));
      if (k.startsWith("r")) { answers[k] = { type: "noul", noul: roundups.has(id) ? 0.9 : 0.1 }; continue; }
      if (k.startsWith("m")) { answers[k] = { type: "noul", noul: notMoment.has(id) ? 0.1 : 0.9 }; continue; }
      const v = verdicts.get(id) ?? { headline: null, p: 0.9 };
      const keys = Object.keys(q.criteria);
      const hit = v.headline ? keys.find((key) => q.criteria[key]!.startsWith(`${v.headline}:`)) : undefined;
      const probabilities: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
      if (hit) { probabilities[hit] = v.p; probabilities.none = 1 - v.p; } else { probabilities.none = v.headline ? 0.5 : v.p; }
      answers[k] = { type: "choice", probabilities };
    }
    return { answers, inputTokens: 100 };
  },
}));

const { jevAssignmentPrepass, jevSweepArticles, jevReviewMerge, resetCardScreen, CARDS_PER_SHARD } = await import("./jevGrouping.js");

function article(id: number): StoryArticle {
  return { id, title: `Article ${id}`, url: `https://e.test/${id}`, outletKey: "o", outletName: "Outlet", sourceLean: "center" as StoryArticle["sourceLean"],
    publishedAt: new Date("2026-10-02T12:00:00Z"), fetchedAt: new Date("2026-10-02T12:00:00Z"), extractionStatus: "full", wordCount: 400,
    syndicatedOfArticleId: null, articleSummary: `Summary ${id}`, reactingTo: null, section: "Politics" };
}
function card(n: number): StoryCard {
  return { id: `story-${n}`, headline: `Story ${n}`, eventStatement: `Event ${n}.`, section: "Politics", firstSeenAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-02T00:00:00Z"), memberHeadlines: [`Member of ${n}`], memberArticleIds: [n * 100], outletKeys: ["x"] };
}

beforeEach(() => { resetCardScreen(); bundleHeadlines.clear(); verdicts.clear(); roundups.clear(); notMoment.clear(); mergeP = 0.5; fail = false; calls.length = 0; });

describe("jevAssignmentPrepass", () => {
  const cards = [card(1), card(2), card(3)];
  const candidates = new Map([[1, cards], [2, cards], [3, cards], [4, cards], [5, [] as StoryCard[]]]);
  const articles = [1, 2, 3, 4, 5].map(article);

  it("attaches confident matches, hides candidates after a confident no-match, and leaves the rest to Haiku", async () => {
    verdicts.set(1, { headline: "Story 2", p: 0.93 }); // confident match
    verdicts.set(2, { headline: null, p: 0.85 }); // confident: none of them
    verdicts.set(3, { headline: "Story 1", p: 0.6 }); // not sure
    verdicts.set(4, { headline: "Story 3", p: 0.95 }); roundups.add(4); // a roundup: Haiku's call
    const r = await jevAssignmentPrepass(articles, candidates);
    expect(r.decided).toEqual([expect.objectContaining({ articleId: 1, action: "attach", storyIds: ["story-2"], role: "primary", confidence: "high" })]);
    expect(r.forHaiku.map((a) => a.id)).toEqual([2, 3, 4, 5]);
    expect(r.candidatesForHaiku.get(2)).toEqual([]);
    expect(r.candidatesForHaiku.get(3)).toEqual(cards);
    expect(r.candidatesForHaiku.get(4)).toEqual(cards);
    expect(r.stats).toEqual({ attached: 1, noMatch: 1, undecided: 2, failed: 0, verifyRejected: 0, outsideWindow: 0, thinEvidence: 0, bundleCards: 0 });
  });

  it("sends a confident pick back to Haiku when it fails the moment check", async () => {
    verdicts.set(1, { headline: "Story 2", p: 0.95 });
    notMoment.add(1);
    const r = await jevAssignmentPrepass([article(1)], candidates);
    expect(r.decided).toEqual([]);
    expect(r.forHaiku.map((a) => a.id)).toEqual([1]);
    expect(r.candidatesForHaiku.get(1)).toEqual(cards);
    expect(r.stats.verifyRejected).toBe(1);
  });

  it("leaves an article with no summary and almost no text to Haiku, without asking Jev", async () => {
    const thin = { ...article(1), articleSummary: null, lede: "Choose wisely, Maine." };
    verdicts.set(1, { headline: "Story 2", p: 0.99 });
    const r = await jevAssignmentPrepass([thin], candidates);
    expect(r.decided).toEqual([]);
    expect(r.candidatesForHaiku.get(1)).toEqual(cards);
    expect(r.stats.thinEvidence).toBe(1);
    expect(calls.filter((c) => "articles" in c)).toHaveLength(0);
  });

  it("decides an unscored article from its opening text", async () => {
    const opened = { ...article(1), articleSummary: null, lede: Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ") };
    verdicts.set(1, { headline: "Story 2", p: 0.95 });
    const r = await jevAssignmentPrepass([opened], candidates);
    expect(r.decided.map((d) => d.articleId)).toEqual([1]);
  });

  it("never attaches past the same-event window; the article goes to Haiku", async () => {
    const late = { ...article(1), publishedAt: new Date("2026-10-08T00:00:00Z") }; // a week after the cards were first seen
    verdicts.set(1, { headline: "Story 2", p: 0.99 });
    const r = await jevAssignmentPrepass([late], candidates);
    expect(r.decided).toEqual([]);
    expect(r.forHaiku.map((a) => a.id)).toEqual([1]);
    expect(r.stats.outsideWindow).toBe(1);
  });

  it("never offers a card that bundles several developments", async () => {
    bundleHeadlines.add("Story 2");
    verdicts.set(1, { headline: "Story 2", p: 0.99 });
    const r = await jevAssignmentPrepass([article(1)], candidates);
    expect(r.decided).toEqual([]);
    expect(r.stats.bundleCards).toBe(1);
    const offered = calls.find((c) => "articles" in c)!.stories as Record<string, { headline: string }>;
    expect(Object.values(offered).map((c) => c.headline)).not.toContain("Story 2");
  });

  it("asks about one article per call", async () => {
    await jevAssignmentPrepass(articles, candidates);
    expect(calls.filter((state) => !("story" in state)).every((state) => Object.keys((state.articles ?? state.pairs) as object).length === 1)).toBe(true);
  });

  it("never asks Jev about an article with no candidates", async () => {
    await jevAssignmentPrepass([article(5)], candidates);
    expect(calls).toHaveLength(0);
  });

  it("sends everything to Haiku, candidates intact, when Jev fails", async () => {
    fail = true;
    const r = await jevAssignmentPrepass(articles, candidates);
    expect(r.decided).toEqual([]);
    expect(r.forHaiku).toHaveLength(5);
    expect(r.candidatesForHaiku.get(2)).toEqual(cards);
    expect(r.stats.failed).toBe(4);
  });
});

describe("jevSweepArticles", () => {
  const cards = Array.from({ length: CARDS_PER_SHARD + 5 }, (_, i) => card(i + 1));

  it("finds a match in a later shard and writes a check for every card compared", async () => {
    verdicts.set(1, { headline: `Story ${CARDS_PER_SHARD + 3}`, p: 0.9 });
    verdicts.set(2, { headline: null, p: 0.95 });
    const batches: number[] = [];
    const r = await jevSweepArticles([article(1), article(2)], cards, { onValidatedBatch: async (b) => { batches.push(b.shard); } });
    expect(r.decisions).toEqual([
      expect.objectContaining({ articleId: 1, action: "attach", storyIds: [`story-${CARDS_PER_SHARD + 3}`] }),
      expect.objectContaining({ articleId: 2, action: "none" }),
    ]);
    expect(r.checks).toHaveLength(cards.length * 2);
    expect(r.checks.filter((c) => c.outcome === "match")).toHaveLength(1);
    expect(batches.sort()).toEqual([0, 0, 1, 1]); // one article per call, two shards
    expect(r.incompleteArticleIds).toEqual([]);
  });

  it("never offers an article its own new story", async () => {
    await jevSweepArticles([article(1)], [card(1), card(2)], { seededStoryIds: new Map([[1, "story-1"]]) });
    expect(Object.keys(calls.find((c) => "articles" in c)!.stories as object)).toHaveLength(1);
  });

  it("skips bundle cards, out-of-window stories, and articles too thin to judge", async () => {
    bundleHeadlines.add("Story 1");
    verdicts.set(1, { headline: "Story 1", p: 0.99 });
    let r = await jevSweepArticles([article(1)], [card(1)]);
    expect(r.decisions[0]!.action).toBe("none");
    const late = { ...article(2), publishedAt: new Date("2026-10-08T00:00:00Z") };
    verdicts.set(2, { headline: "Story 2", p: 0.99 });
    r = await jevSweepArticles([late], [card(2)]);
    expect(r.decisions[0]!.action).toBe("none");
    const thin = { ...article(3), articleSummary: null };
    verdicts.set(3, { headline: "Story 3", p: 0.99 });
    r = await jevSweepArticles([thin], [card(3)]);
    expect(r.decisions[0]).toEqual(expect.objectContaining({ action: "none", reason: expect.stringContaining("Too little text") }));
  });

  it("does not attach a pick that fails the moment check, and records the card as excluded", async () => {
    verdicts.set(1, { headline: "Story 1", p: 0.95 });
    notMoment.add(1);
    const r = await jevSweepArticles([article(1)], [card(1), card(2)]);
    expect(r.decisions[0]!.action).toBe("none");
    expect(r.checks.every((c) => c.outcome === "excluded")).toBe(true);
  });

  it("does not attach below the bar", async () => {
    verdicts.set(1, { headline: "Story 1", p: 0.7 });
    const r = await jevSweepArticles([article(1)], [card(1)]);
    expect(r.decisions[0]!.action).toBe("none");
  });

  it("keeps the assignment decision when the call fails, and reports it unfinished", async () => {
    fail = true;
    const r = await jevSweepArticles([article(1)], [card(1)]);
    expect(r.decisions[0]).toEqual(expect.objectContaining({ action: "none", reason: expect.stringContaining("did not finish") }));
    expect(r.incompleteArticleIds).toEqual([1]);
    expect(r.checks).toEqual([]);
  });
});

describe("jevReviewMerge", () => {
  it.each([[0.9, "yes"], [0.1, "no"], [0.5, "unsure"], [null, "unsure"]] as const)("probability %s reads as %s", async (p, decision) => {
    mergeP = p;
    expect((await jevReviewMerge(card(1), card(2))).decision).toBe(decision);
  });

  it("throws when Jev fails, as the Haiku review does", async () => {
    fail = true;
    await expect(jevReviewMerge(card(1), card(2))).rejects.toThrow("gateway down");
  });
});
