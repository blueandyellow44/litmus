// The $0 isolation proof. Runs the whole funnel against a throwaway database
// with fixture model responses, then asserts that it touched nothing it should
// not have. This is the gate every later experiment runs behind: if this does
// not pass, no measurement taken in "isolation" can be trusted.
//
//   node scripts/isolation-test.mjs
//
// It exercises the real ingest (live RSS, free) so the poller and the per-source
// ledger are genuinely tested; only the paid model calls are fixtures.

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";

// Fixed ports made this test fail for a reason that had nothing to do with
// isolation: a previous run's API server still held 8799, so the funnel died at
// EADDRINUSE and the proof came back inconclusive. A proof that can fail for an
// unrelated reason is not a proof, so both ports are claimed fresh each run.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const ROOT = path.resolve(import.meta.dirname, "..");

// embedded-postgres is the server package's devDependency, so resolve it from
// there rather than expecting a root-level install.
const serverRequire = createRequire(path.join(ROOT, "litmus-server/package.json"));
const EmbeddedPostgres = serverRequire("embedded-postgres").default;
const CLIENT_SNAPSHOT = path.join(ROOT, "litmus-client/src/demo/snapshot.json");

async function sha256(file) {
  if (!existsSync(file)) return null;
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const dataDir = await mkdtemp(path.join(tmpdir(), "litmus-iso-pg-"));
const outDir = await mkdtemp(path.join(tmpdir(), "litmus-iso-out-"));
const snapshotOut = path.join(outDir, "snapshot.json");
const PORT = await freePort();
const API_PORT = await freePort();
const dsn = `postgres://litmus:litmus@127.0.0.1:${PORT}/litmus`;

console.log("isolation test");
console.log(`  scratch db   ${dataDir} (port ${PORT}, api ${API_PORT})`);
console.log(`  snapshot out ${snapshotOut}`);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "litmus",
  password: "litmus",
  port: PORT,
  persistent: false,
});

const before = await sha256(CLIENT_SNAPSHOT);
let code = null;
let out = "";

try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("litmus");
  console.log("  scratch db ready\n");

  // A deliberately hostile environment: a key IS present, and the run must
  // still make no paid call. Deploy credentials are stripped, which the
  // server-side guard independently enforces.
  const env = {
    ...process.env,
    LITMUS_ISOLATED: "1",
    ANTHROPIC_FAKE: "1",
    SCORE_LIMIT: "5",
    DATABASE_URL: dsn,
    LITMUS_SCRATCH_ROOT: outDir,
    SNAPSHOT_OUT: snapshotOut,
    ANTHROPIC_API_KEY: "sk-ant-ISOLATION-TEST-MUST-NEVER-USE-THIS",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
    PORT: String(API_PORT),
  };

  code = await new Promise((resolve) => {
    // detached so the whole funnel runs in its own process group: a strays
    // child (the API server is the usual one) can then be cleaned up as a
    // group instead of surviving its parent.
    const child = spawn("bash", [path.join(ROOT, "scripts/refresh.sh")], {
      env,
      cwd: ROOT,
      detached: true,
    });
    const tee = (buf) => {
      const s = buf.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    // "exit" fires when the script itself ends. "close" additionally waits for
    // every inherited stdio stream to close, which a leaked background child
    // holds open indefinitely — that hung this proof once already, after a
    // successful run, which is the worst way to fail.
    child.on("exit", (c) => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // group already gone, which is the expected case
      }
      resolve(c);
    });
  });
} finally {
  await pg.stop().catch(() => {});
}

console.log("\nassertions");
check(code === 0, "refresh.sh exited 0", `exit=${code}`);
check(/fake model call/.test(out), "fixture model client was used");
check(
  !/api\.anthropic\.com/.test(out) && !/x-api-key/.test(out),
  "no real Anthropic endpoint appears in the run",
);
check(!/wrangler pages deploy/.test(out), "no deploy was attempted");
check(/ISOLATED RUN/.test(out), "isolation banner printed");

const after = await sha256(CLIENT_SNAPSHOT);
// Say which case held. snapshot.json is gitignored, so in a fresh worktree it
// may be absent — and "null === null" would otherwise report a passing guard
// that never guarded anything.
check(
  before === after,
  "client demo snapshot untouched",
  before === null && after === null
    ? "vacuous: no local snapshot.json to protect"
    : before === after
      ? `unchanged (${String(before).slice(0, 12)})`
      : "IT CHANGED",
);

const wrote = existsSync(snapshotOut);
check(wrote, "snapshot written to SNAPSHOT_OUT");
if (wrote) {
  const size = (await stat(snapshotOut)).size;
  const snap = JSON.parse(await readFile(snapshotOut, "utf-8"));
  check(size > 1000, "snapshot is non-trivial", `${size} bytes`);
  console.log(
    `  info  articles=${(snap.articles ?? []).length} clusters=${(snap.clusters ?? []).length}`,
  );
}

await rm(dataDir, { recursive: true, force: true });
await rm(outDir, { recursive: true, force: true });

console.log(
  failures.length === 0
    ? "\nISOLATION PROVEN: $0 run, scratch database only, no deploy.\n"
    : `\nISOLATION NOT PROVEN — ${failures.length} failure(s): ${failures.join("; ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
