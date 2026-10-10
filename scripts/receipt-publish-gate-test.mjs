// The publication half of receipt containment.
//
//   node scripts/receipt-publish-gate-test.mjs
//
// The client refuses to RENDER a receipt whose citations do not match the
// story. This asserts the edition is refused PUBLICATION in the same case,
// which is a different guarantee: one stops a reader seeing it, the other
// stops a known-wrong edition shipping at all.
//
// Matching is on the (articleId, canonical URL) PAIR, via
// scripts/receiptIdentity.mjs — the same policy the client applies, proven by
// the shared fixture block at the bottom of this file. articleId-only
// membership (an earlier version of this gate) is not enough: verify-edition.mjs
// already confirmed every cited article exists somewhere in the snapshot and
// that its publisher and URL match, and all of those passed on 2026-08-03,
// when July's Strait-of-Hormuz receipts shipped under an August story about
// Ceuta. The cited articles were real. They were simply not in that cluster.
// URL-only matching has the opposite failure: a member whose url changes (a
// redirect fixed, a headline corrected) would still validate a receipt citing
// the old address if only the id were checked, or a receipt citing the right
// url under a fabricated id if only the url were checked. Neither field alone
// is the identity; the pair is.

import { reasonsNotToPublish, receiptBlockers } from "./edition-manifest.mjs";
import { CASES as IDENTITY_FIXTURES } from "./receipt-identity-fixtures.mjs";

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

function snapshotWith(clusterArticles) {
  return {
    edition: {
      schemaVersion: 1,
      buildCompletedAt: "2026-09-02T00:00:00.000Z",
      sourceLatestFetchAt: "2026-09-02T00:00:00.000Z",
    },
    articles: [{ id: 1 }],
    articleDetail: { 1: { id: 1 } },
    sections: [{ slug: "world" }],
    section: { world: {} },
    sources: [{ id: 1, name: "A" }],
    clusters: Object.keys(clusterArticles).map((id) => ({ id: Number(id) })),
    clusterArticles,
  };
}

const src = (articleId, url = `https://example.com/${articleId}`) => ({
  articleId,
  url,
  publisher: "A",
  publishedAt: null,
  kind: "reporting",
  supports: "x",
});
const member = (id, url = `https://example.com/${id}`) => ({ id, url });

// Cluster 18 holds the August Ceuta story: articles 900 and 901.
const ceuta = snapshotWith({ 18: [member(900), member(901)] });

// A receipt written for July's cluster 18, citing the Hormuz articles.
const hormuzReceipts = {
  schemaVersion: 1,
  receipts: [{ id: "hormuz-1", clusterId: 18, claim: "…", status: "confirmed", sources: [src(700), src(701)] }],
};

{
  const reasons = receiptBlockers(ceuta, hormuzReceipts);
  check(reasons.length > 0, "the Ceuta/Hormuz mismatch blocks publication", reasons[0] ?? "");
  check(
    /not a member of cluster 18/.test(reasons[0] ?? ""),
    "the blocker names the cluster and the stray citations",
  );
}

{
  const good = { schemaVersion: 1, receipts: [{ id: "ok", clusterId: 18, claim: "…", status: "confirmed", sources: [src(900), src(901)] }] };
  check(receiptBlockers(ceuta, good).length === 0, "a receipt whose sources are all members publishes");
}

// The decisive regression: a member whose URL changed must not let a receipt
// still citing the OLD url ride through on a matching articleId. This is the
// gap articleId-only membership (the version this replaces) had.
{
  const staleUrl = snapshotWith({ 18: [member(900, "https://example.com/a-new-headline")] });
  const citingOld = {
    schemaVersion: 1,
    receipts: [{ id: "stale", clusterId: 18, claim: "…", status: "confirmed", sources: [src(900, "https://example.com/a-old-headline")] }],
  };
  const reasons = receiptBlockers(staleUrl, citingOld);
  check(reasons.length > 0, "DECISIVE: right articleId, stale url — publication is blocked", reasons[0] ?? "");
}

// The inverse: right url, fabricated articleId must also block.
{
  const wrongId = {
    schemaVersion: 1,
    receipts: [{ id: "wrong-id", clusterId: 18, claim: "…", status: "confirmed", sources: [src(999, "https://example.com/900")] }],
  };
  const reasons = receiptBlockers(ceuta, wrongId);
  check(reasons.length > 0, "right url, fabricated articleId is also blocked", reasons[0] ?? "");
}

{
  // Partial membership is still a blocker: 900 is in the cluster, 700 is not.
  const partial = { schemaVersion: 1, receipts: [{ id: "half", clusterId: 18, claim: "…", status: "confirmed", sources: [src(900), src(700)] }] };
  const reasons = receiptBlockers(ceuta, partial);
  check(reasons.length > 0, "partial membership blocks publication", reasons[0] ?? "");
}

{
  // Contested receipts cite through positions, which the gate must read too.
  const contested = {
    schemaVersion: 1,
    receipts: [
      {
        id: "contested",
        clusterId: 18,
        claim: "…",
        status: "contested",
        sources: [],
        positions: [
          { statement: "one", sources: [src(900)] },
          { statement: "two", sources: [src(700)] },
        ],
      },
    ],
  };
  const reasons = receiptBlockers(ceuta, contested);
  check(reasons.length > 0, "a contested receipt's positions are checked too", reasons[0] ?? "");
}

{
  // A receipt for a cluster this edition does not carry is NOT applicable, and
  // not a blocker. The client refuses to render it, and failing the whole
  // publication over a stale optional annotation would take the paper down on a
  // quiet news day — an edition with no clusters is explicitly legal. The
  // verifier's empty-clusters fixture is what caught the first version being
  // too strict here.
  const orphan = { schemaVersion: 1, receipts: [{ id: "orphan", clusterId: 99, claim: "…", status: "confirmed", sources: [src(900)] }] };
  check(receiptBlockers(ceuta, orphan).length === 0, "a receipt for an absent cluster does not block the edition");
  check(
    receiptBlockers(snapshotWith({}), hormuzReceipts).length === 0,
    "an edition with no clusters at all still publishes",
  );
}

{
  check(receiptBlockers(ceuta, null).length === 0, "no receipts file is not an error");
  check(receiptBlockers(ceuta, { schemaVersion: 1, receipts: [] }).length === 0, "an empty receipts file is not an error");
}

{
  // A receipt citing nothing never reaches a reader (claims.test.ts covers
  // that), but it is deliberately NOT a publish blocker either: there is
  // nothing to check, the same principle as a receipt for an absent cluster
  // above. This is where the gate and the client answer different questions
  // and correctly diverge — not a shared fixture case.
  const empty = { schemaVersion: 1, receipts: [{ id: "empty", clusterId: 18, claim: "…", status: "confirmed", sources: [] }] };
  check(receiptBlockers(ceuta, empty).length === 0, "a receipt citing nothing does not block publication");
}

// Query-delimiter collision, carried through from the client's coverage: an
// escaped ?a=x%26b%3Dy must not match the two real params ?a=x&b=y.
{
  const withEscaped = snapshotWith({ 18: [member(900, "https://example.com/a?a=x&b=y")] });
  const citingEscaped = {
    schemaVersion: 1,
    receipts: [{ id: "escaped", clusterId: 18, claim: "…", status: "confirmed", sources: [src(900, "https://example.com/a?a=x%26b%3Dy")] }],
  };
  check(receiptBlockers(withEscaped, citingEscaped).length > 0, "an escaped delimiter does not match the real params it would decode to");
}

// And the gate is actually wired into the publish decision, not merely exported.
{
  const reasons = reasonsNotToPublish(ceuta, {
    expectedSections: ["world"],
    failedEndpoints: [],
    receipts: hormuzReceipts,
  });
  check(
    reasons.some((r) => /not a member of cluster 18/.test(r)),
    "reasonsNotToPublish surfaces the receipt blocker",
    reasons.find((r) => /cluster/.test(r)) ?? reasons.join("; "),
  );

  const clean = reasonsNotToPublish(ceuta, {
    expectedSections: ["world"],
    failedEndpoints: [],
    receipts: { schemaVersion: 1, receipts: [{ id: "ok", clusterId: 18, claim: "…", status: "confirmed", sources: [src(900)] }] },
  });
  check(clean.length === 0, "an edition with correct receipts is publishable", clean.join("; "));
}

// The parity proof. litmus-client/src/lib/claims.test.ts runs its own
// implementation against this SAME list. If the two ever disagree, one side's
// assertions fail against a case the other side already passes.
{
  for (const c of IDENTITY_FIXTURES) {
    const snapshot = snapshotWith({ 1: c.members.map((m) => member(m.id, m.url)) });
    const file = {
      schemaVersion: 1,
      receipts: [
        {
          id: "fixture",
          clusterId: 1,
          claim: "…",
          status: "confirmed",
          sources: c.citations.map((cit) => src(cit.articleId, cit.url)),
        },
      ],
    };
    const blocked = receiptBlockers(snapshot, file).length > 0;
    check(blocked === !c.expect, `[fixture] ${c.name}`, blocked === !c.expect ? "" : `expected pass=${c.expect}, gate blocked=${blocked}`);
  }
}

console.log(
  failures.length === 0
    ? "\nPUBLISH GATE HOLDS: an edition whose receipts do not belong to their stories is refused.\n"
    : `\nPUBLISH GATE LEAKS — ${failures.length} failure(s).\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
