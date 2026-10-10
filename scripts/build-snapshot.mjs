// Freeze the live API into the static bundle the client ships (VITE_DEMO). Hits
// a running LITMUS API (default http://localhost:8787) and writes the snapshot
// the client reads when no backend is present. Node 18+ (global fetch), no deps.
//
// The write is gated and atomic: a run that could not fetch a COMPLETE edition
// exits non-zero, names its blockers, and leaves the previous snapshot
// byte-for-byte in place. "Complete" is judged against what this build expected
// (every section endpoint, a detail for every summary, source metadata), not
// merely "non-empty" — the failure the audit proved was a partial API response
// quietly replacing a full paper with a gutted one.
//
// SNAPSHOT_OUT overrides the output path so the deterministic verifier can run
// this exact script against fixture APIs without touching the real snapshot.
import { writeFile, readFile, mkdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveEdition, reasonsNotToPublish, stripBodyText, trimMarkersToExcerpt, liftedClaims } from "./edition-manifest.mjs";
import { assertIsolatedWriter, IsolationRefusal } from "./isolation-guard.mjs";

const API = process.env.API_URL ?? "http://localhost:8787/api";
const OUT =
  process.env.SNAPSHOT_OUT ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "litmus-client", "src", "demo", "snapshot.json");

// This is the process that writes the published edition, so the isolation
// guards have to hold HERE and not only in the server's TypeScript, which this
// script imports none of. Both checks run before the first fetch and before any
// write, so a refused run has read nothing remote and touched no file.
try {
  await assertIsolatedWriter({ apiUrl: API, snapshotOut: process.env.SNAPSHOT_OUT });
} catch (err) {
  if (err instanceof IsolationRefusal) {
    console.error(`\nsnapshot REFUSED: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
const SECTIONS = ["politics", "world", "business", "technology", "science", "health", "sports", "culture"];

// Every failed read (non-2xx, malformed JSON, network error) is recorded and
// becomes a publish blocker. A null from get() is never silently "no data".
const failedEndpoints = [];
const get = async (p) => {
  try {
    const r = await fetch(API + p);
    if (!r.ok) {
      failedEndpoints.push(`${p} (HTTP ${r.status})`);
      return null;
    }
    return await r.json();
  } catch (err) {
    failedEndpoints.push(`${p} (${err?.cause?.code ?? err?.name ?? "error"})`);
    return null;
  }
};

const sectionsRes = await get("/sections");
const section = {};
const ids = new Set();
for (const slug of SECTIONS) {
  const d = await get(`/sections/${slug}`);
  if (d) {
    section[slug] = d;
    for (const a of d.articles ?? []) ids.add(a.id);
    // The section page links every article in the desk to its detail view, so
    // each one needs its detail frozen too — not just the trending cluster's.
    for (const a of d.sectionArticles ?? []) ids.add(a.id);
  }
}
const articlesRes = await get("/articles?limit=200");
for (const a of articlesRes?.articles ?? []) ids.add(a.id);

const articleDetail = {};
for (const id of ids) {
  const d = await get(`/articles/${id}`);
  if (d) articleDetail[id] = d;
}

const clusters = (await get("/clusters"))?.clusters ?? [];

// The members of each story, which is the whole point of a cluster: the same
// event as several outlets told it, side by side, so the reader can compare how
// differently it was told. The featured pair contrasts P/H TEMPERATURE, not
// political lean (Decision 2; see docs/decisions/002-featured-pair-axis.md) —
// lean is displayed on each telling but never selects it. Without these members
// the published paper can say a story spans left and right, because the cluster
// carries leanCounts, but cannot show WHAT any outlet actually said. Ten
// clusters is ten extra local calls at build time and no model cost.
const clusterArticles = {};
for (const c of clusters) {
  const d = await get(`/clusters/${c.id}/articles`);
  if (d) clusterArticles[c.id] = d.articles ?? [];
}

// The Story Ledger's own grouping, alongside (not replacing) clusters above.
// Not yet a completeness requirement (reasonsNotToPublish): the ledger can be
// empty or fail on a given run without taking the clusterer-based paper down
// with it, the same way an empty cluster list does not block publish.
const stories = (await get("/stories"))?.stories ?? [];

const snapshot = {
  frozenAt: process.env.FROZEN_AT ?? "",
  sections: sectionsRes?.sections ?? [],
  section,
  articles: articlesRes?.articles ?? [],
  articleDetail,
  sources: (await get("/sources"))?.sources ?? [],
  clusters,
  clusterArticles,
  stories,
};

// The edition manifest — what the masthead reads instead of the browser clock.
snapshot.edition = deriveEdition(snapshot, {
  buildCompletedAt: process.env.FROZEN_AT || new Date().toISOString(),
});

// The receipts the client will render against this edition. They live outside
// the snapshot, which is exactly why they can drift out of step with it, so the
// publish gate reads them and checks each one belongs to the story it is keyed
// to. Unreadable is not fatal — the feature is optional — but present-and-wrong
// is, and that distinction is the whole point.
let receipts = null;
try {
  receipts = JSON.parse(
    await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "litmus-client", "src", "demo", "claim-receipts.json"), "utf8"),
  );
} catch {
  // No receipts file, or not JSON. Nothing to validate against.
}

// Receipts carry LITMUS's own wording, never text lifted from an article. This
// is the last step that can see article bodies, so the check runs HERE, before
// the strip below. Run against the published snapshot it would compare claims
// with nothing and pass on an empty list.
const liftBlockers = [];
if (Array.isArray(receipts?.receipts) && receipts.receipts.length > 0) {
  const haveBodies = Object.values(articleDetail).some((d) => typeof d?.rawText === "string" && d.rawText.length > 0);
  if (!haveBodies) {
    liftBlockers.push("receipts are present but no article bodies were available to check them for lifted text");
  } else {
    for (const t of liftedClaims(receipts, articleDetail)) {
      liftBlockers.push(`receipt text is copied verbatim from an article body: "${t.slice(0, 80)}"`);
    }
  }
}

// The published paper never carries full article text (the excerpt policy).
// The publish gate below independently refuses a snapshot that still does.
const stripped = stripBodyText(snapshot);
// Highlights are verbatim text too; keep only those inside the shown excerpt.
const trimmed = trimMarkersToExcerpt(snapshot);

const blockers = [
  ...liftBlockers,
  ...reasonsNotToPublish(snapshot, {
    expectedSections: SECTIONS,
    failedEndpoints,
    receipts,
  }),
];
if (blockers.length > 0) {
  console.error(`snapshot NOT written — this build is not publishable:\n  - ${blockers.join("\n  - ")}`);
  console.error(`the previous snapshot at ${OUT} is left untouched.`);
  process.exit(1);
}

// Write to a sibling temp file and rename. rename() is atomic on the same
// filesystem, so a crash mid-write can never leave a half-written snapshot
// where the good one used to be.
await mkdir(dirname(OUT), { recursive: true });
const tmp = `${OUT}.tmp`;
try {
  await writeFile(tmp, JSON.stringify(snapshot));
  await rename(tmp, OUT);
} catch (err) {
  await rm(tmp, { force: true });
  throw err;
}
console.log(
  `snapshot -> ${OUT}: ${snapshot.sections.length} sections, ${Object.keys(section).length} section pages, ` +
  `${Object.keys(articleDetail).length} article details, ${snapshot.sources.length} sources, ${snapshot.stories.length} stories`,
);
console.log(
  `stripped before publish: ${stripped.bodies} article bodies, ${stripped.translations} full-article translations, ` +
    `${trimmed.markers} highlights outside the shown excerpt`,
);
console.log(
  `edition: compiled ${snapshot.edition.buildCompletedAt}, content through ${snapshot.edition.sourceLatestFetchAt}, ` +
  `${snapshot.edition.articleCount} articles, ${snapshot.edition.clusterCount} clusters`,
);
