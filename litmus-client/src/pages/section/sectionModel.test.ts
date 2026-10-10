// The section page's shared model: the one place both versions get their order,
// their lists and their tellings from. If these hold, desktop and mobile cannot
// show a reader different coverage for the same lens.

import { describe, expect, it } from "vitest";
import { buildSectionModel, decodeEntities, sortCoverage } from "./sectionModel.ts";
import type { Lean, SectionArticleDTO, SectionPageDTO } from "../../lib/types.ts";

let seq = 0;
function art(over: Partial<SectionArticleDTO> = {}): SectionArticleDTO {
  const id = ++seq;
  return {
    id,
    sourceId: id,
    sourceName: `Source ${id}`,
    sourceLean: "center" as Lean,
    url: `https://example.test/${id}`,
    title: `Headline ${id}`,
    author: null,
    publishedAt: null,
    politicalLean: 0,
    composite: 2,
    label: null,
    articleSummary: "",
    rationale: null,
    excerpt: { paragraphs: ["A sentence."], markers: [] },
    ...over,
  };
}

function page(articles: SectionArticleDTO[], sectionArticles: SectionArticleDTO[] | undefined, trending = true): SectionPageDTO {
  return {
    section: "Politics",
    trending: trending
      ? ({ clusterId: 1, topic: "A story", summary: "What happened.", articleCount: articles.length, phSpread: 1 } as SectionPageDTO["trending"])
      : null,
    articles,
    sectionArticles: sectionArticles as SectionArticleDTO[],
  };
}

describe("sortCoverage", () => {
  const l = art({ politicalLean: -50 });
  const c = art({ politicalLean: 0 });
  const r = art({ politicalLean: 50 });
  const n = art({ politicalLean: null });

  it("orders left to right for mixed and liberal, right to left for conservative, unscored last", () => {
    expect(sortCoverage([n, r, l, c], "mixed").map((a) => a.id)).toEqual([l.id, c.id, r.id, n.id]);
    expect(sortCoverage([n, r, l, c], "liberal").map((a) => a.id)).toEqual([l.id, c.id, r.id, n.id]);
    expect(sortCoverage([n, l, r, c], "conservative").map((a) => a.id)).toEqual([r.id, c.id, l.id, n.id]);
  });

  it("never drops or mutates the input", () => {
    const input = [r, l];
    const out = sortCoverage(input, "mixed");
    expect(out).toHaveLength(2);
    expect(input[0]).toBe(r);
  });
});

describe("buildSectionModel", () => {
  it("excludes the lead story's coverage from the rest of the desk", () => {
    const lead = [art(), art()];
    const other = art();
    const m = buildSectionModel(page(lead, [...lead, other]), "mixed");
    expect(m.rest.map((a) => a.id)).toEqual([other.id]);
    expect(m.totalInSection).toBe(3);
  });

  it("counts what the page lists, including lead members missing from the section list", () => {
    const inBoth = art();
    const leadOnly = art();
    const other = art();
    const m = buildSectionModel(page([inBoth, leadOnly], [inBoth, other]), "mixed");
    expect(m.coverage).toHaveLength(2);
    expect(m.rest.map((a) => a.id)).toEqual([other.id]);
    expect(m.totalInSection).toBe(m.coverage.length + m.rest.length);
  });

  it("holds nothing back from the desk when there is no lead story", () => {
    const a = art();
    const m = buildSectionModel(page([a], [a], false), "mixed");
    expect(m.rest.map((x) => x.id)).toEqual([a.id]);
    expect(m.totalInSection).toBe(1);
  });

  it("decodes entity-encoded headlines everywhere the page shows them", () => {
    const enc = art({ title: "Kids&#039; Test Scores Hit Record Lows" });
    const m = buildSectionModel(page([enc], [enc]), "mixed");
    expect(m.coverage[0]?.title).toBe("Kids' Test Scores Hit Record Lows");
    expect(m.data.articles[0]?.title).toBe("Kids' Test Scores Hit Record Lows");
  });

  it("survives a snapshot frozen before sectionArticles existed", () => {
    const m = buildSectionModel(page([art()], undefined), "mixed");
    expect(m.rest).toEqual([]);
    // The desk list is empty, but the lead story's one card still shows.
    expect(m.totalInSection).toBe(1);
  });

  it("has no spread without a trending story", () => {
    const m = buildSectionModel(page([], [art()], false), "mixed");
    expect(m.hasLead).toBe(false);
    expect(m.spread).toBeNull();
  });

  it("pairs the calmest and hottest under mixed, and captions the gap honestly", () => {
    const calm = art({ composite: 1.5 });
    const hot = art({ composite: 4.0 });
    const t = buildSectionModel(page([calm, hot], [calm, hot]), "mixed").spread!.tellings;
    expect(t.kind).toBe("pair");
    if (t.kind !== "pair") return;
    expect([t.left.id, t.right.id]).toEqual([calm.id, hot.id]);
    expect(t.real).toBe(true);

    const close = buildSectionModel(page([art({ composite: 2.0 }), art({ composite: 2.2 })], []), "mixed").spread!.tellings;
    expect(close.kind === "pair" && close.real).toBe(false);
  });

  it("says why there is only one telling under mixed when no pair exists", () => {
    const t = buildSectionModel(page([art()], []), "mixed").spread!.tellings;
    expect(t.kind).toBe("only-one");
    if (t.kind === "only-one") expect(t.reason).toMatch(/one outlet/i);
  });

  it("leads with that side's telling under a side lens", () => {
    const l = art({ politicalLean: -70 });
    const r = art({ politicalLean: 70 });
    const lib = buildSectionModel(page([l, r], []), "liberal").spread!.tellings;
    const con = buildSectionModel(page([l, r], []), "conservative").spread!.tellings;
    expect(lib.kind === "lead" && lib.lead.id).toBe(l.id);
    expect(con.kind === "lead" && con.lead.id).toBe(r.id);
  });

  it("counts distinct outlets, not article rows", () => {
    const a = art({ sourceName: "Same" });
    const b = art({ sourceName: "Same" });
    const s = buildSectionModel(page([a, b], []), "mixed").spread!;
    expect(s.outletCount).toBe(1);
    expect(s.articleCount).toBe(2);
  });
});

describe("decodeEntities", () => {
  it("decodes numeric, hex and named entities in one pass", () => {
    expect(decodeEntities("A &amp; B &#x27;C&#39; &quot;D&quot;")).toBe(`A & B 'C' "D"`);
    expect(decodeEntities("&amp;#039;")).toBe("&#039;");
  });

  it("leaves unknown, invalid and plain text alone", () => {
    expect(decodeEntities("AT&T &bogus; &#0; &#99999999;")).toBe("AT&T &bogus; &#0; &#99999999;");
    expect(decodeEntities("")).toBe("");
  });
});
