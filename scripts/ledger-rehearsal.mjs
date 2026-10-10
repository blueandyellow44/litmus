// Story Ledger rehearsal: step 2 of the run-failure method (Max, 2026-09-22).
//
// A free, full-size dress rehearsal of the ledger step. It runs the REAL
// storyCron.ts, with the real candidate retrieval, the real ledger writes and
// the real critic loop, against a scratch embedded Postgres, with the fake
// model client standing in for Anthropic. It has no spend and no network, and
// it never touches production.
//
//   node scripts/ledger-rehearsal.mjs [--latency-ms=1000] [--budget-min=25]
//                                     [--fail=usage-limit] [--prior=237] [--tag=name]
//
// What it reproduces:
//   - Production's state on 2026-09-22: a day's worth of fresh articles (the
//     real 200-article 2026-09-13 edition, metadata only, re-dated into the
//     1-day window) arriving on top of leftover one-article stories from
//     earlier runs (--prior of them, made from other real headlines in the
//     same archive).
//   - The funnel's step budget: the ledger is killed at --budget-min, exactly
//     like daily.yml's 25-minute step timeout.
//   - Model time: every fake call waits --latency-ms, so phases that make
//     calls one at a time show up in the wall clock.
//   - The account lockout, with --fail=usage-limit.
//
// Report: model calls, time and failures per phase, and whether the run
// finished inside the budget. The fake model cannot judge grouping quality;
// this tests the plumbing, not the model.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { freePort, loadArchive, seedScratchDb, run } from "./story-replay.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_DIR = path.join(ROOT, "litmus-server");
const serverRequire = createRequire(path.join(SERVER_DIR, "package.json"));
const EmbeddedPostgres = serverRequire("embedded-postgres").default;
const { Client } = serverRequire("pg");

const ARCHIVE_SNAPSHOT =
  "/path/to/litmus/.backups/litmus-original-2026-09-13/live-site/assets/snapshot-WWiD0q9m.js";

const PHASE_BY_TOOL = {
  submit_story_decisions: "assignment",
  submit_sweep_results: "sweep",
  submit_split_review: "critic: split",
  submit_merge_review: "critic: merge",
};

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function wholeNumber(name, raw) {
  if (!/^\d+$/.test(String(raw))) throw new Error(`--${name} must be a whole number; got "${raw}"`);
  return Number(raw);
}

// Every headline in the archive that is not one of the 200 test articles:
// real, distinct news headlines for the leftover stories.
async function priorTitles(articleTitles) {
  const d = (await import(ARCHIVE_SNAPSHOT)).default;
  const found = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      if (typeof v.title === "string") found.add(v.title);
      Object.values(v).forEach(walk);
    }
  };
  walk(d);
  return [...found].filter((t) => !articleTitles.has(t));
}

async function withClient(dsn, fn) {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Runs `npm run stories`, tees its output to a log, and kills it at the budget
// the way GitHub Actions does. Resolves with how it ended; never rejects on a
// non-zero exit, because a crash is a result the rehearsal reports.
function runLedger(env, logPath, budgetMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = createWriteStream(logPath);
    const child = spawn("npm", ["run", "stories"], { cwd: SERVER_DIR, env, detached: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, budgetMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ code, killed, wallMs: Date.now() - started });
    });
  });
}

async function summarise(logPath) {
  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(logPath, "utf8")).split("\n");
  const phases = {};
  const failed = {};
  let done = false;
  let lastAppLogMs = null;
  for (const line of lines) {
    const i = line.indexOf('{"t"');
    if (i < 0) continue;
    let rec;
    try { rec = JSON.parse(line.slice(i)); } catch { continue; }
    const t = Date.parse(rec.t);
    lastAppLogMs = t;
    if (rec.msg === "fake model call") {
      const phase = PHASE_BY_TOOL[rec.tool] ?? rec.tool;
      const p = (phases[phase] ??= { calls: 0, firstMs: t, lastMs: t });
      p.calls += 1;
      p.lastMs = t;
    }
    if (/model request failed|attempt failed/.test(rec.msg)) failed[rec.msg] = (failed[rec.msg] ?? 0) + 1;
    if (rec.msg === "story ledger run done") done = true;
  }
  return { phases, failed, done, lastAppLogMs };
}

async function ledgerTables(dsn, runId) {
  return withClient(dsn, async (c) => {
    const usage = await c.query(
      `SELECT stage, status, count(*)::int AS calls FROM story_run_usage WHERE run_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
      [runId],
    );
    const events = await c.query(
      `SELECT action, count(*)::int AS n FROM story_events_log WHERE run_id = $1 GROUP BY 1 ORDER BY 2 DESC`,
      [runId],
    );
    const open = await c.query(`SELECT count(*)::int AS n FROM stories WHERE status <> 'merged'`);
    const states = await c.query(
      `SELECT state, count(*)::int AS n FROM story_article_states WHERE run_id = $1 GROUP BY 1 ORDER BY 1`,
      [runId],
    );
    const runRow = await c.query(`SELECT finished_at IS NOT NULL AS finished, counts FROM story_runs WHERE id = $1`, [runId]);
    return { usage: usage.rows, events: events.rows, openStories: open.rows[0].n, states: states.rows, run: runRow.rows[0] };
  });
}

async function main() {
  const latencyMs = wholeNumber("latency-ms", arg("latency-ms", "1000"));
  const budgetMin = wholeNumber("budget-min", arg("budget-min", "25"));
  const fail = arg("fail", "");
  // --tag=after-fix2 keeps a new report beside the baseline instead of over it.
  const tag = arg("tag", "");
  if (tag !== "" && !/^[a-z0-9-]+$/.test(tag)) throw new Error(`--tag must be lowercase letters, digits and dashes; got "${tag}"`);
  if (fail !== "" && fail !== "usage-limit") throw new Error(`--fail must be "usage-limit"; got "${fail}"`);

  const archive = await loadArchive();
  const titles = await priorTitles(new Set(archive.articles.map((a) => a.title)));
  const priorCount = Math.min(wholeNumber("prior", arg("prior", String(titles.length))), titles.length);

  console.log("story ledger rehearsal (fake model, $0, scratch database)");
  console.log(`  fresh articles: ${archive.articles.length} (real 2026-09-13 edition, re-dated into today's window)`);
  console.log(`  leftover one-article stories: ${priorCount} (real headlines, ~30h old)`);
  console.log(`  model latency: ${latencyMs} ms per call${fail ? `, every call fails: ${fail}` : ""}`);
  console.log(`  budget: ${budgetMin} min (daily.yml's step timeout)`);

  const dataDir = await mkdtemp(path.join(tmpdir(), "litmus-rehearsal-pg-"));
  const port = await freePort();
  const dsn = `postgres://litmus:litmus@127.0.0.1:${port}/litmus`;
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "litmus", password: "litmus", port, persistent: false });
  const baseEnv = {
    ...process.env,
    DATABASE_URL: dsn,
    LITMUS_ISOLATED: "1",
    ANTHROPIC_FAKE: "1",
    ANTHROPIC_API_KEY: "sk-ant-UNUSED-REHEARSAL",
    ANTHROPIC_FAKE_STORIES: "per-article",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    STORY_COVERAGE_OUT: path.join(dataDir, "coverage-report.json"),
  };

  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("litmus");
    await run("npm", ["run", "db:init:node"], baseEnv, "schema");
    await run("npm", ["run", "migrate:up"], baseEnv, "migrations");
    await seedScratchDb(dsn, archive);

    // Park the fresh articles outside every window while the leftovers are
    // built, then add one ~30h-old article per leftover headline.
    await withClient(dsn, async (c) => {
      await c.query(`UPDATE articles SET published_at = NOW() - INTERVAL '10 days', fetched_at = NOW() - INTERVAL '10 days'`);
      const { rows } = await c.query(`SELECT id FROM sources ORDER BY id`);
      for (let i = 0; i < priorCount; i++) {
        const sourceId = rows[i % rows.length].id;
        const url = `https://rehearsal.test/prior/${i}`;
        const { rows: [a] } = await c.query(
          `INSERT INTO articles (source_id, url, title, published_at, raw_text, word_count, extraction_status,
                                 paywall_flag, content_hash, fetched_at)
           VALUES ($1, $2, $3, NOW() - INTERVAL '30 hours', '', 500, 'full', false, md5($3 || $2), NOW() - INTERVAL '30 hours')
           RETURNING id`,
          [sourceId, url, titles[i]],
        );
        await c.query(
          `INSERT INTO scores (article_id, headline, language, sourcing, fallacies, structure, composite,
                               label, rationale_json, article_summary, section, model_used)
           VALUES ($1, 1,1,1,1,1,1, 'Grounded', '{}'::jsonb, $2, NULL, 'rehearsal-seed')`,
          [a.id, titles[i]],
        );
      }
    });

    // Pass A: build the leftovers with instant fake calls. The ledger takes at
    // most 200 articles a run, so repeat until none are left.
    const seedEnv = { ...baseEnv, STORY_LOOKBACK_DAYS: "2", ANTHROPIC_FAKE_LATENCY_MS: "0" };
    for (let pass = 1; pass <= 3; pass++) {
      const left = await withClient(dsn, (c) => c.query(
        `SELECT count(*)::int AS n FROM articles a WHERE a.published_at >= NOW() - INTERVAL '2 days'
           AND NOT EXISTS (SELECT 1 FROM story_members sm WHERE sm.article_id = a.id)`,
      ));
      if (left.rows[0].n === 0) break;
      const r = await runLedger(seedEnv, path.join(dataDir, `seed-${pass}.log`), 10 * 60_000);
      if (r.code !== 0) throw new Error(`seeding pass ${pass} failed (exit ${r.code}); log: ${path.join(dataDir, `seed-${pass}.log`)}`);
    }
    // Pass A made the leftovers just now, so they would read as brand new and
    // sit inside any window. Age them to match their ~30h-old articles, the
    // way production's leftovers from earlier runs look.
    await withClient(dsn, (c) => c.query(
      `UPDATE stories SET first_seen_at = first_seen_at - INTERVAL '30 hours',
                          updated_at = updated_at - INTERVAL '30 hours'`,
    ));
    const seeded = await withClient(dsn, (c) => c.query(`SELECT count(*)::int AS n FROM stories WHERE status <> 'merged'`));
    console.log(`  leftover stories in place: ${seeded.rows[0].n}`);

    // Re-date the real edition into today's 1-day window, keeping its order and
    // relative spacing: newest one hour old, oldest 23 hours old. The edition
    // spans more than a day, so without squeezing only ~54 of its 200
    // articles would be eligible, not the 200-article cap production hits.
    await withClient(dsn, async (c) => {
      const times = archive.articles.map((a) => Date.parse(a.publishedAt));
      const newest = Math.max(...times);
      const span = Math.max(newest - Math.min(...times), 1);
      const WINDOW_MS = 22 * 3600_000;
      for (const a of archive.articles) {
        const ageMs = ((newest - Date.parse(a.publishedAt)) / span) * WINDOW_MS;
        await c.query(
          `UPDATE articles SET published_at = NOW() - INTERVAL '1 hour' - make_interval(secs => $2),
                               fetched_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
          [a.id, ageMs / 1000],
        );
      }
    });

    // Pass B: the rehearsal.
    const logPath = path.join(ROOT, "docs", "run-failures", `rehearsal-${latencyMs}ms-prior${priorCount}${fail ? `-${fail}` : ""}${tag ? `-${tag}` : ""}.log`);
    const env = {
      ...baseEnv,
      ANTHROPIC_FAKE_LATENCY_MS: String(latencyMs),
      ...(fail ? { ANTHROPIC_FAKE_FAIL: fail } : {}),
    };
    delete env.STORY_LOOKBACK_DAYS;
    console.log(`\n  running the ledger... (log: ${path.relative(ROOT, logPath)})`);
    const result = await runLedger(env, logPath, budgetMin * 60_000);
    const s = await summarise(logPath);
    const runId = await withClient(dsn, (c) => c.query(`SELECT max(id)::int AS id FROM story_runs`)).then((r) => r.rows[0].id);
    const tables = await ledgerTables(dsn, runId);

    const outcome = s.done ? "FINISHED" : result.killed ? `KILLED at the ${budgetMin}-min budget` : `CRASHED (exit ${result.code})`;
    const lines = [];
    lines.push(`# Ledger rehearsal: ${latencyMs} ms/call${fail ? `, ${fail}` : ""}`);
    lines.push("");
    lines.push(`Outcome: **${outcome}** after ${(result.wallMs / 60000).toFixed(1)} min.`);
    lines.push(`Fresh articles offered: ${archive.articles.length}. Leftover stories before the run: ${seeded.rows[0].n}. Open stories after: ${tables.openStories}.`);
    lines.push("");
    lines.push("| Phase | Model calls | First call to last call (min) |");
    lines.push("|---|---|---|");
    for (const [phase, p] of Object.entries(s.phases)) {
      lines.push(`| ${phase} | ${p.calls} | ${((p.lastMs - p.firstMs) / 60000).toFixed(1)} |`);
    }
    if (s.lastAppLogMs) {
      const endMs = Date.parse(new Date().toISOString());
      lines.push("");
      lines.push(`Last application log line to the end of the run: ${((endMs - s.lastAppLogMs) / 60000).toFixed(1)} min (the silent tail; fake-call log lines count as output here, production has none).`);
    }
    if (Object.keys(s.failed).length) {
      lines.push("");
      lines.push(`Failure lines logged: ${Object.entries(s.failed).map(([k, v]) => `${k} x${v}`).join("; ")}`);
    }
    lines.push("");
    lines.push(`Articles flagged or marked not-news by this run: ${tables.states.reduce((n, r) => n + r.n, 0)}${tables.states.length ? ` (${tables.states.map((r) => `${r.state} ${r.n}`).join(", ")})` : ""}.`);
    lines.push(`Run record: ${tables.run?.finished ? "closed" : "left open"}, counts ${JSON.stringify(tables.run?.counts ?? {})}.`);
    lines.push("");
    lines.push("story_run_usage for this run (stage, status, calls):");
    for (const u of tables.usage) lines.push(`- ${u.stage} / ${u.status}: ${u.calls}`);
    lines.push("");
    lines.push("story_events_log for this run (action, count):");
    for (const e of tables.events) lines.push(`- ${e.action}: ${e.n}`);
    const report = lines.join("\n") + "\n";
    const reportPath = logPath.replace(/\.log$/, ".md");
    await writeFile(reportPath, report);
    console.log("\n" + report);
    console.log(`report: ${path.relative(ROOT, reportPath)}`);
  } finally {
    await pg.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
