// Golden fixture cases for receipt identity, consumed by BOTH implementations:
// litmus-client/src/lib/claims.test.ts (the TypeScript/client half) and
// scripts/receipt-publish-gate-test.mjs (the plain-node/gate half). Each case
// names members (the cluster's actual articles) and citations (what a receipt
// cites), and the verdict every correct implementation must produce. If the
// two implementations ever disagree, one of their tests fails against this
// same list — that is the parity proof, since they cannot literally share a
// runtime import across the Vite/plain-node boundary (see
// scripts/receiptIdentity.mjs's header for why).
//
// Plain data only: no imports, so both sides can load it however suits their
// module system (litmus-client via its own copy — see the note in
// claims.test.ts — and the gate via a direct import).

export const CASES = [
  {
    name: "valid: citation matches a member exactly",
    members: [{ id: 900, url: "https://example.com/a" }],
    citations: [{ articleId: 900, url: "https://example.com/a" }],
    expect: true,
  },
  {
    name: "the decisive regression: right articleId, WRONG (stale) url must block",
    members: [{ id: 900, url: "https://example.com/a-new-headline" }],
    citations: [{ articleId: 900, url: "https://example.com/a-old-headline" }],
    expect: false,
  },
  {
    name: "right url, WRONG articleId must also block (not either field alone)",
    members: [{ id: 900, url: "https://example.com/a" }],
    citations: [{ articleId: 901, url: "https://example.com/a" }],
    expect: false,
  },
  {
    name: "partial: one citation matches, one does not",
    members: [{ id: 900, url: "https://example.com/a" }],
    citations: [
      { articleId: 900, url: "https://example.com/a" },
      { articleId: 700, url: "https://example.com/hormuz" },
    ],
    expect: false,
  },
  {
    name: "contested: both positions' citations must be members",
    members: [
      { id: 900, url: "https://example.com/a" },
      { id: 901, url: "https://example.com/b" },
    ],
    citations: [
      { articleId: 900, url: "https://example.com/a" },
      { articleId: 901, url: "https://example.com/b" },
    ],
    expect: true,
  },
  {
    name: "contested: one position cites a non-member",
    members: [{ id: 900, url: "https://example.com/a" }],
    citations: [
      { articleId: 900, url: "https://example.com/a" },
      { articleId: 701, url: "https://example.com/hormuz-2" },
    ],
    expect: false,
  },
  {
    name: "the live Ceuta/Hormuz case: cluster 18's real members, receipts citing Hormuz articles",
    members: [
      { id: 900, url: "https://example.com/ceuta-1" },
      { id: 901, url: "https://example.com/ceuta-2" },
    ],
    citations: [
      { articleId: 700, url: "https://example.com/hormuz-1" },
      { articleId: 701, url: "https://example.com/hormuz-2" },
    ],
    expect: false,
  },
  {
    name: "absent cluster: no members at all",
    members: [],
    citations: [{ articleId: 900, url: "https://example.com/a" }],
    expect: false,
  },
  // "Empty citations" is deliberately NOT a shared case: the client's
  // receiptsForStory and the gate's receiptBlockers agree on the OUTCOME (a
  // receipt citing nothing never reaches a reader) but for different reasons
  // that are each correct for the question their function answers —
  // receiptsForStory asks "should this receipt render" (no), receiptBlockers
  // asks "should this REASON block the whole edition" (no, there is nothing
  // to check, same principle as a receipt for an absent cluster). Each file
  // tests this on its own rather than forcing one shared verdict on two
  // different questions.
  {
    name: "query-delimiter collision: an escaped ?a=x%26b%3Dy must NOT match the two real params ?a=x&b=y",
    members: [{ id: 900, url: "https://example.com/a?a=x&b=y" }],
    citations: [{ articleId: 900, url: "https://example.com/a?a=x%26b%3Dy" }],
    expect: false,
  },
  {
    name: "query-delimiter: the correctly-escaped form matches itself",
    members: [{ id: 900, url: "https://example.com/a?a=x%26b%3Dy" }],
    citations: [{ articleId: 900, url: "https://example.com/a?a=x%26b%3Dy" }],
    expect: true,
  },
  {
    name: "non-default port is identity-bearing: :8443 does not match the default port",
    members: [{ id: 900, url: "https://example.com/a" }],
    citations: [{ articleId: 900, url: "https://example.com:8443/a" }],
    expect: false,
  },
  {
    name: "non-default port: matches when both sides carry it",
    members: [{ id: 900, url: "https://example.com:8443/a" }],
    citations: [{ articleId: 900, url: "https://example.com:8443/a" }],
    expect: true,
  },
  {
    name: "tracking params are stripped: utm_source and at_medium do not break a match",
    members: [{ id: 900, url: "https://example.com/a" }],
    citations: [{ articleId: 900, url: "https://www.example.com/a?utm_source=x&at_medium=RSS&fbclid=abc" }],
    expect: true,
  },
  {
    name: "DECISION: scheme is NOT identity-bearing — http and https forms of the same address match",
    members: [{ id: 900, url: "http://example.com/a" }],
    citations: [{ articleId: 900, url: "https://example.com/a" }],
    expect: true,
  },
];
