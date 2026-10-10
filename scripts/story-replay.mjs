// The Story Ledger's I2 paid replay (docs/plans/story-first-build-2026-09-13.md
// Phase 1 of the relaunch continuation). Reconstructs the exact 2026-09-13
// front-page edition (200 articles, metadata only, NEVER rawText) in a scratch
// embedded Postgres, runs the real Story Ledger against it with real Sonnet 5,
// and scores the result against docs/audits/ground-truth-2026-09-13/
// reconciled-true-groups.json — a corrected, cited extraction of the aggregator
// audit's own findings (see that file's "citation" fields for exact sourcing).
//
//   node scripts/story-replay.mjs
//
// Article/source metadata comes from a local, gitignored archive
// (~/LITMUS2/.backups/litmus-original-2026-09-13/live-site/assets/snapshot-*.js)
// captured before the 2026-09-13 legal-armor pass. That bundle's articleDetail
// records carry a rawText field; this script reads only id, sourceId,
// sourceName, sourceLean, url, title, author, publishedAt, wordCount,
// extractionStatus, fetchedAt, score.articleSummary and score.section — it
// never touches rawText, and raw_text is inserted as '' for every row.
//
// Production DB access was checked and is not available locally (the
// server's own .env points at localhost, not Neon), so this is the one
// dataset on disk that matches the audit's article-ID range exactly
// (buildCompletedAt 2026-09-13T16:27:41Z, 200 articles, 3 clusters — the same
// counts docs/audits/ground-truth-2026-09-13/measure.json was built against).
//
// Cost control: this run is bounded to 200 articles (not the wider 14-day
// backlog), which keeps every stage's max_tokens formula small. A LIVE
// watchdog polls story_run_usage every few seconds while the run is in
// progress and SIGKILLs it the moment measured spend would cross --cap
// (default $75; Max authorized spending past the plan's original $15 target
// on 2026-09-16 after the first attempt hit that cap with assignment still
// mid-flight and sweep/critic — the stages that actually catch and merge
// related articles — never reached).

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { slugify, outletShortName, outletKeyFor, uniqueSlug } from "./stories-fixture.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_DIR = path.join(ROOT, "litmus-server");
// Both are litmus-server devDependencies, not root-level, same as
// isolation-test.mjs's EmbeddedPostgres resolution.
const serverRequire = createRequire(path.join(SERVER_DIR, "package.json"));
const EmbeddedPostgres = serverRequire("embedded-postgres").default;
const { Client } = serverRequire("pg");

const ARCHIVE_SNAPSHOT =
  "/path/to/litmus/.backups/litmus-original-2026-09-13/live-site/assets/snapshot-WWiD0q9m.js";
const REAL_ENV_FILE = "/path/to/litmus/litmus-server/.env";
const GROUND_TRUTH = path.join(
  ROOT,
  "docs/audits/ground-truth-2026-09-13/reconciled-true-groups.json",
);

// Published per-MTok pricing, verified against platform.claude.com/docs/en/
// about-claude/pricing 2026-09-17. Keyed by the exact model id story_run_usage
// rows carry, so a --model run is priced correctly instead of silently reusing
// Sonnet 5's rate. Re-check before trusting these constants on a future run.
//
// Cache multipliers (2026-09-20 fix): cache_creation_input_tokens was billed
// at the plain input rate and cache_read_input_tokens was omitted entirely
// ("billed far below input price" - true, but far below is not zero), both
// undercounting every run's real cost. No code in this pipeline sets an
// explicit 1h TTL, so every write is the default 5-minute ephemeral cache:
// standard Anthropic pricing is 1.25x base input for a 5m write, 0.1x base
// input for a read (verified via the claude-api skill's cache-pricing
// reference, not assumed).
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;
const MODEL_PRICING = {
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
};
function pricingFor(model) {
  const rate = MODEL_PRICING[model];
  if (!rate) throw new Error(`no pricing entry for model "${model}" — add one to MODEL_PRICING before trusting this run's cost`);
  return rate;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function loadRealApiKey() {
  const text = await readFile(REAL_ENV_FILE, "utf-8");
  const m = text.match(/^ANTHROPIC_API_KEY=(.+)$/m);
  if (!m) throw new Error(`ANTHROPIC_API_KEY not found in ${REAL_ENV_FILE}`);
  return m[1].trim();
}

export async function loadArchive() {
  if (!existsSync(ARCHIVE_SNAPSHOT)) {
    throw new Error(`archived pre-strip snapshot not found: ${ARCHIVE_SNAPSHOT}`);
  }
  const mod = await import(ARCHIVE_SNAPSHOT);
  const d = mod.default;
  const sources = d.sources.map((s) => ({
    id: s.id,
    name: s.name,
    rssUrl: s.rssUrl,
    lean: s.lean,
    type: s.type,
    paywallStatus: s.paywallStatus,
    reliability: s.reliability,
    enabled: s.enabled,
  }));
  const articles = d.articles.map((a) => ({
    id: a.id,
    sourceId: a.sourceId,
    sourceName: a.sourceName,
    sourceLean: a.sourceLean,
    url: a.url,
    title: a.title,
    author: a.author ?? null,
    publishedAt: a.publishedAt,
    wordCount: a.wordCount,
    extractionStatus: a.extractionStatus,
    paywallFlag: a.paywallFlag,
    fetchedAt: a.fetchedAt,
    // score is present on every article in this snapshot (it is the
    // already-scored front page); guard anyway rather than assume.
    articleSummary: a.score?.articleSummary ?? "",
    section: a.score?.section ?? null,
    // Kept nested (not flattened) so --write-fixture can build real
    // StoryMemberDTOs from real ledger membership without a second load —
    // composite, politicalLean, and the capped, already-marker-trimmed
    // excerpt the client renders. Never touched for seeding.
    score: a.score ?? null,
    excerpt: a.excerpt ?? null,
  }));
  return { sources, articles, frozenAt: d.frozenAt };
}

export async function seedScratchDb(dsn, { sources, articles }) {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const s of sources) {
      await client.query(
        `INSERT INTO sources (id, name, rss_url, lean, type, paywall_status, reliability, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [s.id, s.name, s.rssUrl, s.lean, s.type, s.paywallStatus, s.reliability, s.enabled],
      );
    }
    await client.query(`SELECT setval('sources_id_seq', (SELECT MAX(id) FROM sources))`);

    for (const a of articles) {
      // content_hash is NOT NULL but unused by the ledger; a stand-in from
      // title+url keeps the column's contract without ever hashing body text.
      await client.query(
        `INSERT INTO articles
           (id, source_id, url, title, author, published_at, raw_text, word_count,
            extraction_status, paywall_flag, content_hash, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,'',$7,$8,$9,md5($4 || $3),$10)
         ON CONFLICT (id) DO NOTHING`,
        [
          a.id,
          a.sourceId,
          a.url,
          a.title,
          a.author,
          a.publishedAt,
          a.wordCount,
          a.extractionStatus,
          a.paywallFlag,
          a.fetchedAt,
        ],
      );
      await client.query(
        `INSERT INTO scores
           (article_id, headline, language, sourcing, fallacies, structure, composite,
            label, rationale_json, article_summary, section, model_used)
         VALUES ($1, 1,1,1,1,1,1, 'Grounded', '{}'::jsonb, $2, $3, 'replay-seed')
         ON CONFLICT (article_id) DO NOTHING`,
        [a.id, a.articleSummary, a.section],
      );
    }
    await client.query(`SELECT setval('articles_id_seq', (SELECT MAX(id) FROM articles))`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
  console.log(`  seeded ${sources.length} sources, ${articles.length} articles + scores`);
}

export function run(cmd, args, env, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${label ?? [cmd, ...args].join(" ")}`);
    const child = spawn(cmd, args, { cwd: SERVER_DIR, env, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`))));
    child.on("error", reject);
  });
}

// mergeCandidatePairs (src/stories/critic.ts) is O(n^2) over minted stories
// before its cheap same-outlet/48h/shared-proper-noun filter — a filter that
// is only as selective as the model's real headlines. A dry run with
// meaningless fixture headlines passed ~92% of possible pairs, which is not
// evidence about real text but is reason enough not to trust an estimate.
// This watchdog polls the scratch DB's own usage ledger while the real run is
// live and SIGKILLs it the moment measured spend would cross the cap — a hard
// stop, not a warning, and it needs no change to the ledger's own code.
async function runStoriesWithCostWatchdog(env, dsn, capUsd, model) {
  const rate = pricingFor(model);
  console.log(`\n$ npm run stories (REAL ${model}, watchdog capped at $${capUsd})`);
  const child = spawn("npm", ["run", "stories"], { cwd: SERVER_DIR, env, stdio: "inherit" });
  const client = new Client({ connectionString: dsn });
  await client.connect();
  let killedForCost = false;
  let lastReported = 0;
  const interval = setInterval(async () => {
    try {
      const { rows } = await client.query(
        `SELECT COALESCE(SUM(input_tokens),0) AS in_tok,
                COALESCE(SUM(cache_creation_input_tokens),0) AS cache_write_tok,
                COALESCE(SUM(cache_read_input_tokens),0) AS cache_read_tok,
                COALESCE(SUM(output_tokens),0) AS out_tok, COUNT(*)::int AS n
           FROM story_run_usage`,
      );
      const { in_tok, cache_write_tok, cache_read_tok, out_tok, n } = rows[0];
      const dollars =
        (Number(in_tok) / 1_000_000) * rate.input +
        (Number(cache_write_tok) / 1_000_000) * rate.input * CACHE_WRITE_5M_MULTIPLIER +
        (Number(cache_read_tok) / 1_000_000) * rate.input * CACHE_READ_MULTIPLIER +
        (Number(out_tok) / 1_000_000) * rate.output;
      if (dollars - lastReported >= 0.5) {
        console.log(`  [watchdog] ${n} calls so far, running cost $${dollars.toFixed(2)}`);
        lastReported = dollars;
      }
      if (dollars >= capUsd) {
        killedForCost = true;
        console.error(`\n[watchdog] COST CAP HIT: $${dollars.toFixed(2)} >= $${capUsd}. Killing the run now.`);
        child.kill("SIGKILL");
      }
    } catch {
      // scratch db may be between statements; try again next tick
    }
  }, 4000);

  try {
    await new Promise((resolve, reject) => {
      child.on("exit", (code) => {
        if (killedForCost) reject(new Error("killed by the cost watchdog"));
        else if (code === 0) resolve();
        else reject(new Error(`story ledger exited ${code}`));
      });
      child.on("error", reject);
    });
  } finally {
    clearInterval(interval);
    await client.end();
  }
}

async function queryResults(dsn) {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    const { rows: members } = await client.query(
      `SELECT story_id, article_id, role, kind, confidence, reason, syndicated_of_article_id
         FROM story_members ORDER BY story_id, article_id`,
    );
    const { rows: stories } = await client.query(
      `SELECT id, headline, event_statement, status, merged_into, first_seen_at, updated_at
         FROM stories ORDER BY first_seen_at`,
    );
    const { rows: usage } = await client.query(
      `SELECT stage, model, status, input_tokens, output_tokens,
              cache_creation_input_tokens, cache_read_input_tokens, wall_ms
         FROM story_run_usage ORDER BY run_id, stage, call_index`,
    );
    const { rows: runs } = await client.query(
      `SELECT id, started_at, finished_at, counts, sweep_complete FROM story_runs ORDER BY id`,
    );
    return { members, stories, usage, runs };
  } finally {
    await client.end();
  }
}

// A story that was merged into another resolves to its final target, exactly
// as the client is expected to follow stories.merged_into (docs/plans/
// story-first-build-2026-09-13.md's "Contract" section).
function resolveStoryId(storyId, storiesById) {
  let current = storyId;
  const seen = new Set();
  while (true) {
    const story = storiesById.get(current);
    if (!story || story.status !== "merged" || !story.merged_into) return current;
    if (seen.has(current)) return current; // guard against a cycle, which the schema forbids anyway
    seen.add(current);
    current = story.merged_into;
  }
}

// 2026-09-17: discovered by a free retrieval diagnostic after every real run
// landed at exactly 50% cohesion recall regardless of model/batch tuning —
// pa-woman-dies-of-measles (34543, 34734) and 2 of amodei-essay-and-direct-
// reactions's 5 articles (34735, 34548) are cited in the ground truth itself
// as "[front-200]" (docs/audits/ground-truth-2026-09-13/map_ground-truth.json,
// verify_measure.json line 17) but are NOT present in the archived snapshot
// this replay actually loads — confirmed against snapshot-WWiD0q9m.js
// directly, not a scoring bug. A group whose required article was never
// loaded into the scratch DB scores `null` for that placement and can never
// pass `allSame`, which is not a measurement of the ledger's real accuracy.
// This mirrors the file's OWN existing precedent for the same situation
// (trump-attacks-aoc-mamdani-911-laughing: "only 34612 is inside this
// replay's snapshot window, so this group is scored as the one testable
// member") — applied here mechanically via the archive's actual article set
// rather than hand-picked per group.
export function scoreAgainstGroundTruth(members, stories, groundTruth, archiveArticleIds) {
  const storiesById = new Map(stories.map((s) => [s.id, s]));
  const finalStoryOf = new Map();
  for (const m of members) {
    finalStoryOf.set(m.article_id, resolveStoryId(m.story_id, storiesById));
  }

  const cohesion = [];
  const outOfScope = [];
  for (const g of groundTruth.trueGroups) {
    if (g.articleIds.length < 2) continue; // singleton groups have no internal pair to test
    const testableIds = g.articleIds.filter((id) => archiveArticleIds.has(id));
    const droppedIds = g.articleIds.filter((id) => !archiveArticleIds.has(id));
    if (testableIds.length < 2) {
      outOfScope.push({
        group: g.id,
        articleIds: g.articleIds,
        reason: `${droppedIds.length} of ${g.articleIds.length} required articles (${droppedIds.join(", ")}) are not present in this archive's 200-article snapshot, so fewer than 2 testable members remain — this group cannot test cohesion here.`,
      });
      continue;
    }
    const placements = testableIds.map((id) => finalStoryOf.get(id) ?? null);
    const allSame = placements.every((p) => p !== null && p === placements[0]);
    cohesion.push({
      group: g.id,
      articleIds: testableIds,
      placements,
      pass: allSame,
      ...(droppedIds.length > 0 ? { droppedIds } : {}),
    });
  }

  const separation = [];
  const byId = new Map(groundTruth.trueGroups.map((g) => [g.id, g]));
  for (const [aId, bId] of groundTruth.requiredSeparations) {
    const a = byId.get(aId);
    const b = byId.get(bId);
    // Only defined for the singleton members named in this replay's reconciled
    // groups; if a group grew members later this still checks its full set.
    const aStories = new Set(a.articleIds.map((id) => finalStoryOf.get(id) ?? null));
    const bStories = new Set(b.articleIds.map((id) => finalStoryOf.get(id) ?? null));
    const overlap = [...aStories].some((s) => s !== null && bStories.has(s));
    separation.push({ pair: [aId, bId], articleIds: [a.articleIds, b.articleIds], pass: !overlap });
  }

  const excludedPlacements = groundTruth.excludedFromScoring.map((e) => ({
    articleId: e.articleId,
    placedIn: finalStoryOf.get(e.articleId) ?? null,
    reason: e.reason,
  }));

  return { cohesion, separation, excludedPlacements, outOfScope };
}

// Builds real StoryDTOs from the ledger's actual output — the alternative to
// scripts/stories-fixture.mjs's cluster-based fixture, which reads the OLD
// clusterer's output (measured: 50% membership precision, missed 9 of 15 real
// multi-outlet stories that night — docs/audits/aggregator-and-process-audit-
// 2026-09-13.md). Headline and event_statement are the real Sonnet text S3
// wrote; assessment is null and notes is [] because S4/S5 were not run in
// this pass — the DTO's own "Assessment pending" and empty-notes states
// already handle that honestly, matching what stories-fixture.mjs does when
// it has nothing to show either.
function buildStoryDTOsFromRealLedger(members, stories, runs, articlesById) {
  const storiesById = new Map(stories.map((s) => [s.id, s]));
  const survivors = stories.filter((s) => s.status !== "merged");
  const byStory = new Map(survivors.map((s) => [s.id, []]));
  for (const m of members) {
    const finalId = resolveStoryId(m.story_id, storiesById);
    const bucket = byStory.get(finalId);
    if (bucket) bucket.push(m);
  }

  const sweepComplete = runs.every((r) => r.sweep_complete);
  const taken = new Set();
  const dtos = [];
  for (const story of survivors) {
    const rawMembers = byStory.get(story.id) ?? [];
    if (rawMembers.length === 0) continue; // every member landed elsewhere after a merge
    const dtoMembers = rawMembers.map((m) => {
      const a = articlesById.get(m.article_id);
      const composite = typeof a?.score?.composite === "number" ? a.score.composite : null;
      return {
        articleId: m.article_id,
        outletKey: outletKeyFor(a?.sourceName ?? `source-${m.article_id}`),
        outletName: outletShortName(a?.sourceName ?? "Unknown outlet"),
        sourceLean: a?.sourceLean ?? "center",
        title: a?.title ?? "(untitled)",
        url: a?.url ?? "",
        publishedAt: a?.publishedAt ?? null,
        kind: m.kind,
        syndicatedOfArticleId: m.syndicated_of_article_id ?? null,
        role: m.role,
        composite,
        politicalLean: typeof a?.score?.politicalLean === "number" ? a.score.politicalLean : null,
        howItWasTold: typeof a?.score?.rationale?.summary === "string" ? a.score.rationale.summary : null,
        heat: null, // the replay has no stored breakdown; the API builds this from the score row
        excerpt: a?.excerpt ?? null,
      };
    });
    const primary = dtoMembers.filter((m) => m.role === "primary");
    const outletCount = new Set(primary.map((m) => m.outletKey)).size;
    const scored = dtoMembers.map((m) => m.composite).filter((c) => typeof c === "number");
    const sections = dtoMembers.map((m) => articlesById.get(m.articleId)?.section).filter(Boolean);
    const section = sections.length > 0 ? sections.sort((a, b) => sections.filter((v) => v === a).length - sections.filter((v) => v === b).length).pop() : null;
    dtos.push({
      id: story.id,
      slug: uniqueSlug(slugify(story.headline), taken),
      section,
      headline: story.headline,
      eventStatement: story.event_statement,
      assessment: null,
      firstSeenAt: story.first_seen_at.toISOString(),
      updatedAt: story.updated_at.toISOString(),
      outletCount,
      memberCount: dtoMembers.length,
      phMin: scored.length ? Math.min(...scored) : null,
      phMax: scored.length ? Math.max(...scored) : null,
      singleOutlet: outletCount <= 1,
      members: dtoMembers,
      notes: [],
      coverage: { excluded: [], sweepComplete },
    });
  }
  return dtos;
}

function computeCost(usage) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let dollars = 0;
  for (const row of usage) {
    inputTokens += row.input_tokens + row.cache_creation_input_tokens;
    outputTokens += row.output_tokens;
    cacheReadTokens += row.cache_read_input_tokens;
    const rate = pricingFor(row.model);
    dollars +=
      (row.input_tokens / 1_000_000) * rate.input +
      (row.cache_creation_input_tokens / 1_000_000) * rate.input * CACHE_WRITE_5M_MULTIPLIER +
      (row.cache_read_input_tokens / 1_000_000) * rate.input * CACHE_READ_MULTIPLIER +
      (row.output_tokens / 1_000_000) * rate.output;
  }
  return { inputTokens, outputTokens, cacheReadTokens, dollars };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const capArg = process.argv.find((a) => a.startsWith("--cap="));
  const fixtureArg = process.argv.find((a) => a.startsWith("--write-fixture="));
  const fixtureOut = fixtureArg ? fixtureArg.slice("--write-fixture=".length) : null;
  // Model-comparison lever (STORY_MODEL, wired into storyCron.ts 2026-09-18).
  // Default matches production's models.stories in litmus-server/src/lib/
  // anthropic.ts - keep that in sync if it ever changes.
  const modelArg = process.argv.find((a) => a.startsWith("--model="));
  const storyModel = modelArg ? modelArg.slice("--model=".length) : "claude-sonnet-5";
  pricingFor(storyModel); // fail fast on a typo'd/unpriced model, before any spend
  // 2026-09-16 first attempt: the watchdog correctly stopped a real run at
  // $15.00 after 28 calls, with assignment still mid-flight (169/200 members
  // placed) and sweep/critic — the stages that actually catch and merge
  // related articles — never reached. Max authorized spending more than the
  // plan's original $15 target ("we can go over $15, the end product is more
  // important than a few dollars"); default raised to give real headroom for
  // a full run instead of guessing a second too-tight number.
  const costCapUsd = capArg ? Number(capArg.slice("--cap=".length)) : 75;

  console.log("story ledger replay");
  console.log(`  mode: ${dryRun ? "DRY RUN (fixture model, no spend)" : `REAL ${storyModel}, real spend`}`);
  console.log(`  cost cap: $${costCapUsd}`);

  const [archive, groundTruthRaw, apiKey] = await Promise.all([
    loadArchive(),
    readFile(GROUND_TRUTH, "utf-8").then(JSON.parse),
    dryRun ? Promise.resolve("sk-ant-DRY-RUN-UNUSED") : loadRealApiKey(),
  ]);
  console.log(`  archive edition frozen at ${archive.frozenAt}, ${archive.articles.length} articles, ${archive.sources.length} sources`);

  const dataDir = await mkdtemp(path.join(tmpdir(), "litmus-replay-pg-"));
  const PORT = await freePort();
  const dsn = `postgres://litmus:litmus@127.0.0.1:${PORT}/litmus`;
  const pg2 = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "litmus",
    password: "litmus",
    port: PORT,
    persistent: false,
  });

  const baseEnv = {
    ...process.env,
    DATABASE_URL: dsn,
    LITMUS_ISOLATED: "1", // DSN is 127.0.0.1, so this only ADDS the local-only + no-deploy-creds guards
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    STORY_COVERAGE_OUT: path.join(dataDir, "coverage-report.json"),
  };
  const scoringEnv = { ...baseEnv, ANTHROPIC_FAKE: "1", ANTHROPIC_API_KEY: "sk-ant-UNUSED-FIXTURE" };
  const storyEnv = dryRun
    ? { ...scoringEnv, STORY_MODEL: storyModel }
    : { ...baseEnv, ANTHROPIC_API_KEY: apiKey, STORY_MODEL: storyModel };

  try {
    await pg2.initialise();
    await pg2.start();
    await pg2.createDatabase("litmus");
    console.log(`  scratch db ready at ${dsn}`);

    await run("npm", ["run", "db:init:node"], baseEnv, "schema");
    await run("npm", ["run", "migrate:up"], baseEnv, "migrations");
    await seedScratchDb(dsn, archive);
    let stoppedByWatchdog = false;
    try {
      if (dryRun) {
        await run("npm", ["run", "stories"], storyEnv, "story ledger (fixture)");
      } else {
        await runStoriesWithCostWatchdog(storyEnv, dsn, costCapUsd, storyModel);
      }
    } catch (err) {
      if (String(err.message).includes("killed by the cost watchdog")) {
        stoppedByWatchdog = true;
        console.error("\nRun stopped by the cost watchdog. Reporting on partial results below.");
      } else {
        throw err;
      }
    }

    const { members, stories, usage, runs } = await queryResults(dsn);
    const cost = computeCost(usage);
    const groundTruth = groundTruthRaw;
    const archiveArticleIds = new Set(archive.articles.map((a) => a.id));
    const { cohesion, separation, excludedPlacements, outOfScope } = scoreAgainstGroundTruth(
      members,
      stories,
      groundTruth,
      archiveArticleIds,
    );

    console.log("\n=== RUN SUMMARY ===");
    console.log(`story_runs: ${JSON.stringify(runs.map((r) => ({ id: r.id, counts: r.counts, sweepComplete: r.sweep_complete })))}`);
    console.log(`stories minted: ${stories.length}, members: ${members.length}`);
    console.log(`model calls: ${usage.length}`);
    console.log(
      `tokens: ${cost.inputTokens.toLocaleString()} in (+ ${cost.cacheReadTokens.toLocaleString()} cache-read), ` +
      `${cost.outputTokens.toLocaleString()} out -> $${cost.dollars.toFixed(4)} (cap $${costCapUsd})`,
    );

    console.log("\n=== COHESION (should be one story) ===");
    for (const c of cohesion) {
      const droppedNote = c.droppedIds ? `  [scored on testable subset only — ${c.droppedIds.join(", ")} not in this archive]` : "";
      console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.group}  ids=${c.articleIds}  ->  stories=${JSON.stringify(c.placements)}${droppedNote}`);
    }
    if (outOfScope.length > 0) {
      console.log("\n=== COHESION — out of scope (not counted toward the recall target) ===");
      for (const o of outOfScope) {
        console.log(`  ${o.group}  ids=${o.articleIds}  — ${o.reason}`);
      }
    }
    console.log("\n=== SEPARATION (must NOT merge — the audit's named regressions) ===");
    for (const s of separation) {
      console.log(`  ${s.pass ? "PASS" : "FAIL"}  ${s.pair.join(" vs ")}`);
    }
    console.log("\n=== excluded from scoring (reported for visibility only) ===");
    for (const e of excludedPlacements) {
      console.log(`  article ${e.articleId} -> story ${e.placedIn ?? "(none)"}  — ${e.reason}`);
    }

    const cohesionPassRate = cohesion.length ? cohesion.filter((c) => c.pass).length / cohesion.length : 1;
    const separationPassRate = separation.length ? separation.filter((s) => s.pass).length / separation.length : 1;
    const zeroMerges = separation.every((s) => s.pass);

    console.log("\n=== AGAINST TARGETS ===");
    console.log(`  membership precision (separation pass rate): ${(separationPassRate * 100).toFixed(1)}% (target >= 90%)`);
    console.log(`  story-outlet pair recall (cohesion pass rate): ${(cohesionPassRate * 100).toFixed(1)}% (target >= 80%)`);
    console.log(`  zero merged events in 3+-member stories: ${zeroMerges ? "YES" : "NO"}`);
    console.log(`  cost within $${costCapUsd} cap: ${cost.dollars <= costCapUsd ? "YES" : `NO — $${cost.dollars.toFixed(2)}`}`);

    const meetsTargets = !stoppedByWatchdog && separationPassRate >= 0.9 && cohesionPassRate >= 0.8 && zeroMerges;
    console.log(
      `\n${stoppedByWatchdog ? "STOPPED — COST CAP HIT, TARGETS NOT EVALUATED ON A FULL RUN" : meetsTargets ? "TARGETS MET" : "TARGETS NOT MET"}`,
    );
    process.exitCode = meetsTargets ? 0 : 1;

    if (fixtureOut && !stoppedByWatchdog) {
      const articlesById = new Map(archive.articles.map((a) => [a.id, a]));
      const dtos = buildStoryDTOsFromRealLedger(members, stories, runs, articlesById);
      const multiOutlet = dtos.filter((d) => !d.singleOutlet).length;
      await writeFile(fixtureOut, JSON.stringify(dtos, null, 1));
      console.log(
        `\nwrote ${dtos.length} real stories (${multiOutlet} multi-outlet, ${dtos.length - multiOutlet} single-outlet) to ${fixtureOut}`,
      );
    } else if (fixtureOut) {
      console.error(`\n--write-fixture requested but the run was stopped by the cost watchdog; nothing written.`);
    }
  } finally {
    await pg2.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
}

// 2026-09-17: guarded so importing this file for its exported scoring helper
// (e.g. a free regression check against reconstructed data) can never trigger
// a live, real-money replay by accident — main() only runs when this file is
// the process's actual entry point, not when something else imports it.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("REPLAY FAILED:", err);
    process.exitCode = 1;
  });
}
