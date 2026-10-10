// The All Stories feed's filtering and sorting, and the pagination merge.
//
// The row counts here are the ones the audit named: 0, 1, 50, 51, 300.

import { describe, expect, it } from "vitest";
import { SORT_KEYS, applyFilters, applySort } from "./ClusterList.tsx";
import type { ArticleSummaryDTO, Lean } from "../lib/types.ts";

const ANY = "__any__";
const NO_FILTERS = { section: ANY, baseline: ANY, framing: ANY, band: ANY, source: ANY, paywall: "any" as const };

let seq = 0;
function article(over: Partial<ArticleSummaryDTO> & { composite?: number | null; lean?: number; section?: string } = {}): ArticleSummaryDTO {
  const id = ++seq;
  const { composite = 2.0, lean = 0, section = "Politics", ...rest } = over;
  return {
    id,
    sourceId: id,
    sourceName: `Source ${id}`,
    sourceLean: "center" as Lean,
    url: `https://example.test/${id}`,
    title: `Headline ${id}`,
    author: null,
    publishedAt: new Date(Date.UTC(2026, 8, 4, 12, 0, id % 60)).toISOString(),
    wordCount: 600,
    extractionStatus: "full",
    paywallFlag: false,
    fetchedAt: "2026-09-04T13:00:00Z",
    score:
      composite === null
        ? null
        : {
            headline: 2, language: 2, sourcing: 2, fallacies: 1, structure: 2,
            composite,
            label: "Grounded",
            rationale: { headline: "", language: "", sourcing: "", fallacies: "", structure: "", summary: "why" },
            markers: [],
            excerptIndices: [],
            politicalLean: lean,
            articleSummary: "The facts.",
            section,
            modelUsed: "test",
            scoredAt: "2026-09-04T13:00:00Z",
          },
    excerpt: null,
    ...rest,
  };
}

function feed(n: number): ArticleSummaryDTO[] {
  return Array.from({ length: n }, () => article());
}

describe("row counts the page has to survive", () => {
  it.each([0, 1, 50, 51, 300])("renders %s rows without losing or duplicating one", (n) => {
    seq = 0;
    const rows = feed(n);
    const out = applySort(applyFilters(rows, NO_FILTERS), "newest");
    expect(out).toHaveLength(n);
    expect(new Set(out.map((a) => a.id)).size).toBe(n);
  });
});

describe("filters", () => {
  it("passes everything through when nothing is set", () => {
    const rows = feed(20);
    expect(applyFilters(rows, NO_FILTERS)).toHaveLength(20);
  });

  it("filters on OUTLET BASELINE, which is the publication's standing label", () => {
    const rows = [article({ sourceLean: "right" }), article({ sourceLean: "left" }), article({ sourceLean: "right" })];
    expect(applyFilters(rows, { ...NO_FILTERS, baseline: "right" })).toHaveLength(2);
  });

  it("filters on ARTICLE FRAMING, which is a different reading of the same article", () => {
    // The point of keeping both: an outlet baselined Right can file a piece the
    // scorer reads as Center, and filtering on one must not silently apply the
    // other.
    const rows = [
      article({ sourceLean: "right", lean: 0 }),
      article({ sourceLean: "right", lean: 80 }),
    ];
    expect(applyFilters(rows, { ...NO_FILTERS, baseline: "right" })).toHaveLength(2);
    expect(applyFilters(rows, { ...NO_FILTERS, framing: "Center" })).toHaveLength(1);
    expect(applyFilters(rows, { ...NO_FILTERS, framing: "Right" })).toHaveLength(1);
  });

  it("excludes an unscored article from a framing filter rather than treating it as centre", () => {
    // "Unknown" is not "no". An article with no lean reading must not be
    // returned by a filter asking for Center.
    const rows = [article({ composite: null })];
    expect(applyFilters(rows, { ...NO_FILTERS, framing: "Center" })).toHaveLength(0);
  });

  it("filters on the band computed from the number, not on the stored label", () => {
    const rows = [article({ composite: 4.8 }), article({ composite: 1.1 })];
    // Both rows carry the stored label "Grounded"; only the numbers differ.
    expect(applyFilters(rows, { ...NO_FILTERS, band: "Hyperbolic" })).toHaveLength(1);
    expect(applyFilters(rows, { ...NO_FILTERS, band: "Proportionate" })).toHaveLength(1);
    expect(applyFilters(rows, { ...NO_FILTERS, band: "Grounded" })).toHaveLength(0);
  });

  it("splits access by paywall OR partial extraction", () => {
    const rows = [
      article(),
      article({ paywallFlag: true }),
      article({ extractionStatus: "partial" }),
    ];
    expect(applyFilters(rows, { ...NO_FILTERS, paywall: "open" })).toHaveLength(1);
    expect(applyFilters(rows, { ...NO_FILTERS, paywall: "restricted" })).toHaveLength(2);
  });

  it("combines filters conjunctively", () => {
    const rows = [
      article({ sourceLean: "left", section: "World" }),
      article({ sourceLean: "left", section: "Politics" }),
      article({ sourceLean: "right", section: "World" }),
    ];
    expect(applyFilters(rows, { ...NO_FILTERS, baseline: "left", section: "World" })).toHaveLength(1);
  });

  it("returns an empty set rather than everything when nothing matches", () => {
    expect(applyFilters(feed(10), { ...NO_FILTERS, source: "Nobody" })).toHaveLength(0);
  });
});

describe("sorts", () => {
  it("orders newest first", () => {
    seq = 0;
    const rows = feed(30);
    const out = applySort(rows, "newest");
    for (let i = 1; i < out.length; i++) {
      expect(Date.parse(out[i - 1]!.publishedAt!)).toBeGreaterThanOrEqual(Date.parse(out[i]!.publishedAt!));
    }
  });

  it("orders P/H both ways", () => {
    const rows = [article({ composite: 3.1 }), article({ composite: 1.2 }), article({ composite: 4.9 })];
    expect(applySort(rows, "ph-high").map((a) => a.score!.composite)).toEqual([4.9, 3.1, 1.2]);
    expect(applySort(rows, "ph-low").map((a) => a.score!.composite)).toEqual([1.2, 3.1, 4.9]);
  });

  it("does not let an unscored article masquerade as the calmest thing on the page", () => {
    const rows = [article({ composite: null }), article({ composite: 1.1 })];
    expect(applySort(rows, "ph-low")[0]!.score?.composite).toBe(1.1);
  });

  it("offers no story-volume sort, because there is no story identifier to compute one from", () => {
    // "Most covered" shipped once and was removed. It approximated "same story"
    // by normalising headline words, which is a text-similarity guess dressed as
    // an authoritative coverage count: two unrelated pieces sharing four long
    // words outranked a story six outlets actually covered. A real one needs a
    // cluster id and the cluster's own counts on the DTO.
    expect(SORT_KEYS).not.toContain("most-covered");
    expect([...SORT_KEYS]).toEqual(["newest", "oldest", "ph-high", "ph-low", "source"]);
  });

  it("is stable: sorting twice gives the same order", () => {
    seq = 0;
    const rows = feed(120);
    expect(applySort(rows, "newest").map((a) => a.id)).toEqual(applySort(rows, "newest").map((a) => a.id));
    expect(applySort(rows, "ph-high").map((a) => a.id)).toEqual(applySort(rows, "ph-high").map((a) => a.id));
  });

  it("never drops or duplicates a row", () => {
    seq = 0;
    const rows = feed(300);
    for (const s of SORT_KEYS) {
      const out = applySort(rows, s);
      expect(out, s).toHaveLength(300);
      expect(new Set(out.map((a) => a.id)).size, s).toBe(300);
    }
  });

  it("does not mutate its input", () => {
    seq = 0;
    const rows = feed(10);
    const before = rows.map((a) => a.id);
    applySort(rows, "ph-high");
    expect(rows.map((a) => a.id)).toEqual(before);
  });
});

// The merge the Load More handler performs. Reproduced here because it is the
// step where a paging bug becomes a visible duplicate.
function mergePages(prev: ArticleSummaryDTO[], next: ArticleSummaryDTO[]): ArticleSummaryDTO[] {
  const seen = new Set(prev.map((a) => a.id));
  return [...prev, ...next.filter((a) => !seen.has(a.id))];
}

describe("paging merge", () => {
  it("appends a clean second page whole", () => {
    seq = 0;
    const p1 = feed(50);
    const p2 = feed(50);
    expect(mergePages(p1, p2)).toHaveLength(100);
  });

  it("drops an overlapping row rather than showing it twice", () => {
    seq = 0;
    const p1 = feed(50);
    const p2 = [p1[49]!, ...feed(49)];
    const merged = mergePages(p1, p2);
    expect(merged).toHaveLength(99);
    expect(new Set(merged.map((a) => a.id)).size).toBe(99);
  });

  it("survives a fully duplicate page", () => {
    seq = 0;
    const p1 = feed(50);
    expect(mergePages(p1, p1)).toHaveLength(50);
  });

  it("preserves order across the join", () => {
    seq = 0;
    const p1 = feed(3);
    const p2 = feed(3);
    expect(mergePages(p1, p2).map((a) => a.id)).toEqual([...p1, ...p2].map((a) => a.id));
  });
});

describe("a malformed composite reaches the filters and the sorts", () => {
  // These rows are what a corrupt snapshot row looks like on the way into the
  // page. None of them may be treated as a band.
  const malformed = () => [
    article({ composite: NaN as unknown as number }),
    article({ composite: Infinity as unknown as number }),
    article({ composite: "2.0" as unknown as number }),
    article({ composite: 7.2 }),
    article({ composite: null }),
  ];

  it("matches no band filter, including the calmest one", () => {
    const rows = malformed();
    for (const band of ["Proportionate", "Grounded", "Mixed Signals", "Running Hot", "Hyperbolic"]) {
      expect(applyFilters(rows, { ...NO_FILTERS, band }), band).toHaveLength(0);
    }
  });

  it("is reachable through the explicit Not rated filter", () => {
    // Unreachable data is its own kind of dishonesty: the count says 152 and
    // five of them can be found under no filter at all.
    expect(applyFilters(malformed(), { ...NO_FILTERS, band: "Not rated" })).toHaveLength(5);
  });

  it("sorts to the end in both P/H directions rather than to either extreme", () => {
    seq = 0;
    const good = [article({ composite: 1.1 }), article({ composite: 4.9 })];
    const rows = [...malformed(), ...good];
    const low = applySort(rows, "ph-low");
    const high = applySort(rows, "ph-high");
    expect(low[0]!.score?.composite).toBe(1.1);
    expect(high[0]!.score?.composite).toBe(4.9);
    // And every malformed row is behind both good ones, either way round.
    expect(low.slice(0, 2).map((a) => a.score?.composite)).toEqual([1.1, 4.9]);
    expect(high.slice(0, 2).map((a) => a.score?.composite)).toEqual([4.9, 1.1]);
  });

  it("still counts, so the edition total stays true", () => {
    const rows = [...malformed(), article({ composite: 2.0 })];
    expect(applyFilters(rows, NO_FILTERS)).toHaveLength(6);
  });

  it("does not crash any filter", () => {
    const rows = malformed();
    for (const f of [
      { ...NO_FILTERS, framing: "Center" },
      { ...NO_FILTERS, baseline: "center" },
      { ...NO_FILTERS, section: "Politics" },
      { ...NO_FILTERS, paywall: "open" as const },
    ]) {
      expect(() => applyFilters(rows, f)).not.toThrow();
    }
  });
});
