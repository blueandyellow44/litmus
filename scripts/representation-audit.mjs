// What this edition's coverage actually spans, measured rather than asserted.
//
// LITMUS's whole pitch is that a reader can see one event told from more than
// one side. Nothing in the repo measured whether an edition could deliver that,
// so the claim rested on the roster looking balanced. Roster balance is not
// coverage balance and neither is edition balance: the number that decides
// whether the product works is per STORY — how often a reader landing on a
// story can compare a left-leaning telling against a right-leaning one.
//
// Deterministic, offline, free. Reads the committed source roster and the
// published snapshot; makes no network call, no model call, and no database
// query, so it can run in CI beside the other guards.
//
// Run:  node scripts/representation-audit.mjs
//       node scripts/representation-audit.mjs --json
//       node scripts/representation-audit.mjs --snapshot path/to/snapshot.json
//
// It REPORTS. It has no pass/fail threshold on representation itself and must
// not grow one: a balance target that a build has to hit is an instruction to
// pad the roster or suppress the centre, and either would corrupt the very
// measurement this exists to make. It exits non-zero only when it cannot read
// its inputs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const snapshotArg = argv.indexOf("--snapshot");
const SNAPSHOT_PATH =
  snapshotArg >= 0 && argv[snapshotArg + 1]
    ? argv[snapshotArg + 1]
    : join(ROOT, "litmus-client", "src", "demo", "snapshot.json");
const SEED_PATH = join(ROOT, "litmus-server", "sources", "seed.json");

// The five baselines, in scale order, and the two wings.
const BASELINES = ["left", "center-left", "center", "center-right", "right"];
const LEFT_WING = new Set(["left", "center-left"]);
const RIGHT_WING = new Set(["right", "center-right"]);

function read(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`representation-audit: cannot read ${what} at ${path}\n  ${err?.message ?? err}`);
    process.exit(1);
  }
}

const seed = read(SEED_PATH, "the source roster");
const snapshot = read(SNAPSHOT_PATH, "the published snapshot");
const sources = Array.isArray(seed?.sources) ? seed.sources : [];
const articles = Array.isArray(snapshot?.articles) ? snapshot.articles : [];
const clusterArticles = snapshot?.clusterArticles ?? {};
const clusters = Array.isArray(snapshot?.clusters) ? snapshot.clusters : [];

const emptyCounts = () => Object.fromEntries(BASELINES.map((b) => [b, 0]));
const pct = (n, total) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);

// ── The roster ─────────────────────────────────────────────────────────────

const configured = emptyCounts();
const enabled = emptyCounts();
const disabled = [];
for (const s of sources) {
  if (!BASELINES.includes(s.lean)) continue;
  configured[s.lean]++;
  if (s.enabled === false) disabled.push({ name: s.name, lean: s.lean });
  else enabled[s.lean]++;
}

// ── The edition ────────────────────────────────────────────────────────────

const displayed = emptyCounts();
const distinctSources = new Map(BASELINES.map((b) => [b, new Set()]));
let scored = 0;
let unscored = 0;
let partialExtraction = 0;
// Reliability is LITMUS's own internal rating, applied by hand and with no
// published methodology (see litmus-server/sources/README.md). Reported so the
// number is visible, labelled so nothing downstream mistakes it for external
// evidence about an outlet.
const reliabilityByName = new Map(sources.map((s) => [s.name, s.reliability]));
const reliabilityWeighted = Object.fromEntries(BASELINES.map((b) => [b, { sum: 0, n: 0 }]));

for (const a of articles) {
  if (!BASELINES.includes(a.sourceLean)) continue;
  displayed[a.sourceLean]++;
  distinctSources.get(a.sourceLean).add(a.sourceName);
  if (a.score) scored++;
  else unscored++;
  if (a.extractionStatus === "partial" || a.paywallFlag) partialExtraction++;
  const r = reliabilityByName.get(a.sourceName);
  if (typeof r === "number") {
    reliabilityWeighted[a.sourceLean].sum += r;
    reliabilityWeighted[a.sourceLean].n++;
  }
}

const totalDisplayed = BASELINES.reduce((n, b) => n + displayed[b], 0);
const broadLeft = BASELINES.filter((b) => LEFT_WING.has(b)).reduce((n, b) => n + displayed[b], 0);
const broadRight = BASELINES.filter((b) => RIGHT_WING.has(b)).reduce((n, b) => n + displayed[b], 0);
const centre = displayed.center;

// ── Story-level bilateral coverage: the number that decides the product ─────

const storyRows = [];
for (const c of clusters) {
  const members = clusterArticles[c.id] ?? clusterArticles[String(c.id)] ?? [];
  const leans = members.map((m) => m.sourceLean).filter((l) => BASELINES.includes(l));
  const hasLeft = leans.some((l) => LEFT_WING.has(l));
  const hasRight = leans.some((l) => RIGHT_WING.has(l));
  storyRows.push({
    id: c.id,
    topic: c.topic,
    outlets: members.length,
    distinctSources: new Set(members.map((m) => m.sourceName)).size,
    hasLeft,
    hasRight,
    bilateral: hasLeft && hasRight,
    baselines: leans.reduce((acc, l) => ((acc[l] = (acc[l] ?? 0) + 1), acc), {}),
  });
}
const bilateral = storyRows.filter((s) => s.bilateral).length;
// A story covered by a single outlet cannot be bilateral no matter how balanced
// the roster is, so it is reported separately rather than counted as a failure
// of representation.
const multiSource = storyRows.filter((s) => s.distinctSources > 1).length;

const report = {
  measuredAt: new Date().toISOString(),
  snapshot: {
    path: SNAPSHOT_PATH,
    compiledAt: snapshot?.edition?.buildCompletedAt ?? null,
    contentThrough: snapshot?.edition?.sourceLatestFetchAt ?? null,
  },
  roster: {
    configured,
    enabled,
    configuredTotal: sources.length,
    enabledTotal: sources.filter((s) => s.enabled !== false).length,
    disabled,
  },
  edition: {
    articles: totalDisplayed,
    scored,
    unscored,
    partialOrPaywalled: partialExtraction,
    displayed,
    displayedPct: Object.fromEntries(BASELINES.map((b) => [b, pct(displayed[b], totalDisplayed)])),
    distinctSources: Object.fromEntries(BASELINES.map((b) => [b, distinctSources.get(b).size])),
    distinctSourcesTotal: new Set(articles.map((a) => a.sourceName)).size,
    broadLeft,
    centre,
    broadRight,
    broadLeftPct: pct(broadLeft, totalDisplayed),
    centrePct: pct(centre, totalDisplayed),
    broadRightPct: pct(broadRight, totalDisplayed),
    wingGap: broadLeft - broadRight,
    wingGapPct: Math.round((pct(broadLeft, totalDisplayed) - pct(broadRight, totalDisplayed)) * 10) / 10,
  },
  stories: {
    total: storyRows.length,
    multiSource,
    bilateral,
    bilateralPctOfAll: pct(bilateral, storyRows.length),
    bilateralPctOfMultiSource: pct(bilateral, multiSource),
    rows: storyRows,
  },
  internalReliability: {
    note:
      "LITMUS's own reliability rating. Assigned by hand, no published methodology " +
      "(litmus-server/sources/README.md), and not evidence about any outlet. " +
      "Reported so the number is visible, never so a surface can cite it.",
    articleWeightedMean: Object.fromEntries(
      BASELINES.map((b) => [
        b,
        reliabilityWeighted[b].n === 0
          ? null
          : Math.round((reliabilityWeighted[b].sum / reliabilityWeighted[b].n) * 100) / 100,
      ]),
    ),
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// ── Human-readable ─────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(`\nLITMUS representation audit`);
console.log(`snapshot: ${SNAPSHOT_PATH}`);
console.log(
  `edition compiled ${report.snapshot.compiledAt ?? "unknown"}, content through ${report.snapshot.contentThrough ?? "unknown"}\n`,
);

console.log(`ROSTER (${report.roster.configuredTotal} configured, ${report.roster.enabledTotal} enabled)`);
console.log(`  ${pad("baseline", 14)}${padL("configured", 11)}${padL("enabled", 9)}`);
for (const b of BASELINES) {
  console.log(`  ${pad(b, 14)}${padL(configured[b], 11)}${padL(enabled[b], 9)}`);
}
if (disabled.length > 0) {
  console.log(`  disabled: ${disabled.map((d) => `${d.name} (${d.lean})`).join(", ")}`);
}

console.log(`\nEDITION (${totalDisplayed} articles from ${report.edition.distinctSourcesTotal} distinct sources)`);
console.log(`  ${pad("baseline", 14)}${padL("articles", 9)}${padL("share", 8)}${padL("sources", 9)}`);
for (const b of BASELINES) {
  console.log(
    `  ${pad(b, 14)}${padL(displayed[b], 9)}${padL(`${report.edition.displayedPct[b]}%`, 8)}${padL(report.edition.distinctSources[b], 9)}`,
  );
}
console.log(
  `  broad left ${report.edition.broadLeftPct}% · centre ${report.edition.centrePct}% · broad right ${report.edition.broadRightPct}%` +
    `  (wing gap ${report.edition.wingGap >= 0 ? "+" : ""}${report.edition.wingGap} articles, ${report.edition.wingGapPct >= 0 ? "+" : ""}${report.edition.wingGapPct} points toward the left)`,
);
console.log(`  scored ${scored}, unscored ${unscored}, paywalled or partial ${partialExtraction}`);

console.log(`\nSTORIES — can a reader compare left against right on this story?`);
console.log(`  ${storyRows.length} stories, ${multiSource} covered by more than one outlet`);
console.log(
  `  ${bilateral} carry BOTH a broad-left and a broad-right outlet` +
    `  (${report.stories.bilateralPctOfAll}% of all stories, ${report.stories.bilateralPctOfMultiSource}% of multi-outlet stories)`,
);
console.log(
  `\n  This is the number the product rests on. Edition-wide shares can look even` +
    `\n  while most individual stories are single-sided, which is what a reader` +
    `\n  actually encounters.\n`,
);
for (const s of storyRows) {
  const mark = s.bilateral ? "L+R" : s.hasLeft ? "L  " : s.hasRight ? "  R" : "  ·";
  const topic = s.topic.length > 52 ? `${s.topic.slice(0, 49)}...` : s.topic;
  console.log(`  ${mark}  ${padL(s.outlets, 3)} outlets  ${topic}`);
}

console.log(`\nINTERNAL RELIABILITY RATING (LITMUS's own, no published methodology)`);
for (const b of BASELINES) {
  const v = report.internalReliability.articleWeightedMean[b];
  console.log(`  ${pad(b, 14)}${padL(v === null ? "n/a" : v.toFixed(2), 6)}`);
}
console.log(
  `  Not evidence about any outlet, and no surface cites it. See\n` +
    `  litmus-server/sources/README.md before treating these as comparable.\n`,
);
