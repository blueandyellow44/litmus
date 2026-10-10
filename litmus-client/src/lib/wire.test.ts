import { describe, expect, it } from "vitest";
import { buildWire, editionStats, framingLine, pickQuote, QUOTE_MAX_WORDS } from "./wire.ts";
import type { ArticleSummaryDTO, ClusterArticleDTO, ClusterDTO, DimensionRationale, PHMarker } from "./types.ts";

const m = (text: string, category: string, intensity = 3): PHMarker => ({ text, category, intensity }) as PHMarker;
const words = (s: string) => s.replaceAll("…", "").trim().split(/\s+/).length;

describe("pickQuote", () => {
  it("prefers the sentence with a loaded highlight over a grounded one", () => {
    const q = pickQuote({
      paragraphs: ["Officials counted 44 cases on Monday. Critics called the response a total catastrophe for the city."],
      markers: [m("44 cases", "grounded", 5), m("total catastrophe", "loaded_terms", 3)],
    })!;
    expect(q.tone).toBe("loaded");
    expect(q.text).toBe("Critics called the response a total catastrophe for the city.");
    expect(q.markers.map((x) => x.text)).toEqual(["total catastrophe"]);
  });

  it("among loaded highlights, takes the most intense", () => {
    const q = pickQuote({
      paragraphs: ["The plan drew mild pushback. Opponents slammed it as a disgrace."],
      markers: [m("mild pushback", "loaded_terms", 1), m("slammed it as a disgrace", "emotional_language", 5)],
    })!;
    expect(q.text).toBe("Opponents slammed it as a disgrace.");
  });

  it("never counts a highlight inside a named speaker's quotation", () => {
    const q = pickQuote({
      paragraphs: ['The senator said "this is an absolute disaster" on Tuesday. The bill passed 52 to 48.'],
      markers: [m("absolute disaster", "loaded_terms", 5), m("passed 52 to 48", "grounded", 2)],
    })!;
    expect(q.tone).toBe("grounded");
    expect(q.text).toBe("The bill passed 52 to 48.");
  });

  it("falls back to the most grounded line when nothing is loaded", () => {
    const q = pickQuote({ paragraphs: ["NASA launched the telescope at 7:26 a.m."], markers: [m("launched the telescope", "grounded")] })!;
    expect(q.tone).toBe("grounded");
  });

  it("returns null, not a guess, when there is no highlight or no excerpt", () => {
    expect(pickQuote(null)).toBeNull();
    expect(pickQuote({ paragraphs: ["Plain text."], markers: [] })).toBeNull();
  });

  it("keeps the quoted text verbatim and strips the excerpt's cut marks", () => {
    const q = pickQuote({ paragraphs: ["…the U.S. Senate voted to slash funding overnight…"], markers: [m("slash funding", "loaded_terms")] })!;
    expect(q.text).toBe("the U.S. Senate voted to slash funding overnight");
  });

  it("trims an overlong sentence around its highlight, keeping the phrase whole", () => {
    const long = `${Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ")} a reckless gamble ${Array.from({ length: 60 }, (_, i) => `z${i}`).join(" ")}.`;
    const q = pickQuote({ paragraphs: [long], markers: [m("a reckless gamble", "loaded_terms")] })!;
    expect(words(q.text)).toBeLessThanOrEqual(QUOTE_MAX_WORDS);
    expect(q.text).toContain("a reckless gamble");
    expect(q.markers).toHaveLength(1);
  });
});

describe("framingLine", () => {
  const r = (over: Partial<DimensionRationale>): DimensionRationale =>
    ({ summary: "", headline: "", language: "", sourcing: "", fallacies: "", structure: "", ...over }) as DimensionRationale;

  it("uses the summary when it talks about the telling", () => {
    expect(framingLine(r({ summary: "Wire-service style coverage with neutral language. More detail." }))).toBe(
      "Wire-service style coverage with neutral language.",
    );
  });

  it("uses the language note when the summary only restates the story", () => {
    expect(
      framingLine(r({ summary: "NASA launched a telescope on Sunday.", language: "Plain verbs and factual credits throughout. No loaded modifiers." })),
    ).toBe("Plain verbs and factual credits throughout.");
  });

  it("returns null with no rationale", () => {
    expect(framingLine(null)).toBeNull();
  });
});

describe("buildWire", () => {
  const art = (id: number, composite: number, excerpt = true): ArticleSummaryDTO =>
    ({
      id,
      sourceName: `Outlet ${id}`,
      title: `Title ${id}`,
      url: `https://o${id}.example/a`,
      score: { composite },
      excerpt: excerpt ? { paragraphs: ["They called it a total disaster."], markers: [m("total disaster", "loaded_terms")] } : null,
    }) as unknown as ArticleSummaryDTO;
  const member = (id: number, composite: number) =>
    ({ id, sourceName: `Outlet ${id}`, score: { composite, label: "x" } }) as unknown as ClusterArticleDTO;
  const cluster = (id: number, phMin: number, phMax: number, n: number) =>
    ({ id, topic: `Story ${id}`, articleCount: n, phMin, phMax }) as unknown as ClusterDTO;

  it("puts multi-outlet stories first, widest gap first, then the rest in edition order, each article once", () => {
    const articles = [art(1, 1.2), art(2, 3.9), art(3, 2.0), art(4, 1.1), art(5, 4.1)];
    const clusters = [cluster(10, 1.0, 2.0, 2), cluster(11, 1.1, 4.1, 2)];
    const members = { 10: [member(1, 1.2), member(3, 2.0)], 11: [member(4, 1.1), member(5, 4.1)] };
    const items = buildWire(articles, clusters, members);
    expect(items.map((i) => (i.kind === "story" ? `s${i.cluster.id}` : `a${i.article.id}`))).toEqual(["s11", "s10", "a2"]);
  });

  it("leads a story with its hottest member that has a quote, and lists the others hottest first", () => {
    const articles = [art(1, 4.5, false), art(2, 3.0), art(3, 1.0)];
    const items = buildWire(articles, [cluster(7, 1.0, 4.5, 3)], { 7: [member(1, 4.5), member(2, 3.0), member(3, 1.0)] });
    const story = items[0]!;
    expect(story.kind).toBe("story");
    if (story.kind !== "story") return;
    expect(story.lead.id).toBe(2);
    expect(story.others.map((o) => o.id)).toEqual([1, 3]);
  });

  it("does not group a one-member cluster", () => {
    const items = buildWire([art(1, 2)], [cluster(9, 2, 2, 1)], { 9: [member(1, 2)] });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("single");
  });
});

describe("editionStats", () => {
  it("counts every band in scale order, unrated separately, and sections largest first", () => {
    const a = (composite: unknown, section: string | null) => ({ score: composite === null ? null : { composite, section } }) as unknown as ArticleSummaryDTO;
    const stats = editionStats([a(1.2, "Politics"), a(1.3, "Politics"), a(4.8, "World"), a(null, null)], []);
    expect(stats.total).toBe(4);
    expect(stats.unrated).toBe(1);
    expect(stats.byBand.reduce((n, b) => n + b.count, 0)).toBe(3);
    expect(stats.byBand[0]!.count).toBe(2);
    expect(stats.byBand.at(-1)!.count).toBe(1);
    expect(stats.bySection).toEqual([{ section: "Politics", count: 2 }, { section: "World", count: 1 }]);
  });
});
