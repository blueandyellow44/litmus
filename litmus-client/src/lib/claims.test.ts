import { describe, it, expect } from "vitest";
import { loadReceiptsForCluster, receiptsForStory, citationsOf, type StoryMember } from "./claims.ts";
import receiptsFile from "../demo/claim-receipts.json";
// The shared parity fixtures: scripts/receiptIdentity.mjs (the plain-node
// half, consumed by the publish gate) and this file's own hand-written
// canonicalUrl/memberKey (the TypeScript half, bundled for the browser)
// cannot share a runtime import across the Vite/plain-node boundary. Running
// BOTH implementations against this SAME list is the parity proof: if they
// ever disagree, one side's assertions here fail against a case the other
// side already passes. See scripts/receiptIdentity.mjs's header for the full
// reasoning, and keep any policy change in both files, in the same commit.
import { CASES as IDENTITY_FIXTURES } from "../../../scripts/receipt-identity-fixtures.mjs";

// The defect this guards: claim receipts were hand-authored against the
// 2026-07-11 edition and keyed only by cluster id. Cluster ids are reused every
// edition, so on 2026-08-03 the front page showed July's Strait-of-Hormuz
// receipts underneath an August story about a migrant crossing in Ceuta —
// presented as sourced fact under "The Facts".

const CLUSTER_WITH_RECEIPTS = 18;

function receipt(over: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    receipts: [
      {
        id: "r1",
        clusterId: 1,
        claim: "A claim",
        status: "confirmed",
        sources: [
          { articleId: 1, url: "https://a.example.com/one", publisher: "A", publishedAt: null, kind: "reporting", supports: "x" },
          { articleId: 2, url: "https://b.example.com/two", publisher: "B", publishedAt: null, kind: "reporting", supports: "x" },
        ],
        ...over,
      },
    ],
  };
}

const M = (id: number, url: string): StoryMember => ({ id, url });

describe("receiptsForStory — the original mismatch", () => {
  it("still finds the July receipts by id (the old, insufficient match)", () => {
    expect(loadReceiptsForCluster(receiptsFile, CLUSTER_WITH_RECEIPTS).length).toBeGreaterThan(0);
  });

  it("shows nothing when the story shares no article with the receipts (Ceuta/Hormuz)", () => {
    const augustCeutaStory: StoryMember[] = [
      M(9001, "https://www.reuters.com/world/europe/spain-ceuta-migrant-crossing-2026-08-02/"),
      M(9002, "https://apnews.com/article/spain-ceuta-migrants-abcdef"),
    ];
    expect(receiptsForStory(receiptsFile, CLUSTER_WITH_RECEIPTS, augustCeutaStory)).toEqual([]);
  });

  it("shows the real July receipts when the story is genuinely theirs", () => {
    const real = loadReceiptsForCluster(receiptsFile, CLUSTER_WITH_RECEIPTS);
    const everyCitation = real.flatMap(citationsOf);
    const asMembers: StoryMember[] = everyCitation.map((c) => ({ id: c.articleId, url: c.url }));
    const out = receiptsForStory(receiptsFile, CLUSTER_WITH_RECEIPTS, asMembers);
    expect(out.length).toBe(real.length);
  });

  it("fails closed on an empty story rather than showing unbound receipts", () => {
    expect(receiptsForStory(receiptsFile, CLUSTER_WITH_RECEIPTS, [])).toEqual([]);
  });
});

// The decisive regression named in the correction round: a cluster member
// whose URL was updated (a redirect fixed, a headline corrected) must not let
// a receipt still citing the OLD url ride through on a matching articleId.
describe("pair matching: articleId alone or url alone is not enough", () => {
  it("REFUSES when the member's url changed but the receipt cites the old one", () => {
    const cluster = [M(900, "https://example.com/a-new-headline")];
    const citingOld = receipt({
      sources: [
        { articleId: 900, url: "https://example.com/a-old-headline", publisher: "A", publishedAt: null, kind: "reporting", supports: "x" },
      ],
    });
    expect(receiptsForStory(citingOld, 1, cluster)).toEqual([]);
  });

  it("REFUSES when the url is right but the articleId is fabricated", () => {
    const cluster = [M(900, "https://example.com/a")];
    const wrongId = receipt({
      sources: [{ articleId: 999, url: "https://example.com/a", publisher: "A", publishedAt: null, kind: "reporting", supports: "x" }],
    });
    expect(receiptsForStory(wrongId, 1, cluster)).toEqual([]);
  });

  it("admits it once both articleId and url match the same member", () => {
    const cluster = [M(900, "https://example.com/a")];
    const correct = receipt({
      sources: [{ articleId: 900, url: "https://example.com/a", publisher: "A", publishedAt: null, kind: "reporting", supports: "x" }],
    });
    expect(receiptsForStory(correct, 1, cluster)).toHaveLength(1);
  });
});

describe("partial overlap is not enough", () => {
  it("REFUSES a receipt when only some of its sources are in the story", () => {
    expect(receiptsForStory(receipt(), 1, [M(1, "https://a.example.com/one")])).toEqual([]);
  });

  it("admits it once every source is present", () => {
    const out = receiptsForStory(receipt(), 1, [
      M(1, "https://a.example.com/one"),
      M(2, "https://b.example.com/two"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("REFUSES a receipt that cites nothing at all", () => {
    expect(receiptsForStory(receipt({ sources: [] }), 1, [M(1, "https://a.example.com/one")])).toEqual([]);
  });
});

// Contested receipts carry sources: [] and put their URLs under each position.
// A check that only read `sources` treated them as citing nothing, so the fix
// for the wrong receipts would have silently suppressed every right one.
describe("contested receipts cite through their positions", () => {
  const contested = receipt({
    status: "contested",
    sources: [],
    positions: [
      {
        statement: "Side one",
        sources: [{ articleId: 1, url: "https://a.example.com/one", publisher: "A", publishedAt: null, kind: "reporting", supports: "x" }],
      },
      {
        statement: "Side two",
        sources: [{ articleId: 2, url: "https://b.example.com/two", publisher: "B", publishedAt: null, kind: "reporting", supports: "x" }],
      },
    ],
  });

  it("collects citations from both positions", () => {
    const r = loadReceiptsForCluster(contested, 1)[0]!;
    expect(citationsOf(r).map((c) => c.url).sort()).toEqual([
      "https://a.example.com/one",
      "https://b.example.com/two",
    ]);
  });

  it("renders a valid contested receipt when both sides are in the story", () => {
    const out = receiptsForStory(contested, 1, [
      M(1, "https://a.example.com/one"),
      M(2, "https://b.example.com/two"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("REFUSES a contested receipt when only one side is present", () => {
    expect(receiptsForStory(contested, 1, [M(1, "https://a.example.com/one")])).toEqual([]);
  });
});

describe("URL matching keeps identity and drops campaigns", () => {
  it("matches across tracking parameters and www", () => {
    const out = receiptsForStory(receipt(), 1, [
      M(1, "https://www.a.example.com/one?at_medium=RSS&utm_source=x&fbclid=abc"),
      M(2, "https://b.example.com/two/"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("does NOT collapse two articles that differ only by an identity parameter", () => {
    const withQuery = receipt({
      sources: [
        { articleId: 1, url: "https://site.example.com/story?id=111", publisher: "A", publishedAt: null, kind: "reporting", supports: "x" },
      ],
    });
    // A different article from the same site, same path, different id.
    expect(receiptsForStory(withQuery, 1, [M(1, "https://site.example.com/story?id=222")])).toEqual([]);
    // The right one still matches, campaign tags and all.
    expect(
      receiptsForStory(withQuery, 1, [M(1, "https://site.example.com/story?id=111&utm_campaign=z")]),
    ).toHaveLength(1);
  });

  it("is order-insensitive across kept parameters", () => {
    const two = receipt({
      sources: [
        { articleId: 1, url: "https://s.example.com/a?b=2&a=1", publisher: "A", publishedAt: null, kind: "reporting", supports: "x" },
      ],
    });
    expect(receiptsForStory(two, 1, [M(1, "https://s.example.com/a?a=1&b=2")])).toHaveLength(1);
  });
});

// Canonicalisation collapses two URLs to one string, so any pair of DIFFERENT
// articles that collapse together is a receipt admitted against the wrong
// story. These are the collisions a naive join produces.
describe("canonicalisation does not collide", () => {
  function withUrl(url: string) {
    return receipt({
      sources: [{ articleId: 1, url, publisher: "A", publishedAt: null, kind: "reporting", supports: "x" }],
    });
  }

  it("does not equate an encoded delimiter with a real one", () => {
    const oneParam = "https://s.example.com/a?a=x%26b%3Dy";
    const twoParams = "https://s.example.com/a?a=x&b=y";
    expect(receiptsForStory(withUrl(oneParam), 1, [M(1, twoParams)])).toEqual([]);
    expect(receiptsForStory(withUrl(twoParams), 1, [M(1, oneParam)])).toEqual([]);
    expect(receiptsForStory(withUrl(oneParam), 1, [M(1, oneParam)])).toHaveLength(1);
    expect(receiptsForStory(withUrl(twoParams), 1, [M(1, twoParams)])).toHaveLength(1);
  });

  it("keeps a non-default port, which is part of the address", () => {
    expect(receiptsForStory(withUrl("https://s.example.com:8443/a"), 1, [M(1, "https://s.example.com/a")])).toEqual([]);
    expect(
      receiptsForStory(withUrl("https://s.example.com:8443/a"), 1, [M(1, "https://s.example.com:8443/a")]),
    ).toHaveLength(1);
  });

  it("treats an explicit default port as the same address", () => {
    expect(receiptsForStory(withUrl("https://s.example.com:443/a"), 1, [M(1, "https://s.example.com/a")])).toHaveLength(1);
  });

  it("DECISION: does not treat scheme as identity-bearing", () => {
    expect(receiptsForStory(withUrl("http://s.example.com/a"), 1, [M(1, "https://s.example.com/a")])).toHaveLength(1);
  });
});

// The parity proof. Both scripts/receiptIdentity.mjs (run by
// receipt-publish-gate-test.mjs) and this file's implementation must produce
// the SAME verdict for every one of these hand-authored cases, including the
// decisive regression and the query-delimiter collision.
describe("parity with the publish gate's shared fixtures", () => {
  for (const c of IDENTITY_FIXTURES) {
    it(c.name, () => {
      const file = receipt({
        sources: c.citations.map((cit: { articleId: number; url: string }) => ({
          articleId: cit.articleId,
          url: cit.url,
          publisher: "A",
          publishedAt: null,
          kind: "reporting",
          supports: "x",
        })),
      });
      const members: StoryMember[] = c.members.map((m: { id: number; url: string }) => ({ id: m.id, url: m.url }));
      const out = receiptsForStory(file, 1, members);
      expect(out.length === 1).toBe(c.expect);
    });
  }
});
