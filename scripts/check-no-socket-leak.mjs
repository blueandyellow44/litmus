#!/usr/bin/env node
// Regression guard for the ingest hang that killed half the scheduled editions.
//
// The bug: rss-parser polled feeds through Node's GLOBAL http/https agents,
// which have keepAlive: true since Node 19. Their pooled sockets are not
// unref'd, so they counted as active handles and held the event loop open after
// ingest had finished all of its work. The process then sat until GitHub killed
// the job at its 45-minute cap. Nothing threw, and no log line was ever written
// after the last one, so it read as a mystery rather than a defect.
//
// What this asserts, against REAL feeds over the network:
//
//   The polling process EXITS ON ITS OWN, promptly, once its work is done.
//
// Termination is the assertion because termination is what actually broke. The
// socket count is reported alongside it as a diagnostic, deliberately NOT as a
// pass/fail criterion: getActiveResourcesInfo() will list a socket that is
// mid-teardown, so the fixed code legitimately reports a handful of sockets
// and still exits in ~20ms. Failing on "sockets > 0" made this check red on
// correct code the first time it ran. The honest invariant is the one CI cares
// about — does the process end?
//
// Both assertions FAIL if rssPoller.ts goes back to the global agents — which
// is the point. A guard nobody has watched fail is an untested claim, so this
// ships with a companion mode:
//
//     node scripts/check-no-socket-leak.mjs --prove-it-fails
//
// which re-runs the same probe deliberately using the global agents and
// requires the leak to appear. If that mode ever reports a clean run, this
// guard has stopped measuring anything and must be repaired, not deleted.
//
// A probe that CRASHES is never a pass in either mode. That distinction is not
// theoretical: the first draft of this script used `tsx --eval`, which compiles
// as CJS and could not resolve the project's .js-suffixed TS imports, so the
// child died in 300ms and the mutation mode reported success on a module error
// rather than on the leak it exists to detect.
//
// Usage:
//   node scripts/check-no-socket-leak.mjs                  # the guard
//   node scripts/check-no-socket-leak.mjs --prove-it-fails  # prove it can fail

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "litmus-server");
const PROVE = process.argv.includes("--prove-it-fails");

// How long a clean run may take to exit after its work is done. The unfixed
// code idled 216-366s in CI and sometimes never exited at all; a correct one
// exits immediately, so anything past a few seconds is the defect returning.
const MAX_EXIT_MS = 8_000;
const HARD_KILL_MS = MAX_EXIT_MS + 20_000;
const FEEDS = 12;

// The probe runs as a real file inside the server package, not via --eval:
// module resolution for the project's TS sources has to work the same way it
// does in production.
const PROBE_PATH = join(SERVER, ".socket-leak-probe.ts");
const PROBE_SRC = `
import { readFile } from "node:fs/promises";
import Parser from "rss-parser";
import { pollFeed } from "./src/ingestion/rssPoller.js";
import type { Source, NewSource } from "./src/types.js";

const PROVE = ${PROVE};

async function main() {
  const seed = JSON.parse(
    await readFile(new URL("./sources/seed.json", import.meta.url), "utf-8"),
  ) as { sources: NewSource[] };

  const sources: Source[] = seed.sources.slice(0, ${FEEDS}).map((s, i) => ({
    id: i + 1, name: s.name, rssUrl: s.rssUrl, lean: s.lean, type: s.type,
    paywallStatus: s.paywallStatus, reliability: s.reliability,
    prominence: s.prominence ?? 1, enabled: true,
    // Required on Source since S1 (outlet identity) and S2 (ingest reads it to
    // tell a sister-feed duplicate from a wire copy). This probe runs through
    // tsx without a typecheck, so a missing field would not fail here; it is
    // set so the literal stays a real Source.
    outletKey: s.outletKey ?? "probe-" + (i + 1), register: s.register ?? null,
  }));

  if (PROVE) {
    // Reproduce the ORIGINAL defect: poll through Node's global agents, which
    // is what an rss-parser constructed with no explicit agent uses.
    const parser = new Parser({
      timeout: 15000,
      headers: { "User-Agent": "Litmus/0.1 (RSS reader)" },
    });
    for (const s of sources) {
      try { await parser.parseURL(s.rssUrl); } catch { /* a dead feed is fine here */ }
    }
  } else {
    for (const s of sources) await pollFeed(s);
  }

  const held = process.getActiveResourcesInfo().filter((r) => r.includes("Socket"));
  console.log("PROBE_RAN=1");
  console.log("SOCKETS_HELD=" + held.length);
  console.log("WORK_DONE_AT=" + Date.now());
}

main().catch((err) => {
  console.error("PROBE_ERROR: " + (err?.stack ?? err));
  process.exit(3);
});
`;

writeFileSync(PROBE_PATH, PROBE_SRC);
const cleanup = () => { try { unlinkSync(PROBE_PATH); } catch { /* already gone */ } };
process.on("exit", cleanup);

const started = Date.now();
const proc = spawn("npx", ["tsx", PROBE_PATH], {
  cwd: SERVER,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgres://unused/unused" },
});

let out = "";
let err = "";
proc.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
proc.stderr.on("data", (d) => {
  const s = String(d);
  err += s;
  if (!s.includes("DeprecationWarning") && !s.includes("trace-deprecation")) process.stderr.write(s);
});

const killTimer = setTimeout(() => proc.kill("SIGKILL"), HARD_KILL_MS);

proc.on("exit", (code, signal) => {
  clearTimeout(killTimer);
  cleanup();

  const ran = /PROBE_RAN=1/.test(out);
  const socketsMatch = out.match(/SOCKETS_HELD=(\d+)/);
  const sockets = socketsMatch ? Number(socketsMatch[1]) : null;
  const workDone = out.match(/WORK_DONE_AT=(\d+)/);
  const elapsedAfterWork = workDone ? Date.now() - Number(workDone[1]) : null;

  const killed = signal === "SIGKILL";
  const slow = elapsedAfterWork !== null && elapsedAfterWork > MAX_EXIT_MS;
  // Diagnostic only — see the header note on why this is not a pass/fail gate.
  const leaked = sockets !== null && sockets > 0;

  console.log("");
  console.log(`mode:              ${PROVE ? "--prove-it-fails (expects a leak)" : "guard (expects none)"}`);
  console.log(`probe ran:         ${ran ? "yes" : "NO — it never completed its work"}`);
  console.log(`sockets listed:    ${sockets ?? "unknown"}   (diagnostic; some may be mid-teardown)`);
  console.log(`exit after work:   ${elapsedAfterWork !== null ? elapsedAfterWork + "ms" : killed ? "never exited" : "n/a"}`);
  console.log(`process exit:      code=${code} signal=${signal ?? "none"}`);
  console.log(`total wall time:   ${Date.now() - started}ms`);
  console.log("");

  // A probe that did not run measures nothing. This is an error in BOTH modes —
  // never let a crash stand in for the leak the mutation mode is meant to show.
  if (!ran && !killed) {
    console.error("ERROR — the probe crashed before finishing its work, so this run proves nothing.");
    if (err.trim()) console.error(err.trim().split("\n").slice(-6).join("\n"));
    process.exit(2);
  }

  if (PROVE) {
    if (leaked || killed || slow) {
      const why = killed ? "the process never exited" : leaked ? `${sockets} socket(s) held the loop` : `exit took ${elapsedAfterWork}ms`;
      console.log(`PASS — the defect reproduces on the global agents (${why}), so this guard can fail.`);
      process.exit(0);
    }
    console.error("FAIL — the deliberate leak did NOT reproduce; the probe ran clean on the global agents.");
    console.error("This guard is no longer measuring anything. Repair it; do not delete it.");
    process.exit(1);
  }

  if (killed) {
    console.error(`FAIL — the poll process never exited (killed after ${HARD_KILL_MS}ms).`);
    console.error("This is the original ingest hang. Check that rssPoller.ts still passes its own");
    console.error("keepAlive:false agents, and that lib/shutdown.ts is still wired into the workers.");
    process.exit(1);
  }
  if (slow) {
    console.error(`FAIL — process took ${elapsedAfterWork}ms to exit after finishing (max ${MAX_EXIT_MS}ms).`);
    console.error("Sockets are being held open past the work; this is the ingest hang returning.");
    process.exit(1);
  }

  console.log(`PASS — process exited on its own in ${elapsedAfterWork}ms (limit ${MAX_EXIT_MS}ms).`);
  if (leaked) console.log(`       (${sockets} socket(s) were still listed at that moment, none blocking — informational.)`);
  process.exit(0);
});
