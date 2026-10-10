// Claim receipts: the smallest honest unit under "The Facts".
//
// A receipt is one atomic claim plus the articles that carry it. Status is
// earned, never asserted:
//   confirmed  — two independent reporting sources (different publishers), or
//                one identifiable primary source (a filing, a docket, an
//                official statement the outlet points at).
//   contested  — outlets are in genuine conflict; both positions survive, with
//                their sources attached.
//   unknown    — the local evidence does not reach either bar. This is an
//                honest state, not a failure.
//
// What is NOT evidence: the model-written article summary, the P/H composite,
// the political-lean number, the cluster topic line. Those are generated fields.
// A receipt cites articles — id, url, publisher, date — and nothing else.
//
// Legal posture (the excerpt policy): receipts never reproduce article text.
// Claim wording is LITMUS's own, and the reader is routed to the source link.
// Paywalled sources are marked and linked, never quoted.

export type ClaimStatus = "confirmed" | "contested" | "unknown";

// "reporting" = an outlet's own account. "primary" = the outlet identifies a
// primary record (court filing, official statement, filed paperwork).
export type SourceKind = "reporting" | "primary";

export interface ClaimSourceRef {
  articleId: number;
  url: string;
  publisher: string;
  publishedAt: string | null;
  kind: SourceKind;
  paywalled?: boolean;
  // What this source is cited FOR — LITMUS's own words, not the article's.
  supports: string;
}

export interface ClaimPosition {
  // One side of a dispute, in LITMUS's words.
  statement: string;
  sources: ClaimSourceRef[];
}

export interface ClaimReceipt {
  id: string;
  clusterId: number;
  claim: string;
  status: ClaimStatus;
  // Confirmed/unknown claims cite here. Contested claims leave this empty and
  // use positions instead.
  sources: ClaimSourceRef[];
  // Required for contested: two or more conflicting positions with their own
  // sources. The disagreement is the finding; it is not resolved for the reader.
  positions?: ClaimPosition[];
  // Why a claim is unknown, in one line. Shown verbatim.
  note?: string;
}

export interface ClaimReceiptFile {
  schemaVersion: number;
  // Free text describing where these receipts came from. Rendered nowhere;
  // it exists so the file cannot be mistaken for pipeline output.
  provenance: string;
  receipts: ClaimReceipt[];
}

export const CLAIM_SCHEMA_VERSION = 1;

const isHttpUrl = (u: unknown): u is string => {
  if (typeof u !== "string") return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

function validSource(s: unknown): s is ClaimSourceRef {
  if (!s || typeof s !== "object") return false;
  const r = s as Partial<ClaimSourceRef>;
  return (
    typeof r.articleId === "number" &&
    Number.isFinite(r.articleId) &&
    isHttpUrl(r.url) &&
    typeof r.publisher === "string" &&
    r.publisher.trim().length > 0 &&
    (r.publishedAt === null || typeof r.publishedAt === "string") &&
    (r.kind === "reporting" || r.kind === "primary") &&
    typeof r.supports === "string" &&
    r.supports.trim().length > 0
  );
}

// Two sources are independent when they are different publishers AND different
// articles. Two pieces from the same outlet corroborate nothing.
export function independentPublishers(sources: ClaimSourceRef[]): number {
  return new Set(sources.filter((s) => s.kind === "reporting").map((s) => s.publisher.trim().toLowerCase())).size;
}

export function meetsConfirmedBar(sources: ClaimSourceRef[]): boolean {
  if (sources.some((s) => s.kind === "primary")) return true;
  return independentPublishers(sources) >= 2;
}

// The render-time gate. A receipt that fails structural validation is dropped;
// a receipt that CLAIMS "confirmed" without the evidence to back it is not
// dropped — it is downgraded to unknown and says so. Silently hiding an
// overclaim would let the same mistake ship again unnoticed.
export function normalizeReceipt(raw: unknown): ClaimReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ClaimReceipt>;
  if (typeof r.id !== "string" || r.id.trim() === "") return null;
  if (typeof r.clusterId !== "number" || !Number.isFinite(r.clusterId)) return null;
  if (typeof r.claim !== "string" || r.claim.trim() === "") return null;
  if (r.status !== "confirmed" && r.status !== "contested" && r.status !== "unknown") return null;

  const sources = Array.isArray(r.sources) ? r.sources.filter(validSource) : [];

  if (r.status === "contested") {
    const positions = (Array.isArray(r.positions) ? r.positions : [])
      .filter((p): p is ClaimPosition => {
        if (!p || typeof p !== "object") return false;
        const pos = p as Partial<ClaimPosition>;
        if (typeof pos.statement !== "string" || pos.statement.trim() === "") return false;
        return Array.isArray(pos.sources) && pos.sources.filter(validSource).length > 0;
      })
      .map((p) => ({ statement: p.statement, sources: p.sources.filter(validSource) }));
    // A "dispute" with fewer than two sourced sides is not a dispute.
    if (positions.length < 2) {
      return {
        id: r.id,
        clusterId: r.clusterId,
        claim: r.claim,
        status: "unknown",
        sources,
        note: "Recorded as contested, but the conflicting positions are not both sourced here.",
      };
    }
    return { id: r.id, clusterId: r.clusterId, claim: r.claim, status: "contested", sources: [], positions, ...(r.note ? { note: r.note } : {}) };
  }

  if (r.status === "confirmed" && !meetsConfirmedBar(sources)) {
    return {
      id: r.id,
      clusterId: r.clusterId,
      claim: r.claim,
      status: "unknown",
      sources,
      note: "Only one source in this edition carries this claim, so it is not marked confirmed.",
    };
  }

  return {
    id: r.id,
    clusterId: r.clusterId,
    claim: r.claim,
    status: r.status,
    sources,
    ...(r.note ? { note: r.note } : {}),
  };
}

export function loadReceiptsForCluster(file: unknown, clusterId: number): ClaimReceipt[] {
  if (!file || typeof file !== "object") return [];
  const f = file as Partial<ClaimReceiptFile>;
  if (f.schemaVersion !== CLAIM_SCHEMA_VERSION) return [];
  if (!Array.isArray(f.receipts)) return [];
  return f.receipts
    .map(normalizeReceipt)
    .filter((r): r is ClaimReceipt => r !== null && r.clusterId === clusterId);
}

// The identity of a story's actual member, for matching against a citation.
export interface StoryMember {
  id: number;
  url: string;
}

// Every citation a receipt makes, from both places it can make one — the
// (articleId, url) pair, not just the URL. A contested receipt carries
// `sources: []` and puts its citations under each position, so a check that
// only read `sources` treated every contested receipt as citing nothing — and
// the fix for showing the wrong receipts would have silently suppressed all
// the right contested ones.
export interface Citation {
  articleId: number;
  url: string;
}
export function citationsOf(r: ClaimReceipt): Citation[] {
  return [...r.sources, ...(r.positions ?? []).flatMap((p) => p.sources)].map((s) => ({
    articleId: s.articleId,
    url: s.url,
  }));
}

// The (articleId, canonical URL) pair, joined into one comparable key. See
// scripts/receiptIdentity.mjs — this is the client half of a policy that must
// stay identical to that file's, proven by the shared fixtures both sides run
// in their own tests (scripts/receipt-identity-fixtures.mjs).
function memberKey(articleId: number, url: string): string {
  return `${articleId} ${canonicalUrl(url)}`;
}

// Cluster ids are sequence numbers that every edition reuses, and the receipt
// file is hand-authored against ONE edition. Matching on the id alone published
// July's Strait-of-Hormuz receipts underneath an August story about a migrant
// crossing in Ceuta: same cluster id, entirely different story, and the page
// presented it as sourced fact.
//
// So the cluster id is necessary and not sufficient, and matching a citation
// on its URL alone (or its articleId alone) is not sufficient either. Each
// citation is checked against the (articleId, canonical URL) PAIR of an
// actual member — the exact bug this replaces is a member whose URL changed
// (cluster member {id:900, url:NEW}) while a receipt still cites the old
// address ({articleId:900, url:OLD}): an articleId-only check would have
// passed that, and a URL-only check (this function's own previous version)
// would have passed a receipt citing the right URL under a fabricated id. A
// receipt's claim is only supported by the articles it cites AT THAT EXACT
// PAIR; a receipt with any citation that does not resolve to one is a claim
// the reader cannot check, shown under a heading that says they can.
export function receiptsForStory(
  file: unknown,
  clusterId: number,
  members: readonly StoryMember[],
): ClaimReceipt[] {
  const candidates = loadReceiptsForCluster(file, clusterId);
  if (candidates.length === 0) return [];
  if (members.length === 0) return [];

  const memberKeys = new Set(members.map((m) => memberKey(m.id, m.url)));

  return candidates.filter((r) => {
    const cited = citationsOf(r);
    // A receipt citing nothing has nothing to validate against, so it cannot
    // be shown to belong to this story.
    if (cited.length === 0) return false;
    return cited.every((c) => memberKeys.has(memberKey(c.articleId, c.url)));
  });
}

// Parameters that identify a campaign rather than an article. Everything else
// is kept, because plenty of publishers put the article's identity in the query
// string — ?id=, ?storyId=, ?p= — and dropping the whole query would make two
// different articles from one site look like the same URL.
const TRACKING_PARAMS = new Set([
  "at_campaign",
  "at_custom1",
  "at_custom2",
  "at_custom3",
  "at_custom4",
  "at_medium",
  "cmpid",
  "ex_cid",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "mbid",
  "msclkid",
  "ncid",
  "partner",
  "smid",
  "smtyp",
  "twclid",
  "wtmc",
  "yclid",
]);

function isTracking(key: string): boolean {
  const k = key.toLowerCase();
  return TRACKING_PARAMS.has(k) || k.startsWith("utm_");
}

// Host, port, path, and the identity-bearing part of the query. The same
// article reaches a feed and a snapshot with different campaign tags, and a
// receipt should not be discarded over "?at_medium=RSS" — but it must also not
// match a different article that differs only by "?id=".
//
// DECISION: scheme (http vs https) is NOT included and is therefore NOT
// identity-bearing — an outlet migrating a whole site from http to https over
// time is normal and does not make the article a different one. See the
// "scheme is not identity-bearing" case in
// scripts/receipt-identity-fixtures.mjs, which pins this as a decision rather
// than an oversight.
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    // Re-encode each key and value before joining. Joining decoded pairs with
    // "=" and "&" loses the difference between a delimiter and a literal: the
    // single parameter a="x&b=y" and the two parameters a=x, b=y both decode to
    // the same "a=x&b=y" string, so two different URLs would canonicalise
    // identically and a receipt could be admitted against the wrong article.
    const kept = [...u.searchParams.entries()]
      .filter(([k]) => !isTracking(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    // A non-default port is part of the address. Two services on one host are
    // two different origins, and dropping the port merges them.
    const port = u.port && u.port !== defaultPort(u.protocol) ? `:${u.port}` : "";
    const path = u.pathname.replace(/\/$/, "");
    return kept ? `${host}${port}${path}?${kept}` : `${host}${port}${path}`;
  } catch {
    return url;
  }
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}
