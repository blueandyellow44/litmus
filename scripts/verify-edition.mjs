// Deterministic checks on the two things this edition claims: WHEN it is from,
// and WHICH claims have receipts. Dependency-free, Node 18+, no test framework.
//
//   node scripts/verify-edition.mjs           # negative fixtures + real snapshot
//   node scripts/verify-edition.mjs --stamp   # also restamp the local snapshot's
//                                             # edition manifest from its own data
//
// --stamp exists because scripts/build-snapshot.mjs needs a running API, so it is
// the only way to exercise the manifest offline against real volume. It rewrites
// ONLY snapshot.edition, derived from timestamps already inside the file, and the
// snapshot is a gitignored artifact the daily funnel regenerates.

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  deriveEdition,
  editionState,
  reasonsNotToPublish,
  latestSourceFetch,
  bodyTextBlockers,
  stripBodyText,
  trimMarkersToExcerpt,
  markerBlockers,
  archiveUrlBlockers,
  isArchiveHostUrl,
  liftedClaims,
  STALE_AFTER_HOURS,
  EDITION_SCHEMA_VERSION,
} from "./edition-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// VERIFY_SNAPSHOT points the real-file checks at another snapshot, e.g. the
// published edition downloaded after a deploy.
const SNAPSHOT = process.env.VERIFY_SNAPSHOT ?? join(ROOT, "litmus-client", "src", "demo", "snapshot.json");
const RECEIPTS = join(ROOT, "litmus-client", "src", "demo", "claim-receipts.json");
const EDITION_TS = join(ROOT, "litmus-client", "src", "lib", "edition.ts");

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
    console.log(`  FAIL ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const NOW = Date.parse("2026-07-26T20:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

// A manifest that is fresh in every respect; each fixture below breaks one thing.
const good = {
  schemaVersion: EDITION_SCHEMA_VERSION,
  buildCompletedAt: hoursAgo(3),
  sourceLatestFetchAt: hoursAgo(4),
  articleCount: 200,
  articleDetailCount: 221,
  clusterCount: 13,
  sectionCount: 8,
  sectionPageCount: 8,
  staleAfterHours: STALE_AFTER_HOURS,
};
const state = (m) => editionState(m, NOW).state;

// ---------------------------------------------------------------- manifest
console.log("\nedition manifest — unhappy paths first");
check("missing manifest -> unknown", state(undefined), "unknown");
check("null manifest -> unknown", state(null), "unknown");
check("empty object -> unknown", state({}), "unknown");
check("wrong schema version -> unknown", state({ ...good, schemaVersion: 99 }), "unknown");
check("malformed build timestamp -> unknown", state({ ...good, buildCompletedAt: "yesterday" }), "unknown");
check("empty-string timestamp -> unknown", state({ ...good, buildCompletedAt: "" }), "unknown");
check("date without time -> unknown", state({ ...good, buildCompletedAt: "2026-07-26" }), "unknown");
check("null content cutoff -> unknown", state({ ...good, sourceLatestFetchAt: null }), "unknown");
check("future build time -> unknown", state({ ...good, buildCompletedAt: hoursAgo(-48) }), "unknown");
check("future content time -> unknown", state({ ...good, sourceLatestFetchAt: hoursAgo(-48) }), "unknown");
check(
  "content newer than its own build -> unknown",
  state({ ...good, buildCompletedAt: hoursAgo(10), sourceLatestFetchAt: hoursAgo(2) }),
  "unknown",
);
check("zero articles -> unknown", state({ ...good, articleCount: 0 }), "unknown");
check("non-numeric article count -> unknown", state({ ...good, articleCount: "200" }), "unknown");
check(
  "31h old (one missed edition) -> stale",
  state({ ...good, buildCompletedAt: hoursAgo(31), sourceLatestFetchAt: hoursAgo(31) }),
  "stale",
);
check(
  "37h old -> stale",
  state({ ...good, buildCompletedAt: hoursAgo(37), sourceLatestFetchAt: hoursAgo(38) }),
  "stale",
);
check(
  "15 days old (the deployed case) -> stale",
  state({ ...good, buildCompletedAt: hoursAgo(360), sourceLatestFetchAt: hoursAgo(361) }),
  "stale",
);
check(
  "fresh build over stale content -> stale",
  state({ ...good, buildCompletedAt: hoursAgo(1), sourceLatestFetchAt: hoursAgo(200) }),
  "stale",
);
check("17h old -> fresh", state({ ...good, buildCompletedAt: hoursAgo(17), sourceLatestFetchAt: hoursAgo(17) }), "fresh");
check(
  "29h old (a late but not missed daily run) -> fresh",
  state({ ...good, buildCompletedAt: hoursAgo(29), sourceLatestFetchAt: hoursAgo(29) }),
  "fresh",
);
check("3h old -> fresh", state(good), "fresh");
check("2 minutes ahead (clock skew) -> fresh", state({ ...good, buildCompletedAt: hoursAgo(-0.03) }), "fresh");

// ------------------------------------------------------- publish gate
// These cases exercise the REAL reasonsNotToPublish() the build imports —
// including the completeness context the build now passes.
console.log("\npublish gate — a bad or PARTIAL build must not replace a good edition");
const EXPECTED = ["politics", "world"];
const fullSnapshot = {
  edition: good,
  articles: [{ id: 1, fetchedAt: hoursAgo(4) }],
  articleDetail: { 1: { fetchedAt: hoursAgo(4) } },
  sections: [{ slug: "politics" }, { slug: "world" }],
  section: { politics: { articles: [] }, world: { articles: [] } },
  sources: [{ id: 1, name: "Outlet A" }],
  clusters: [{ id: 1 }],
};
const ctx = { expectedSections: EXPECTED, failedEndpoints: [] };
check("complete snapshot publishes", reasonsNotToPublish(fullSnapshot, ctx), []);
check(
  "empty article array blocks publish",
  reasonsNotToPublish({ ...fullSnapshot, articles: [] }, ctx).includes("no articles"),
  true,
);
check(
  "empty cluster array alone does NOT block (a quiet news day is legal)",
  reasonsNotToPublish({ ...fullSnapshot, clusters: [] }, ctx),
  [],
);
check(
  "empty sections block publish",
  reasonsNotToPublish({ ...fullSnapshot, sections: [] }, ctx).includes("no sections"),
  true,
);
check(
  "missing manifest blocks publish",
  reasonsNotToPublish({ ...fullSnapshot, edition: undefined }, ctx).includes("no edition manifest on the snapshot"),
  true,
);
check(
  "malformed manifest timestamp blocks publish",
  reasonsNotToPublish({ ...fullSnapshot, edition: { ...good, buildCompletedAt: "nope" } }, ctx).includes(
    "edition.buildCompletedAt is not an ISO instant",
  ),
  true,
);
check(
  "total API failure (all empty) blocks publish",
  reasonsNotToPublish({ articles: [], articleDetail: {}, sections: [], clusters: [] }, ctx).length >= 4,
  true,
);
check(
  "one missing expected section page blocks publish",
  reasonsNotToPublish(
    { ...fullSnapshot, section: { politics: fullSnapshot.section.politics } },
    ctx,
  ).includes("section page missing: world"),
  true,
);
check(
  "a recorded endpoint failure blocks publish even when data looks non-empty",
  reasonsNotToPublish(fullSnapshot, { ...ctx, failedEndpoints: ["/sections/world (HTTP 500)"] }).includes(
    "endpoint failure: /sections/world (HTTP 500)",
  ),
  true,
);
check(
  "an article summary without its detail record blocks publish",
  reasonsNotToPublish(
    { ...fullSnapshot, articles: [...fullSnapshot.articles, { id: 2, fetchedAt: hoursAgo(4) }] },
    ctx,
  ).includes("1 article summary lacks a detail record"),
  true,
);
check(
  "empty source metadata blocks publish",
  reasonsNotToPublish({ ...fullSnapshot, sources: [] }, ctx).includes("no source metadata"),
  true,
);

// ------------------------------------------------------------- legal gates
console.log("\nlegal gates — no full article text, no archive links, no lifted receipts");
const withBody = { ...fullSnapshot, articleDetail: { 1: { fetchedAt: hoursAgo(4), rawText: "The whole article." } } };
check("a detail carrying rawText blocks publish", reasonsNotToPublish(withBody, ctx).some((r) => r.startsWith("snapshot carries full article text")), true);
check(
  "an EMPTY rawText key still blocks (the strip did not run)",
  bodyTextBlockers({ articleDetail: { 1: { rawText: "" } } }).length,
  1,
);
check(
  "rawText nested anywhere, not just articleDetail, blocks",
  bodyTextBlockers({ section: { politics: { articles: [{ id: 1, rawText: "x" }] } } }).length,
  1,
);
check(
  "a non-null full-article translation blocks publish",
  bodyTextBlockers({ articleDetail: { 1: { translation: { translatedText: "rewritten whole article" } } } }).length,
  1,
);
check("a null translation does not block", bodyTextBlockers({ articleDetail: { 1: { translation: null } } }), []);
{
  const s = JSON.parse(
    JSON.stringify({ articleDetail: { 1: { rawText: "a", translation: { t: 1 } }, 2: { rawText: "b", translation: null } } }),
  );
  check("stripBodyText reports what it removed", stripBodyText(s), { bodies: 2, translations: 1 });
  check("a stripped snapshot passes the body-text gate", bodyTextBlockers(s), []);
  check("stripBodyText keeps the rest of the record", s.articleDetail[2], { translation: null });
}
check("web.archive.org URL is an archive host", isArchiveHostUrl("https://web.archive.org/web/2026/https://wsj.com/x"), true); // archive-guard: detector test
check("archive.ph URL is an archive host", isArchiveHostUrl("https://archive.ph/abc12"), true); // archive-guard: detector test
check("an outlet URL with /archive/ in its PATH is not", isArchiveHostUrl("https://www.theatlantic.com/archive/2026/09/x/"), false);
check("a host that merely ends in 'archive.org' text is not", isArchiveHostUrl("https://notarchive.org/x"), false); // archive-guard: detector test
check(
  "an article URL on an archive host blocks publish",
  reasonsNotToPublish({ ...fullSnapshot, articles: [{ id: 1, fetchedAt: hoursAgo(4), url: "https://web.archive.org/web/1/x" }] }, ctx).some( // archive-guard: detector test
    (r) => r.startsWith("snapshot links to an archive host"),
  ),
  true,
);
check("normal outlet URLs do not block", archiveUrlBlockers({ articles: [{ url: "https://apnews.com/article/x" }] }), []);
{
  const receiptsFile = { receipts: [{ claim: "Officials confirmed the launch.", positions: [{ statement: "Critics disagree." }] }] };
  check(
    "a receipt claim found verbatim in a body is lifted",
    liftedClaims(receiptsFile, { 1: { rawText: "On Sunday, Officials confirmed the launch. More text." } }),
    ["Officials confirmed the launch."],
  );
  check(
    "a position statement found verbatim in a body is lifted",
    liftedClaims(receiptsFile, { 1: { rawText: "Critics disagree." } }),
    ["Critics disagree."],
  );
  check("original wording is not lifted", liftedClaims(receiptsFile, { 1: { rawText: "Unrelated body." } }), []);
}
{
  const shown = { paragraphs: ["Officials said the bridge reopened.", "Critics called it a disaster."], markers: [{ text: "said" }] };
  const mk = () =>
    JSON.parse(
      JSON.stringify({
        articles: [{ id: 1, excerpt: shown, score: { markers: [{ text: "said" }, { text: "a disaster" }, { text: "buried paragraph nine" }] } }],
        articleDetail: { 1: { id: 1, excerpt: shown, score: { markers: [{ text: "buried paragraph nine" }, { text: "reopened" }] } } },
        clusterArticles: { 7: [{ id: 1, score: { markers: [{ text: "a disaster" }, { text: "never shown anywhere" }] } }] },
        section: { politics: { articles: [{ id: 2, excerpt: null, score: { markers: [{ text: "no excerpt at all" }] } }] } },
      }),
    );
  const s = mk();
  check("highlights outside the excerpt block publish", markerBlockers(s).length, 1);
  check("trimMarkersToExcerpt reports what it removed", trimMarkersToExcerpt(s), { markers: 4 });
  check("a trimmed snapshot passes the highlight gate", markerBlockers(s), []);
  check("a summary score keeps only markers inside its own excerpt", s.articles[0].score.markers, [{ text: "said" }, { text: "a disaster" }]);
  check("a cluster member without an excerpt is trimmed against its detail's excerpt", s.clusterArticles[7][0].score.markers, [{ text: "a disaster" }]);
  check("an article with no excerpt keeps no highlights", s.section.politics.articles[0].score.markers, []);
  check(
    "an excerpt marker that is not in its own paragraphs blocks",
    markerBlockers({ articleDetail: { 1: { excerpt: { paragraphs: ["short"], markers: [{ text: "elsewhere" }] } } } }).length,
    1,
  );
  check("the publish gate carries the highlight check", reasonsNotToPublish({ ...fullSnapshot, ...mk() }, ctx).some((r) => r.includes("outside the published excerpt")), true);
}

// ------------------------------------------------------------ drift guard
console.log("\nshared-invariant drift guard");
const editionTsSource = await readFile(EDITION_TS, "utf8");
const tsThreshold = editionTsSource.match(/export const STALE_AFTER_HOURS = (\d+)/)?.[1];
check("client STALE_AFTER_HOURS matches the build script", Number(tsThreshold), STALE_AFTER_HOURS);
const tsSchema = editionTsSource.match(/export const EDITION_SCHEMA_VERSION = (\d+)/)?.[1];
check("client EDITION_SCHEMA_VERSION matches the build script", Number(tsSchema), EDITION_SCHEMA_VERSION);

// -------------------------------------------------------- claim receipts
// Mirrors litmus-client/src/lib/claims.ts. Same shared-invariant rule as above.
const isHttpUrl = (u) => {
  if (typeof u !== "string") return false;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
};
const validSource = (s) =>
  !!s &&
  typeof s === "object" &&
  Number.isFinite(s.articleId) &&
  isHttpUrl(s.url) &&
  typeof s.publisher === "string" &&
  s.publisher.trim() !== "" &&
  (s.publishedAt === null || typeof s.publishedAt === "string") &&
  (s.kind === "reporting" || s.kind === "primary") &&
  typeof s.supports === "string" &&
  s.supports.trim() !== "";
const independent = (sources) =>
  new Set(sources.filter((s) => s.kind === "reporting").map((s) => s.publisher.trim().toLowerCase())).size;
const meetsConfirmedBar = (sources) => sources.some((s) => s.kind === "primary") || independent(sources) >= 2;

// effectiveStatus mirrors normalizeReceipt(): overclaims downgrade, they do not throw.
function effectiveStatus(r) {
  if (!r || typeof r !== "object") return null;
  if (typeof r.id !== "string" || r.id.trim() === "") return null;
  if (!Number.isFinite(r.clusterId)) return null;
  if (typeof r.claim !== "string" || r.claim.trim() === "") return null;
  if (!["confirmed", "contested", "unknown"].includes(r.status)) return null;
  const sources = Array.isArray(r.sources) ? r.sources.filter(validSource) : [];
  if (r.status === "contested") {
    const positions = (Array.isArray(r.positions) ? r.positions : []).filter(
      (p) =>
        p &&
        typeof p.statement === "string" &&
        p.statement.trim() !== "" &&
        Array.isArray(p.sources) &&
        p.sources.filter(validSource).length > 0,
    );
    return positions.length < 2 ? "unknown" : "contested";
  }
  if (r.status === "confirmed" && !meetsConfirmedBar(sources)) return "unknown";
  return r.status;
}

console.log("\nclaim receipts — unhappy paths first");
const srcA = { articleId: 1, url: "https://a.example/x", publisher: "Outlet A", publishedAt: null, kind: "reporting", supports: "s" };
const srcB = { ...srcA, articleId: 2, url: "https://b.example/y", publisher: "Outlet B" };
const srcA2 = { ...srcA, articleId: 3, url: "https://a.example/z" }; // same publisher as srcA
const srcPrimary = { ...srcA, articleId: 4, url: "https://c.example/filing", publisher: "Outlet C", kind: "primary" };
const base = { id: "r1", clusterId: 12, claim: "A claim.", status: "unknown", sources: [] };

check("not an object -> dropped", effectiveStatus("nope"), null);
check("missing id -> dropped", effectiveStatus({ ...base, id: "" }), null);
check("missing claim text -> dropped", effectiveStatus({ ...base, claim: "  " }), null);
check("bogus status -> dropped", effectiveStatus({ ...base, status: "probably" }), null);
check("non-numeric clusterId -> dropped", effectiveStatus({ ...base, clusterId: "12" }), null);
check(
  "confirmed with one reporting source -> downgraded to unknown",
  effectiveStatus({ ...base, status: "confirmed", sources: [srcA] }),
  "unknown",
);
check(
  "confirmed with two articles from the SAME publisher -> downgraded to unknown",
  effectiveStatus({ ...base, status: "confirmed", sources: [srcA, srcA2] }),
  "unknown",
);
check(
  "confirmed with two independent publishers -> stays confirmed",
  effectiveStatus({ ...base, status: "confirmed", sources: [srcA, srcB] }),
  "confirmed",
);
check(
  "confirmed on a single primary source -> stays confirmed",
  effectiveStatus({ ...base, status: "confirmed", sources: [srcPrimary] }),
  "confirmed",
);
check(
  "malformed source URL is not evidence (confirmed -> unknown)",
  effectiveStatus({ ...base, status: "confirmed", sources: [srcA, { ...srcB, url: "javascript:alert(1)" }] }),
  "unknown",
);
check(
  "missing source URL is not evidence (confirmed -> unknown)",
  effectiveStatus({ ...base, status: "confirmed", sources: [srcA, { ...srcB, url: undefined }] }),
  "unknown",
);
check(
  "contested with only one sourced position -> unknown",
  effectiveStatus({ ...base, status: "contested", positions: [{ statement: "one side", sources: [srcA] }] }),
  "unknown",
);
check(
  "contested with an unsourced position -> unknown",
  effectiveStatus({
    ...base,
    status: "contested",
    positions: [{ statement: "one side", sources: [srcA] }, { statement: "other side", sources: [] }],
  }),
  "unknown",
);
check(
  "contested with two sourced positions -> stays contested",
  effectiveStatus({
    ...base,
    status: "contested",
    positions: [{ statement: "one side", sources: [srcA] }, { statement: "other side", sources: [srcB] }],
  }),
  "contested",
);
check("unknown with no sources at all -> stays unknown", effectiveStatus(base), "unknown");

// -------------------------------------- the REAL build script, end to end
// These cases spawn scripts/build-snapshot.mjs itself against fixture APIs, so
// the thing under test is the shipped implementation path, not a mirror of it.
// SNAPSHOT_OUT points the write at a temp file seeded with a known prior
// snapshot; the real snapshot is never touched.
console.log("\nbuild-snapshot.mjs against partial APIs — the prior snapshot must survive");

const BUILD = join(ROOT, "scripts", "build-snapshot.mjs");
const NOW_ISO = new Date(NOW).toISOString();
const fixtureArticle = (id) => ({ id, title: `Article ${id}`, fetchedAt: NOW_ISO, sourceName: "Outlet A", url: `https://a.example/${id}` });
const ALL_SECTIONS = ["politics", "world", "business", "technology", "science", "health", "sports", "culture"];

// scenario: { deadSections: [...], deadPaths: [...], malformedPaths: [...], emptySources, emptyClusters, articleWithoutDetail }
function startStub(scenario) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url, "http://localhost").pathname.replace(/^\/api/, "");
      const send = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if ((scenario.deadPaths ?? []).includes(path)) {
        res.writeHead(503);
        return res.end("{}");
      }
      if ((scenario.malformedPaths ?? []).includes(path)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{not json");
      }
      if (path === "/sections") return send({ sections: ALL_SECTIONS.map((slug) => ({ slug })) });
      const sectionMatch = path.match(/^\/sections\/(.+)$/);
      if (sectionMatch) {
        if ((scenario.deadSections ?? []).includes(sectionMatch[1])) {
          res.writeHead(500);
          return res.end("{}");
        }
        return send({ slug: sectionMatch[1], articles: [fixtureArticle(1)] });
      }
      if (path === "/articles") {
        const articles = [fixtureArticle(1)];
        if (scenario.articleWithoutDetail) articles.push(fixtureArticle(99));
        return send({ articles });
      }
      const articleMatch = path.match(/^\/articles\/(\d+)$/);
      if (articleMatch) {
        if (scenario.articleWithoutDetail && articleMatch[1] === "99") {
          res.writeHead(404);
          return res.end("{}");
        }
        const detail = {
          ...fixtureArticle(Number(articleMatch[1])),
          translation: null,
          excerpt: { paragraphs: ["body text"], markers: [{ text: "body" }] },
          score: { markers: [{ text: "body" }, { text: "a phrase from further down the article" }] },
        };
        if (!scenario.noBodies) detail.rawText = scenario.bodyText ?? "body text";
        return send(detail);
      }
      if (path === "/sources") return send({ sources: scenario.emptySources ? [] : [{ id: 1, name: "Outlet A" }] });
      if (path === "/clusters") return send({ clusters: scenario.emptyClusters ? [] : [{ id: 1, topic: "t" }] });
      // build-snapshot reads the story list since the story-first front page
      // (it 404'd here, so every publishable scenario failed from then on).
      if (path === "/stories") return send({ stories: [] });
      res.writeHead(404);
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function runBuild(scenario, { apiOverride } = {}) {
  const server = scenario === null ? null : await startStub(scenario);
  const api = apiOverride ?? `http://127.0.0.1:${server.address().port}/api`;
  const dir = await mkdtemp(join(tmpdir(), "litmus-verify-"));
  const out = join(dir, "snapshot.json");
  const prior = JSON.stringify({ marker: "prior good snapshot", bytes: "x".repeat(500) });
  await writeFile(out, prior);
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BUILD], {
      env: { ...process.env, API_URL: api, SNAPSHOT_OUT: out, FROZEN_AT: NOW_ISO },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  const after = await readFile(out, "utf8");
  const tmpResidue = existsSync(`${out}.tmp`);
  server?.close();
  await rm(dir, { recursive: true, force: true });
  return { exit: exit.code, stderr: exit.stderr, preserved: after === prior, replaced: after !== prior, after, tmpResidue };
}

{
  const r = await runBuild({ deadSections: ["health"] });
  check("one failed section endpoint -> exit 1", r.exit, 1);
  check("one failed section endpoint -> prior snapshot byte-identical", r.preserved, true);
  check("one failed section endpoint -> blocker names the section", r.stderr.includes("/sections/health"), true);
}
{
  const seven = ALL_SECTIONS.slice(1);
  const r = await runBuild({ deadSections: seven, deadPaths: ["/sources", "/clusters"] });
  check("7 of 8 sections + sources + clusters failed (the audit case) -> exit 1", r.exit, 1);
  check("the audit case -> prior snapshot byte-identical", r.preserved, true);
}
{
  const r = await runBuild({ deadPaths: ["/sections", "/articles", "/sources", "/clusters", ...ALL_SECTIONS.map((s) => `/sections/${s}`)] });
  check("all-empty API -> exit 1", r.exit, 1);
  check("all-empty API -> prior snapshot byte-identical", r.preserved, true);
}
{
  const r = await runBuild({ articleWithoutDetail: true });
  check("article summary without detail -> exit 1", r.exit, 1);
  check("article summary without detail -> prior snapshot byte-identical", r.preserved, true);
}
{
  const r = await runBuild({ emptySources: true });
  check("empty source metadata -> exit 1", r.exit, 1);
  check("empty source metadata -> prior snapshot byte-identical", r.preserved, true);
}
{
  const r = await runBuild({ malformedPaths: ["/sections/world"] });
  check("malformed JSON from an endpoint -> exit 1", r.exit, 1);
  check("malformed JSON -> prior snapshot byte-identical", r.preserved, true);
}
{
  const r = await runBuild({ deadPaths: ["/articles"] });
  check("non-2xx article list -> exit 1", r.exit, 1);
  check("non-2xx article list -> prior snapshot byte-identical", r.preserved, true);
}
{
  const r = await runBuild(null, { apiOverride: "http://127.0.0.1:1/api" });
  check("unreachable API -> exit 1", r.exit, 1);
  check("unreachable API -> prior snapshot byte-identical", r.preserved, true);
}
{
  const r = await runBuild({ emptyClusters: true });
  check("empty clusters with otherwise complete data -> publishes (exit 0)", r.exit, 0);
  check("empty clusters -> snapshot was replaced with the new edition", r.replaced, true);
  const written = JSON.parse(r.after);
  check("published snapshot carries all 8 section pages", Object.keys(written.section).length, 8);
  check("published snapshot carries a manifest that passes the gate", reasonsNotToPublish(written), []);
  check("no .tmp residue after a successful write", r.tmpResidue, false);
  check("the API sent a body, the published snapshot has none", bodyTextBlockers(written), []);
  check("the published detail keeps its non-body fields", written.articleDetail["1"].url, "https://a.example/1");
  check("the API sent a highlight from outside the excerpt, the published score has none", written.articleDetail["1"].score.markers, [{ text: "body" }]);
}
{
  // The real receipts file is what build-snapshot reads, so lift one of its own
  // claims into the fixture body and the build must refuse.
  const realReceipts = JSON.parse(await readFile(RECEIPTS, "utf8"));
  const realClaim = realReceipts.receipts?.[0]?.claim;
  check("the receipts file has a claim to test the lift check with", typeof realClaim === "string" && realClaim.length > 0, true);
  const r = await runBuild({ emptyClusters: true, bodyText: `Preamble. ${realClaim} Trailing.` });
  check("a receipt lifted verbatim from a body -> exit 1", r.exit, 1);
  check("lifted receipt -> prior snapshot byte-identical", r.preserved, true);
  check("lifted receipt -> blocker says so", r.stderr.includes("copied verbatim from an article body"), true);
}
{
  const r = await runBuild({ emptyClusters: true, noBodies: true });
  check("receipts present but the API sent no bodies to check -> exit 1", r.exit, 1);
  check("no bodies to check -> prior snapshot byte-identical", r.preserved, true);
}
{
  const r = await runBuild({ deadSections: ["health"] });
  check("no .tmp residue after a refused write", r.tmpResidue, false);
}

// ------------------------------------------------- the real files on disk
console.log("\nreal snapshot + real receipts");
let snapshot = null;
try {
  snapshot = JSON.parse(await readFile(SNAPSHOT, "utf8"));
} catch (err) {
  console.log(`  SKIP snapshot checks — ${SNAPSHOT} is unreadable (${err.code ?? err.message}).`);
}

if (snapshot) {
  const derived = deriveEdition(snapshot, { buildCompletedAt: new Date(NOW).toISOString() });
  check("derived manifest carries a real content cutoff", typeof derived.sourceLatestFetchAt === "string", true);
  check("derived article count matches the snapshot", derived.articleCount, snapshot.articles.length);
  check("derived cluster count matches the snapshot", derived.clusterCount, snapshot.clusters.length);
  check(
    "a snapshot carrying a derived manifest is publishable (full completeness context)",
    reasonsNotToPublish({ ...snapshot, edition: derived }, { expectedSections: ALL_SECTIONS, failedEndpoints: [] }),
    [],
  );
  console.log(
    `  info snapshot volume: ${derived.articleCount} articles, ${derived.articleDetailCount} details, ` +
      `${derived.clusterCount} clusters, ${derived.sectionPageCount} section pages, content through ${derived.sourceLatestFetchAt}`,
  );
  const onDisk = editionState(snapshot.edition, Date.now());
  console.log(`  info this snapshot's own manifest evaluates to: ${onDisk.state} (${onDisk.reason})`);

  const receipts = JSON.parse(await readFile(RECEIPTS, "utf8"));
  const byId = new Map(snapshot.articles.map((a) => [a.id, a]));
  for (const [id, d] of Object.entries(snapshot.articleDetail ?? {})) byId.set(Number(id), d);

  check("receipt file schema version is current", receipts.schemaVersion, 1);
  const clusterIds = [...new Set(receipts.receipts.map((r) => r.clusterId))].sort((a, b) => a - b);
  check("receipts cover exactly three clusters", clusterIds.length, 3);

  const knownClusters = new Set(snapshot.clusters.map((c) => c.id));
  check("every receipted cluster exists in the snapshot", clusterIds.every((c) => knownClusters.has(c)), true);

  const allRefs = receipts.receipts.flatMap((r) => [...(r.sources ?? []), ...(r.positions ?? []).flatMap((p) => p.sources)]);
  check("every source ref is structurally valid", allRefs.filter((s) => !validSource(s)).length, 0);
  check("every source ref points at an article in this snapshot", allRefs.filter((s) => !byId.has(s.articleId)).length, 0);

  const mismatched = allRefs.filter((s) => {
    const a = byId.get(s.articleId);
    return a && a.sourceName !== s.publisher;
  });
  check("every cited publisher matches the snapshot's own record", mismatched.map((m) => m.articleId), []);

  const urlMismatch = allRefs.filter((s) => {
    const a = byId.get(s.articleId);
    return a && a.url !== s.url;
  });
  check("every cited URL matches the snapshot's own record", urlMismatch.map((m) => m.articleId), []);

  const claimedVsEffective = receipts.receipts.filter((r) => effectiveStatus(r) !== r.status);
  check("no receipt claims a status its evidence cannot carry", claimedVsEffective.map((r) => r.id), []);

  const paywalled = allRefs.filter((s) => byId.get(s.articleId)?.paywallFlag);
  check("every paywalled source is flagged as such in the receipt", paywalled.filter((s) => !s.paywalled).map((s) => s.articleId), []);

  // Receipts carry LITMUS's own wording. That is checked in build-snapshot.mjs,
  // the last step that can still see article bodies (exercised by the fixture
  // runs above). A published snapshot has no bodies to compare against, and
  // what this file must prove is exactly that.
  check("published snapshot carries no full article text", bodyTextBlockers(snapshot), []);
  check("published snapshot links nowhere on an archive host", archiveUrlBlockers(snapshot), []);

  const counts = receipts.receipts.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  console.log(
    `  info ${receipts.receipts.length} receipts across clusters ${clusterIds.join(", ")}: ` +
      `${counts.confirmed ?? 0} confirmed, ${counts.contested ?? 0} contested, ${counts.unknown ?? 0} unverified`,
  );

  if (process.argv.includes("--stamp")) {
    const stamped = { ...snapshot, edition: deriveEdition(snapshot, { buildCompletedAt: new Date().toISOString() }) };
    const blockers = reasonsNotToPublish(stamped);
    if (blockers.length > 0) {
      console.log(`\n  --stamp REFUSED: ${blockers.join("; ")}`);
    } else {
      await writeFile(SNAPSHOT, JSON.stringify(stamped));
      console.log(
        `\n  --stamp wrote edition to ${SNAPSHOT}\n` +
          `         compiled ${stamped.edition.buildCompletedAt}, content through ${stamped.edition.sourceLatestFetchAt}\n` +
          `         (content cutoff is the snapshot's real ${latestSourceFetch(snapshot)}, so this edition reads STALE — as it should)`,
      );
    }
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(`\nFAILURES:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
