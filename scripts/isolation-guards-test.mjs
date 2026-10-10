// Proof that a production-shaped environment cannot escape into an isolated run.
//
//   node scripts/isolation-guards-test.mjs
//
// Every case here is a REFUSAL: the funnel must stop before it ingests, scores,
// writes, or publishes anything. It runs in seconds, touches no database and no
// network, and is safe in CI — unlike scripts/isolation-test.mjs, which proves
// the happy path by running a real ~15-minute ingest.
//
// This file covers the LAYERED stack of guards this script's own bash checks
// and the DSN allowlist enforce, run through refresh.sh's actual step order:
// db:init runs BEFORE the snapshot step, so any case meant to probe
// SNAPSHOT_OUT containment specifically would hit the DSN guard first and
// never reach it. That containment logic — symlinks, hard links, case
// aliases, `../`, nonexistent destinations, a scratch root that would swallow
// the published snapshot's directory — is exhaustively covered in
// scripts/snapshot-writer-guard-test.mjs, which invokes build-snapshot.mjs
// directly rather than through the full funnel.

import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// A deliberately hostile baseline: this is what a shell that can reach
// production looks like.
const PRODUCTION_SHAPED = {
  DATABASE_URL: "postgres://user:pw@ep-prod.us-east-2.aws.neon.tech/litmus",
  ANTHROPIC_API_KEY: "sk-ant-THIS-MUST-NEVER-BE-USED",
  CLOUDFLARE_API_TOKEN: "cf-token-from-the-parent-shell",
  CLOUDFLARE_ACCOUNT_ID: "73b94d8e92209bdb6b522b18cfdc1122",
  API_URL: "https://litmus.maxsheahan.com/api",
};

const CASES = [
  {
    name: "fixtures without isolation are refused",
    env: { ...PRODUCTION_SHAPED, ANTHROPIC_FAKE: "1" },
    expect: /ANTHROPIC_FAKE=1 without LITMUS_ISOLATED=1/,
  },
  {
    name: "isolation without LITMUS_SCRATCH_ROOT is refused",
    env: { ...PRODUCTION_SHAPED, LITMUS_ISOLATED: "1", ANTHROPIC_FAKE: "1" },
    expect: /requires LITMUS_SCRATCH_ROOT/,
  },
  {
    name: "a scratch root with no SNAPSHOT_OUT is refused",
    env: {
      ...PRODUCTION_SHAPED,
      LITMUS_ISOLATED: "1",
      ANTHROPIC_FAKE: "1",
      LITMUS_SCRATCH_ROOT: "/tmp/litmus-guard-proof-root",
    },
    expect: /requires SNAPSHOT_OUT/,
  },
  {
    name: "isolation against a production database is refused",
    // Past every shell and JS snapshot-path guard; the server's DSN allowlist
    // is what stops this one, which is the point — the guards are layered,
    // not a single check.
    env: {
      ...PRODUCTION_SHAPED,
      LITMUS_ISOLATED: "1",
      ANTHROPIC_FAKE: "1",
      LITMUS_SCRATCH_ROOT: "/tmp/litmus-guard-proof-root",
      SNAPSHOT_OUT: "/tmp/litmus-guard-proof-root/snapshot.json",
    },
    expect: /not a local scratch database/,
  },
];

function run(env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(ROOT, "scripts/refresh.sh")], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("exit", (code) => resolve({ code, out }));
    child.on("error", (err) => resolve({ code: -1, out: `spawn error: ${err.message}` }));
  });
}

let failures = 0;
for (const c of CASES) {
  const { code, out } = await run(c.env);
  const refused = code !== 0 && c.expect.test(out);
  console.log(`${refused ? "  PASS" : "  FAIL"}  ${c.name}${refused ? "" : ` (exit=${code})`}`);
  if (!refused) {
    failures++;
    console.log(out.split("\n").slice(-12).join("\n"));
  }
  // Nothing may have been deployed or published by a refused run.
  if (/wrangler pages deploy/.test(out)) {
    console.log("  FAIL  a refused run reached the deploy step");
    failures++;
  }
}

console.log(
  failures === 0
    ? "\nGUARDS HOLD: a production-shaped environment cannot escape into an isolated run.\n"
    : `\nGUARDS LEAK — ${failures} failure(s).\n`,
);
process.exit(failures === 0 ? 0 : 1);
