// The edition manifest: the persisted evidence that says WHEN this paper was
// compiled and how recent its content actually is. The masthead reads this
// instead of the browser clock, so a stale bundle can never present itself as
// today's paper.
//
// No npm dependencies, Node 18+. Imported by scripts/build-snapshot.mjs
// (writes the manifest) and scripts/verify-edition.mjs (checks it).
//
// SHARED INVARIANT — the freshness rules here are mirrored in
// litmus-client/src/lib/edition.ts, which is what the browser actually runs.
// Change one, change both. STALE_AFTER_HOURS is drift-checked by the verifier.

import { citationsOf, allCitationsAreMembers, memberKey } from "./receiptIdentity.mjs";

export const EDITION_SCHEMA_VERSION = 1;

// A once-a-day paper (5:15 AM Pacific, .github/workflows/daily.yml, since
// 2026-09-22) that has gone 30 hours without a successful rebuild has missed
// its expected edition, and the reader is told so. 30, not 24: GitHub's
// scheduled runs start late (the 2026-09-22 morning run started 4h42m after
// its cron time), and a paper that was on time must not read "stale" while
// the next one is still queued. A missed edition must never sit behind a
// "fresh" label for a day and a half. Was 18 while the paper ran twice a day.
export const STALE_AFTER_HOURS = 30;

// Clock skew allowance. A timestamp further in the future than this is treated
// as broken evidence, not as a very fresh edition.
export const FUTURE_TOLERANCE_MINUTES = 5;

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Strict: only a real ISO-8601 instant counts as evidence. Date.parse() alone
// accepts "" in some engines and a pile of ambiguous formats in all of them.
export function parseInstant(value) {
  if (typeof value !== "string" || !ISO_LIKE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Latest moment any article in this snapshot was actually fetched from a
// source. This is the honest "content cutoff" — it comes from the data, not
// from whenever the build happened to run.
export function latestSourceFetch(snapshot) {
  let latest = null;
  const consider = (v) => {
    const ms = parseInstant(v);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  };
  for (const a of snapshot?.articles ?? []) consider(a?.fetchedAt);
  for (const a of Object.values(snapshot?.articleDetail ?? {})) consider(a?.fetchedAt);
  return latest === null ? null : new Date(latest).toISOString();
}

// Build the manifest from the snapshot that is about to be written. Every field
// is derived from persisted data or from the build clock at write time.
export function deriveEdition(snapshot, { buildCompletedAt }) {
  const sectionPages = Object.keys(snapshot?.section ?? {});
  return {
    schemaVersion: EDITION_SCHEMA_VERSION,
    buildCompletedAt,
    sourceLatestFetchAt: latestSourceFetch(snapshot),
    articleCount: (snapshot?.articles ?? []).length,
    articleDetailCount: Object.keys(snapshot?.articleDetail ?? {}).length,
    clusterCount: (snapshot?.clusters ?? []).length,
    sectionCount: (snapshot?.sections ?? []).length,
    sectionPageCount: sectionPages.length,
    staleAfterHours: STALE_AFTER_HOURS,
  };
}

// The write gate. A build that produced anything less than a complete edition
// must not be allowed to replace a good one — the reader is better served by
// yesterday's honest paper than by a gutted one. The audit proved "non-empty"
// alone is not safety: a run where 7 of 8 section endpoints failed still
// produced a well-formed, nearly empty snapshot. Completeness is judged against
// what the build EXPECTED (context.expectedSections, context.failedEndpoints),
// not just against what it happened to get. Returns reasons; empty = publish.
export function reasonsNotToPublish(snapshot, context = {}) {
  const reasons = [];
  const e = snapshot?.edition;
  if (!e || typeof e !== "object") {
    reasons.push("no edition manifest on the snapshot");
  } else {
    if (e.schemaVersion !== EDITION_SCHEMA_VERSION) reasons.push(`edition.schemaVersion is not ${EDITION_SCHEMA_VERSION}`);
    if (parseInstant(e.buildCompletedAt) === null) reasons.push("edition.buildCompletedAt is not an ISO instant");
    if (parseInstant(e.sourceLatestFetchAt) === null) reasons.push("edition.sourceLatestFetchAt is not an ISO instant");
  }
  if (!Array.isArray(snapshot?.articles) || snapshot.articles.length === 0) reasons.push("no articles");
  if (Object.keys(snapshot?.articleDetail ?? {}).length === 0) reasons.push("no article details");
  if (!Array.isArray(snapshot?.sections) || snapshot.sections.length === 0) reasons.push("no sections");

  // Any endpoint the build tried and could not read (non-2xx, malformed JSON,
  // network error) is a blocker by itself: a partial fetch is not an edition.
  const failed = Array.isArray(context.failedEndpoints) ? context.failedEndpoints : [];
  if (failed.length > 0) reasons.push(`endpoint failure${failed.length === 1 ? "" : "s"}: ${failed.join(", ")}`);

  // Every section page the paper expects must actually be present.
  const expected = Array.isArray(context.expectedSections) ? context.expectedSections : [];
  for (const slug of expected) {
    if (!snapshot?.section?.[slug]) reasons.push(`section page missing: ${slug}`);
  }

  // Every article summary must carry its detail record — a headline whose body
  // cannot be opened is not publishable content.
  const details = snapshot?.articleDetail ?? {};
  const missingDetail = (snapshot?.articles ?? []).filter((a) => a?.id != null && !details[a.id]);
  if (missingDetail.length > 0) {
    reasons.push(
      missingDetail.length === 1
        ? "1 article summary lacks a detail record"
        : `${missingDetail.length} article summaries lack detail records`,
    );
  }

  // Source metadata is required — the receipts and attribution layer depend on
  // it. Clusters, by contrast, may legally be empty on a quiet news cycle.
  if (!Array.isArray(snapshot?.sources) || snapshot.sources.length === 0) reasons.push("no source metadata");

  reasons.push(...receiptBlockers(snapshot, context.receipts));

  // Legal gates (the excerpt policy). Unlike completeness, these are not about
  // whether the edition is whole; they are about what it may never contain.
  reasons.push(...bodyTextBlockers(snapshot));
  reasons.push(...archiveUrlBlockers(snapshot));
  reasons.push(...markerBlockers(snapshot));

  return reasons;
}

// ------------------------------------------------------------- legal gates
//
// The published paper shows a short, capped excerpt and links out to the
// outlet. It never carries an article's full body, and a full-article rewrite
// is that same body in other words, so it is held to the same rule. Until
// 2026-09-13 every article detail shipped its complete rawText inside the
// public bundle, one click from a "Read the full article" button.
//
// The build strips these fields (stripBodyText) and this gate refuses any
// snapshot that still has them, so the rule does not rest on the strip alone.

// Visit every key/value pair in a JSON-shaped value, depth first.
function walkEntries(value, visit, path = "") {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkEntries(v, visit, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      visit(value, k, v, p);
      walkEntries(v, visit, p);
    }
  }
}

// Presence of the key is the violation, whatever its value: a stripped
// snapshot has no rawText key at all, so an empty string still means the strip
// did not run. A translation is only a violation when it is not null.
export function bodyTextBlockers(snapshot) {
  let bodies = 0;
  let translations = 0;
  const examples = [];
  walkEntries(snapshot, (_parent, key, value, path) => {
    if (key === "rawText") {
      bodies++;
      if (examples.length < 3) examples.push(path);
    } else if (key === "translation" && value !== null && value !== undefined) {
      translations++;
      if (examples.length < 3) examples.push(path);
    }
  });
  if (bodies === 0 && translations === 0) return [];
  return [
    `snapshot carries full article text: ${bodies} rawText field${bodies === 1 ? "" : "s"}, ` +
      `${translations} full-article translation${translations === 1 ? "" : "s"} (e.g. ${examples.join(", ")})`,
  ];
}

// Remove every rawText key and null every translation, in place. Returns what
// it removed so the build can say so.
export function stripBodyText(snapshot) {
  let bodies = 0;
  let translations = 0;
  walkEntries(snapshot, (parent, key, value) => {
    if (key === "rawText") {
      delete parent[key];
      bodies++;
    } else if (key === "translation" && value !== null && value !== undefined) {
      parent[key] = null;
      translations++;
    }
  });
  return { bodies, translations };
}

// Highlights are verbatim spans of the article. The marking pass covers a
// 250–500 word window, wider than the capped excerpt a reader is shown, so a
// score's full marker list republishes text past the cap: on the 2026-09-13
// edition, 20,276 words across 431 of 440 articles. Nothing renders from
// score.markers (every highlight is drawn from excerpt.markers), so each score
// keeps only the markers whose text appears in its article's published excerpt.
// A holder without its own excerpt (cluster member lists) uses the article's
// detail record; an article with no excerpt keeps no markers.
function excerptTextFor(snapshot, holder) {
  const excerpt = holder?.excerpt ?? snapshot?.articleDetail?.[holder?.id]?.excerpt;
  return Array.isArray(excerpt?.paragraphs) ? excerpt.paragraphs.join("\n\n") : "";
}

function markerIsShown(marker, text) {
  return typeof marker?.text === "string" && marker.text.length > 0 && text.includes(marker.text);
}

export function trimMarkersToExcerpt(snapshot) {
  let removed = 0;
  walkEntries(snapshot, (parent, key, value) => {
    if (key !== "score" || !value || !Array.isArray(value.markers)) return;
    const text = excerptTextFor(snapshot, parent);
    const kept = value.markers.filter((m) => markerIsShown(m, text));
    removed += value.markers.length - kept.length;
    value.markers = kept;
  });
  return { markers: removed };
}

export function markerBlockers(snapshot) {
  let outside = 0;
  const examples = [];
  walkEntries(snapshot, (parent, key, value, path) => {
    let markers = null;
    let text = "";
    if (key === "score" && value && Array.isArray(value.markers)) {
      markers = value.markers;
      text = excerptTextFor(snapshot, parent);
    } else if (key === "excerpt" && value && Array.isArray(value.markers)) {
      markers = value.markers;
      text = Array.isArray(value.paragraphs) ? value.paragraphs.join("\n\n") : "";
    }
    if (!markers) return;
    for (const m of markers) {
      if (markerIsShown(m, text)) continue;
      outside++;
      if (examples.length < 3) examples.push(`${path}.markers`);
    }
  });
  if (outside === 0) return [];
  return [`snapshot carries ${outside} highlight${outside === 1 ? "" : "s"} outside the published excerpt (e.g. ${examples.join(", ")})`];
}

// The Internet Archive fallback was removed from ingest on 2026-09-13, not
// merely disabled. No published link may point at an archive host either: a
// snapshot URL on one of these means archived text found its way back in.
export const ARCHIVE_HOSTS = [
  "archive.org", // archive-guard: detector list
  "archive.ph", // archive-guard: detector list
  "archive.today", // archive-guard: detector list
  "archive.is", // archive-guard: detector list
  "archive.li", // archive-guard: detector list
  "archive.vn", // archive-guard: detector list
  "archive.fo", // archive-guard: detector list
  "archive.md", // archive-guard: detector list
];

export function isArchiveHostUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ARCHIVE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function archiveUrlBlockers(snapshot) {
  const hits = [];
  walkEntries(snapshot, (_parent, _key, value, path) => {
    if (isArchiveHostUrl(value)) hits.push(`${path} = ${value}`);
  });
  if (hits.length === 0) return [];
  return [`snapshot links to an archive host (${hits.length}): ${hits.slice(0, 3).join("; ")}`];
}

// Receipts carry LITMUS's own wording; nothing in them may be lifted verbatim
// from an article body. Returns the lifted strings. This can only run where the
// bodies still exist, which after stripBodyText is nowhere in the snapshot, so
// build-snapshot.mjs calls it before the strip.
export function liftedClaims(receiptsFile, articleDetail) {
  const receipts = Array.isArray(receiptsFile?.receipts) ? receiptsFile.receipts : [];
  const bodies = Object.values(articleDetail ?? {})
    .map((d) => d?.rawText)
    .filter((t) => typeof t === "string" && t.length > 0);
  const claims = receipts.flatMap((r) => [r?.claim, ...(r?.positions ?? []).map((p) => p?.statement)]);
  return claims.filter((t) => typeof t === "string" && t.trim().length > 0 && bodies.some((b) => b.includes(t)));
}

// Receipts must belong to the story they will render under.
//
// This is the publication half of a defect the client now also guards at render
// time. Receipts are keyed by cluster id, and cluster ids are SERIAL values that
// replaceAllClusters regenerates every run, so a receipt written for one
// edition lands on whatever story inherits its number in the next. On
// 2026-08-03 that put July's Strait-of-Hormuz receipts under an August story
// about a migrant crossing in Ceuta, presented as sourced fact.
//
// The render-time guard stops a reader seeing it. This stops it being
// published, which is the difference between a page that quietly shows nothing
// and an edition that is known to be wrong before it ships.
//
// The check is specifically cluster-membership. Confirming that a cited article
// exists SOMEWHERE in the snapshot is not enough — in the Ceuta case the cited
// articles were real articles; they simply were not in that cluster.
export function receiptBlockers(snapshot, receiptsFile) {
  if (!receiptsFile) return []; // nothing to validate; not an error
  const reasons = [];
  const receipts = Array.isArray(receiptsFile.receipts) ? receiptsFile.receipts : [];
  if (receipts.length === 0) return reasons;

  const membersByCluster = new Map();
  for (const [clusterId, articles] of Object.entries(snapshot?.clusterArticles ?? {})) {
    membersByCluster.set(
      Number(clusterId),
      (articles ?? []).filter((a) => a?.id != null && a?.url).map((a) => ({ id: a.id, url: a.url })),
    );
  }

  for (const r of receipts) {
    const cited = citationsOf(r);
    if (cited.length === 0) continue;

    const members = membersByCluster.get(r?.clusterId);
    // A receipt for a cluster this edition does not have is not applicable, not
    // corrupt. The client already refuses to render it, and blocking the whole
    // paper over a stale optional annotation would take the edition down on a
    // quiet news day — which the gate explicitly allows to have no clusters at
    // all. The verifier's empty-clusters fixture caught this being too strict.
    //
    // The corruption case is narrower and is the one that actually shipped: the
    // cluster EXISTS, and the receipt cites something that is not a genuine
    // member of it.
    if (!members) continue;

    // MATCHING IS ON THE (articleId, canonical URL) PAIR, not either field
    // alone. articleId-only membership (the previous check) would pass a
    // receipt citing the right id with a stale or wrong URL — exactly the
    // shape of bug this replaces: cluster member {id:900, url:NEW}, receipt
    // {articleId:900, url:OLD} used to pass. URL-only would make the inverse
    // mistake. See scripts/receiptIdentity.mjs.
    if (!allCitationsAreMembers(cited, members)) {
      const memberKeys = new Set(members.map((m) => memberKey(m.id, m.url)));
      const strays = cited
        .filter((s) => !memberKeys.has(memberKey(s?.articleId, s?.url)))
        .map((s) => `${s?.articleId} (${s?.url})`);
      reasons.push(
        `receipt ${r?.id} cites ${strays.join(", ")} — not a member of cluster ${r?.clusterId} ` +
          "at that exact (articleId, url) pair",
      );
    }
  }
  return reasons;
}

// The freshness verdict. Mirrors evaluateEdition() in the client.
// States: "fresh" | "stale" | "unknown". Anything missing, malformed,
// future-dated, or self-contradictory lands on "unknown" — never "fresh".
export function editionState(edition, nowMs) {
  if (!edition || typeof edition !== "object") return { state: "unknown", reason: "no manifest" };
  if (edition.schemaVersion !== EDITION_SCHEMA_VERSION) return { state: "unknown", reason: "unrecognized schema version" };

  const built = parseInstant(edition.buildCompletedAt);
  const fetched = parseInstant(edition.sourceLatestFetchAt);
  if (built === null) return { state: "unknown", reason: "unreadable build time" };
  if (fetched === null) return { state: "unknown", reason: "unreadable content time" };

  const skew = FUTURE_TOLERANCE_MINUTES * 60_000;
  if (built - nowMs > skew || fetched - nowMs > skew) return { state: "unknown", reason: "timestamp is in the future" };
  // Content cannot have been fetched after the build that froze it.
  if (fetched - built > skew) return { state: "unknown", reason: "content is newer than the build that froze it" };
  if (!Number.isFinite(edition.articleCount) || edition.articleCount <= 0) return { state: "unknown", reason: "no articles recorded" };

  const hours = STALE_AFTER_HOURS * 3_600_000;
  const oldest = Math.min(built, fetched);
  if (nowMs - oldest > hours) return { state: "stale", reason: "older than the daily window" };
  return { state: "fresh", reason: "within the daily window" };
}
