// The fixture builder (scripts/stories-fixture.mjs) stands in for the server
// until the Story Ledger lands, so it is held to the contract and to the
// client's own reading of it: same edition order, same outlet naming, legal
// caps carried through untouched.

import { describe, expect, it } from "vitest";
import { FIXTURE_HEADLINE_ONLY_TITLE_PREFIX, FIXTURE_OUTLET_SUFFIX, buildStories } from "../../../scripts/stories-fixture.mjs";
import type { StoryDTO } from "./storyTypes.ts";
import { orderStories, outletShortName } from "./storyModel.ts";

function detail(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    sourceId: id,
    sourceName: `Outlet ${id}`,
    sourceLean: "center",
    url: `https://example.test/${id}`,
    title: `Headline ${id}`,
    author: null,
    publishedAt: `2026-09-13T1${id % 10}:00:00.000Z`,
    wordCount: 500,
    extractionStatus: "full",
    paywallFlag: false,
    fetchedAt: "2026-09-13T16:00:00.000Z",
    score: {
      composite: 2,
      label: "Grounded",
      politicalLean: 0,
      rationale: { summary: `How ${id} told it.` },
      articleSummary: `What ${id} reported.`,
      section: "Politics",
      scoredAt: "2026-09-13T16:10:00.000Z",
      markers: [{ text: "plain", category: "grounded", intensity: 2 }],
    },
    excerpt: { paragraphs: [`A plain paragraph from ${id}.`], markers: [{ text: "plain", category: "grounded", intensity: 2 }] },
    translation: null,
    ...over,
  };
}

function snapshot() {
  const a1 = detail(1, { sourceName: "Axios — Politics & Policy", score: { ...detail(1).score, composite: 1.5, politicalLean: -20 } });
  const a2 = detail(2, { sourceName: "Axios — Business", score: { ...detail(2).score, composite: 2.4, politicalLean: 10 } });
  const a3 = detail(3, { sourceName: "Fox News", score: { ...detail(3).score, composite: 4.1, politicalLean: 60 } });
  const a4 = detail(4, { sourceName: "NPR — News" });
  const a5 = detail(5, { sourceName: "Variety", score: null, excerpt: null });
  const summary = (d: ReturnType<typeof detail>) => ({ ...d, score: d.score ? { composite: d.score.composite, label: d.score.label } : null });
  return {
    articles: [a1, a2, a3, a4, a5],
    articleDetail: Object.fromEntries([a1, a2, a3, a4, a5].map((d) => [String(d.id), d])),
    clusters: [{ id: 10, topic: "Leaders call for a slowdown", summary: "Leaders asked for a slower pace.", articleCount: 3, phMin: 1.5, phMax: 4.1, phAvg: 2.7, leanCounts: {}, updatedAt: "2026-09-13T16:20:00.000Z" }],
    clusterArticles: { 10: [summary(a1), summary(a2), summary(a3)] },
  };
}

describe("buildStories", () => {
  const stories = buildStories(snapshot()) as StoryDTO[];

  it("makes one story per cluster and one single-outlet story per unclustered scored article", () => {
    expect(stories.map((s) => s.id)).toEqual(["st_fx_leaders-call-for-a-slowdown", "st_fx_headline-4"]);
    expect(stories[0]?.singleOutlet).toBe(false);
    expect(stories[1]?.singleOutlet).toBe(true);
    // The unscored article is not a story.
    expect(stories.some((s) => s.members.some((m) => m.articleId === 5))).toBe(false);
  });

  it("ids derive from the topic slug and are stable across runs", () => {
    const again = buildStories(snapshot()) as StoryDTO[];
    expect(again.map((s) => s.id)).toEqual(stories.map((s) => s.id));
    expect(stories[0]?.slug).toBe("leaders-call-for-a-slowdown");
  });

  it("collapses sister feeds to one outletKey and counts distinct outlets", () => {
    // The clean build, so the counts describe the snapshot's own data and not
    // the fixture member (which is a third outlet and a fourth member).
    const s = (buildStories(snapshot(), { withHollowFixture: false }) as StoryDTO[])[0]!;
    const axios = s.members.filter((m) => m.outletKey === "axios");
    expect(axios).toHaveLength(2);
    expect(axios.every((m) => m.outletName === "Axios")).toBe(true);
    expect(s.outletCount).toBe(2); // axios and fox-news
    expect(s.memberCount).toBe(3);
    expect(s.phMin).toBe(1.5);
    expect(s.phMax).toBe(4.1);
    for (const m of s.members) expect(m.outletName).toBe(outletShortName(m.outletName));
  });

  it("copies the capped excerpt as-is and carries no rawText or full body", () => {
    const m = stories[0]!.members[0]!;
    expect(m.excerpt).toEqual({ paragraphs: ["A plain paragraph from 1."], markers: [{ text: "plain", category: "grounded", intensity: 2 }] });
    expect(JSON.stringify(stories)).not.toContain("rawText");
    expect(m.kind).toBe("full");
    expect(m.role).toBe("primary");
    expect(m.howItWasTold).toBe("How 1 told it.");
    expect(m.politicalLean).toBe(-20);
  });

  it("leaves notes empty, coverage empty and the sweep complete", () => {
    for (const s of stories) {
      expect(s.notes).toEqual([]);
      expect(s.coverage).toEqual({ excluded: [], sweepComplete: true });
    }
  });

  it("adds one clearly marked headline-only member with a headline and a link only", () => {
    const hollow = stories.flatMap((s) => s.members).filter((m) => m.kind === "headline_only");
    expect(hollow).toHaveLength(1);
    const m = hollow[0]!;
    expect(m.title.startsWith(FIXTURE_HEADLINE_ONLY_TITLE_PREFIX)).toBe(true);
    expect(m.outletName.endsWith(FIXTURE_OUTLET_SUFFIX)).toBe(true);
    expect(m.excerpt).toBeNull();
    expect(m.composite).toBeNull();
    expect(m.politicalLean).toBeNull();
    expect(m.url).toMatch(/^https:\/\//);
    // It sits on the largest story and is not also a single-outlet story.
    expect(stories[0]!.members).toContain(m);
    expect(stories.filter((s) => s.members.some((x) => x.articleId === m.articleId))).toHaveLength(1);
  });

  it("can be built without the fixture member for a clean edition", () => {
    const clean = buildStories(snapshot(), { withHollowFixture: false }) as StoryDTO[];
    expect(clean.flatMap((s) => s.members).some((m) => m.kind === "headline_only")).toBe(false);
    // Dropping the hollow member removes a member, never adds a story: the
    // cluster and the one unclustered scored article, as in the default build.
    expect(clean).toHaveLength(2);
    expect(clean.map((s) => s.memberCount)).toEqual([3, 1]);
  });

  it("agrees with the client's edition order", () => {
    const shuffled = buildStories(snapshot(), { withHollowFixture: false }) as StoryDTO[];
    expect(orderStories([...shuffled].reverse()).map((s) => s.id)).toEqual(shuffled.map((s) => s.id));
  });

  it("uses the assessment fields honestly: model names the source, null when there is nothing", () => {
    expect(stories[0]?.assessment?.model).toBe("fixture: clusterer summary");
    expect(stories[1]?.assessment?.model).toBe("fixture: scorer article summary");
    const none = buildStories({ ...snapshot(), clusters: [{ id: 10, topic: "T", summary: "", updatedAt: "2026-09-13T16:20:00.000Z" }] }, { withHollowFixture: false }) as StoryDTO[];
    expect(none[0]?.assessment).toBeNull();
  });

  it("refuses a non-object snapshot", () => {
    expect(() => buildStories(null)).toThrow(/snapshot/);
  });
});
