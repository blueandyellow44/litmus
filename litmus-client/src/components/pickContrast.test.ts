import { describe, it, expect } from "vitest";
import { pickContrast } from "./StorySpread.tsx";
import type { SectionArticleDTO, Lean } from "../lib/types.ts";

// Decision 2 (Max, 2026-09-02, reaffirming 5cc1568): the featured pair contrasts
// P/H TEMPERATURE. It does not promise political breadth, and political lean
// must never select the pair or break a tie for it.
//
// The counterfactual below is the test that matters. Selection is run over every
// permutation of lean labels across the same articles; if lean has any influence
// at all, some permutation changes the answer.

const LEANS: Lean[] = ["left", "center-left", "center", "center-right", "right"];

// sourceId defaults to the article's own id — every fixture article is from
// its own outlet unless a test deliberately collides two ids onto one source,
// which is what the same-source tests below do on purpose.
function article(over: Partial<SectionArticleDTO> & { id: number }): SectionArticleDTO {
  return {
    sourceId: over.id,
    sourceName: `Outlet ${over.id}`,
    sourceLean: "center",
    politicalLean: 0,
    composite: 2,
    label: "Grounded",
    title: `Story ${over.id}`,
    url: `https://example.com/${over.id}`,
    excerpt: { paragraphs: ["Body text."], markers: [] },
    ...over,
  } as SectionArticleDTO;
}

// Every assignment of leans to n articles: 5^n cases.
function leanPermutations(n: number): Lean[][] {
  if (n === 0) return [[]];
  return leanPermutations(n - 1).flatMap((rest) => LEANS.map((l): Lean[] => [l, ...rest]));
}

describe("pickContrast selects on temperature alone", () => {
  it("pairs the coolest with the hottest", () => {
    const out = pickContrast([
      article({ id: 1, composite: 2.5 }),
      article({ id: 2, composite: 1.1 }),
      article({ id: 3, composite: 4.7 }),
    ]);
    expect(out?.left.id).toBe(2);
    expect(out?.right.id).toBe(3);
  });

  it("COUNTERFACTUAL: no permutation of lean labels changes the pair", () => {
    const base = [
      article({ id: 1, composite: 2.5 }),
      article({ id: 2, composite: 1.1 }),
      article({ id: 3, composite: 4.7 }),
    ];
    const expected = pickContrast(base);
    expect(expected).not.toBeNull();

    const permutations = leanPermutations(base.length);
    expect(permutations).toHaveLength(125);

    for (const leans of permutations) {
      const permuted: SectionArticleDTO[] = base.map((a, i) => ({ ...a, sourceLean: leans[i]! }));
      const got = pickContrast(permuted);
      expect(
        { left: got?.left.id, right: got?.right.id },
        `lean assignment ${leans.join(",")} changed the pair`,
      ).toEqual({ left: expected!.left.id, right: expected!.right.id });
    }
  });

  it("COUNTERFACTUAL: lean cannot break a tie either", () => {
    // Every article at the same temperature is where a lean tie-break used to
    // decide the answer, so this is the case that would catch it coming back.
    const tied = [
      article({ id: 7, composite: 1.9 }),
      article({ id: 8, composite: 1.9 }),
      article({ id: 9, composite: 1.9 }),
    ];
    const expected = pickContrast(tied);
    expect(expected?.left.id).toBe(7);
    expect(expected?.right.id).toBe(9);

    for (const leans of leanPermutations(tied.length)) {
      const permuted: SectionArticleDTO[] = tied.map((a, i) => ({ ...a, sourceLean: leans[i]! }));
      const got = pickContrast(permuted);
      expect(
        { left: got?.left.id, right: got?.right.id },
        `lean assignment ${leans.join(",")} broke the tie differently`,
      ).toEqual({ left: 7, right: 9 });
    }
  });

  it("still returns two distinct articles when every score is identical", () => {
    // The failure this guards: min/max reducers over equal composites returned
    // the same article, the identity guard fired, and the feature rendered
    // nothing at all.
    const out = pickContrast([
      article({ id: 1, composite: 1.9 }),
      article({ id: 2, composite: 1.9 }),
    ]);
    expect(out).not.toBeNull();
    expect(out!.left.id).not.toBe(out!.right.id);
  });

  it("skips past a same-source coolest/hottest pair to the next-widest cross-source gap", () => {
    // id 1 and id 3 are the global coolest and hottest, but both are Outlet A —
    // pairing them would caption one outlet against itself. id 2 is the
    // widest-gap partner actually from a different source.
    const out = pickContrast([
      article({ id: 1, sourceId: 900, composite: 1.0 }),
      article({ id: 2, sourceId: 901, composite: 3.0 }),
      article({ id: 3, sourceId: 900, composite: 4.7 }),
    ]);
    expect(out?.left.id).toBe(1);
    expect(out?.right.id).toBe(2);
  });

  it("returns null when every usable article on the story shares one source", () => {
    const out = pickContrast([
      article({ id: 1, sourceId: 900, composite: 1.0 }),
      article({ id: 2, sourceId: 900, composite: 4.7 }),
    ]);
    expect(out).toBeNull();
  });

  it("picks the widest cross-source gap, not merely the first cross-source pair found", () => {
    // Sorted by composite: 1(A) 2(A) 3(B) 4(A). The widest cross-source gap is
    // 1↔3 (2.6), not 2↔3 (1.6) or 1↔4 (2.9 — wait, 4 is A too, so 1↔4 is
    // same-source and skipped): the true widest cross-source gap here is 1↔3.
    const out = pickContrast([
      article({ id: 1, sourceId: 100, composite: 1.0 }),
      article({ id: 2, sourceId: 100, composite: 1.5 }),
      article({ id: 3, sourceId: 200, composite: 3.6 }),
      article({ id: 4, sourceId: 100, composite: 3.9 }),
    ]);
    expect(out?.left.id).toBe(1);
    expect(out?.right.id).toBe(3);
  });

  it("refuses to pair when fewer than two articles are usable", () => {
    expect(pickContrast([article({ id: 1, composite: 2 })])).toBeNull();
    expect(
      pickContrast([
        article({ id: 1, composite: null as unknown as number }),
        article({ id: 2, composite: 2 }),
      ]),
    ).toBeNull();
  });

  it("ignores articles with no excerpt, which would render an empty telling", () => {
    expect(
      pickContrast([
        article({ id: 1, composite: 1 }),
        article({ id: 2, composite: 5, excerpt: null as unknown as SectionArticleDTO["excerpt"] }),
      ]),
    ).toBeNull();
  });
});

// sourceLean is the OUTLET's editorial lean; politicalLean is the scorer's
// per-article read of how this piece framed this story. They are different
// fields and either could sneak into selection, so both are permuted —
// independently and together.
const POLITICAL = [-100, -40, 0, 40, 100];

function politicalPermutations(n: number): number[][] {
  if (n === 0) return [[]];
  return politicalPermutations(n - 1).flatMap((rest) => POLITICAL.map((p): number[] => [p, ...rest]));
}

describe("neither lean field can influence the temperature pair", () => {
  const base = [
    article({ id: 1, composite: 2.5 }),
    article({ id: 2, composite: 1.1 }),
    article({ id: 3, composite: 4.7 }),
  ];
  const tied = [
    article({ id: 7, composite: 1.9 }),
    article({ id: 8, composite: 1.9 }),
    article({ id: 9, composite: 1.9 }),
  ];

  it("COUNTERFACTUAL: politicalLean alone changes nothing", () => {
    for (const fixture of [base, tied]) {
      const expected = pickContrast(fixture);
      for (const leans of politicalPermutations(fixture.length)) {
        const permuted: SectionArticleDTO[] = fixture.map((a, i) => ({
          ...a,
          politicalLean: leans[i]!,
        }));
        const got = pickContrast(permuted);
        expect(
          { left: got?.left.id, right: got?.right.id },
          `politicalLean ${leans.join(",")} changed the pair`,
        ).toEqual({ left: expected!.left.id, right: expected!.right.id });
      }
    }
  });

  it("COUNTERFACTUAL: both lean fields together change nothing — full Cartesian product", () => {
    // Every source-lean assignment against EVERY political-lean assignment:
    // 125 x 125 = 15,625 cases per fixture. The previous version of this test
    // paired the two permutation lists index-wise (125 cases), which proves
    // the fields don't interact ALONG that one diagonal of the product but
    // says nothing about the other 15,500 combinations — sourceLean assignment
    // #3 was only ever tried against politicalLean assignment #3, never against
    // #1, #2, #4, or #5. sourceId is not permuted here: it is the field this
    // round of fixes made load-bearing (see the same-source tests above), so a
    // counterfactual sweep over it would be checking that it changes the
    // answer, not that it doesn't — the opposite of what this file verifies for
    // the two lean fields.
    for (const fixture of [base, tied]) {
      const expected = pickContrast(fixture);
      const sourceSets = leanPermutations(fixture.length);
      const politicalSets = politicalPermutations(fixture.length);
      for (const s of sourceSets) {
        for (const p of politicalSets) {
          const permuted: SectionArticleDTO[] = fixture.map((a, j) => ({
            ...a,
            sourceLean: s[j]!,
            politicalLean: p[j]!,
          }));
          const got = pickContrast(permuted);
          expect(
            { left: got?.left.id, right: got?.right.id },
            `sourceLean ${s.join(",")} + politicalLean ${p.join(",")} changed the pair`,
          ).toEqual({ left: expected!.left.id, right: expected!.right.id });
        }
      }
    }
  });
});
