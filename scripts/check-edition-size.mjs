#!/usr/bin/env node
// Refuses to publish an edition that would shrink the front page when this run
// did not run the story ledger.
//
// 2026-10-09: the 3:45 AM edition run failed, so the site kept the previous
// night's 50 stories. A manual deploy, which never runs the ledger, then
// built and published an edition of 8. Nothing was wrong with the code being
// deployed; the deploy and the edition are the same workflow, and nothing
// compared what was about to go out with what was already there.
//
// The gate only applies to a run WITHOUT a successful ledger. A run whose
// ledger succeeded is the day's real edition and is published whatever its
// size: a slow news day must not be refused. Without a ledger, a count far
// below the live one means this build is missing the day's stories, and the
// fuller edition already live is the better paper.
//
// Each published edition carries /edition-size.json; the next run reads it.
// An edition with no such file (the first run after this shipped), an
// unreachable site, or an unreadable file is "unknown", which is not "smaller":
// the gate says so and lets the run through.
//
//   node scripts/check-edition-size.mjs                  # gate, then write the file
//   node scripts/check-edition-size.mjs --prove-it-fails # run the decision table
//
// Environment:
//   LEDGER_RAN=1               this run's story ledger step succeeded
//   ALLOW_SMALLER_EDITION=1    publish anyway (deliberate, said out loud)
//   LIVE_EDITION_SIZE_URL      default https://litmustimes.com/edition-size.json
//   SNAPSHOT / EDITION_SIZE_OUT  override the input and output paths

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A ledgerless build below this share of the live front page is refused.
export const MIN_SHARE_OF_LIVE = 0.6;
// A live edition older than this has aged out of its own 36-hour window, so
// its count is no longer a fair bar (storyModel.ts TODAYS_PAPER_HOURS).
export const LIVE_COUNT_VALID_HOURS = 36;
// Below this many live stories a percentage is noise.
export const MIN_LIVE_STORIES = 5;

// live: { stories, builtAt } or null when unknown.
export function decide({ newCount, live, ledgerRan, allowSmaller, nowMs }) {
  if (ledgerRan) return { publish: true, reason: "the story ledger ran in this run; its edition is published at any size" };
  if (!live) return { publish: true, reason: "the live edition's size is unknown, so there is nothing to compare with" };
  const liveAgeHours = (nowMs - Date.parse(live.builtAt)) / 3_600_000;
  if (!Number.isFinite(liveAgeHours)) return { publish: true, reason: "the live edition's build time is unreadable, so its size is not a fair bar" };
  if (liveAgeHours > LIVE_COUNT_VALID_HOURS) {
    return { publish: true, reason: `the live edition is ${Math.round(liveAgeHours)}h old, past its ${LIVE_COUNT_VALID_HOURS}h window` };
  }
  if (live.stories < MIN_LIVE_STORIES) return { publish: true, reason: `the live edition has only ${live.stories} stories` };
  const floor = Math.ceil(live.stories * MIN_SHARE_OF_LIVE);
  if (newCount >= floor) return { publish: true, reason: `${newCount} stories against ${live.stories} live (floor ${floor})` };
  const what = `this build has ${newCount} front-page stories, the live edition has ${live.stories}, and this run did not run the story ledger`;
  if (allowSmaller) return { publish: true, reason: `ALLOW_SMALLER_EDITION is set: publishing although ${what}` };
  return {
    publish: false,
    reason:
      `${what}. Publishing would shrink the front page. ` +
      `Re-run with the story ledger (gh workflow run "Daily paper" -f run_story_ledger=true), ` +
      `or publish anyway with -f allow_smaller_edition=true.`,
  };
}

function proveItFails() {
  const now = Date.parse("2026-10-09T18:00:00Z");
  const live = { stories: 50, builtAt: "2026-10-09T03:00:00Z" };
  const cases = [
    ["the 2026-10-09 deploy: 8 against 50, no ledger", { newCount: 8, live, ledgerRan: false, allowSmaller: false }, false],
    ["the same build with the ledger run", { newCount: 8, live, ledgerRan: true, allowSmaller: false }, true],
    ["the same build, deliberately allowed", { newCount: 8, live, ledgerRan: false, allowSmaller: true }, true],
    ["just under the floor", { newCount: 29, live, ledgerRan: false, allowSmaller: false }, false],
    ["at the floor", { newCount: 30, live, ledgerRan: false, allowSmaller: false }, true],
    ["a code deploy that keeps the page", { newCount: 50, live, ledgerRan: false, allowSmaller: false }, true],
    ["no live size known is not a smaller edition", { newCount: 8, live: null, ledgerRan: false, allowSmaller: false }, true],
    ["a live edition past its window", { newCount: 8, live: { stories: 50, builtAt: "2026-10-07T00:00:00Z" }, ledgerRan: false, allowSmaller: false }, true],
    ["an unreadable live build time", { newCount: 8, live: { stories: 50, builtAt: "nonsense" }, ledgerRan: false, allowSmaller: false }, true],
    ["a tiny live edition", { newCount: 1, live: { stories: 4, builtAt: live.builtAt }, ledgerRan: false, allowSmaller: false }, true],
    ["an empty build against a full page", { newCount: 0, live, ledgerRan: false, allowSmaller: false }, false],
  ];
  let failed = 0;
  for (const [name, input, expected] of cases) {
    const got = decide({ ...input, nowMs: now }).publish;
    console.log(`${got === expected ? "PASS" : "FAIL"}  ${name}: ${got ? "publish" : "refuse"}`);
    if (got !== expected) failed += 1;
  }
  if (failed) {
    console.error(`${failed} decision(s) wrong`);
    process.exit(1);
  }
  console.log(`edition-size gate: ${cases.length} decisions, all as expected`);
}

async function readLive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "cache-control": "no-cache" } });
    if (!res.ok) return { live: null, why: `HTTP ${res.status}` };
    const body = await res.json();
    if (typeof body?.stories !== "number" || typeof body?.builtAt !== "string") return { live: null, why: "not an edition-size file" };
    return { live: { stories: body.stories, builtAt: body.builtAt }, why: "" };
  } catch (err) {
    // The Pages fallback serves index.html for a missing file; that lands here.
    return { live: null, why: err instanceof Error ? err.message : String(err) };
  }
}

function countNew(snapshot) {
  const tsx = join(ROOT, "litmus-server", "node_modules", ".bin", "tsx");
  const args = [join(ROOT, "scripts", "front-page-count.ts")];
  if (snapshot) args.push(snapshot);
  const run = spawnSync(tsx, args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`front-page-count failed: ${run.stderr || run.error}`);
  return JSON.parse(run.stdout.trim().split("\n").pop());
}

async function main() {
  const url = process.env.LIVE_EDITION_SIZE_URL ?? "https://litmustimes.com/edition-size.json";
  const out = process.env.EDITION_SIZE_OUT ?? join(ROOT, "litmus-client", "public", "edition-size.json");
  const ledgerRan = process.env.LEDGER_RAN === "1";
  const fresh = countNew(process.env.SNAPSHOT);
  const { live, why } = await readLive(url);
  console.log(
    `edition-size gate: this build ${fresh.stories} front-page stories; live ${live ? `${live.stories} (built ${live.builtAt})` : `unknown (${why})`}; ledger ${ledgerRan ? "ran" : "did not run"}`,
  );
  const verdict = decide({ newCount: fresh.stories, live, ledgerRan, allowSmaller: process.env.ALLOW_SMALLER_EDITION === "1", nowMs: Date.now() });
  if (!verdict.publish) {
    console.error(`edition-size gate: REFUSED. ${verdict.reason}`);
    process.exit(1);
  }
  console.log(`edition-size gate: publish. ${verdict.reason}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ stories: fresh.stories, builtAt: fresh.builtAt, ledgerRan })}\n`);
}

if (process.argv.includes("--prove-it-fails")) proveItFails();
else await main();
