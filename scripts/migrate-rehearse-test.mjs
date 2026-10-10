// Proof that scripts/migrate-rehearse.mjs — the actual script, invoked
// exactly as a person or CI would — reverses what it added and leaves a
// baseline alone.
//
//   node scripts/migrate-rehearse-test.mjs
//
// An earlier version of this test drove migrate:up / migrate:down itself,
// reimplementing the rehearsal's apply-reverse-verify loop by hand. That
// proved the migration RUNNER worked; it never actually ran the REHEARSAL
// SCRIPT, so a bug in migrate-rehearse.mjs itself — its own dump handling,
// its own added-set diffing, its own port selection — had nothing testing it
// end to end. This spawns the real script as a child process, against a real
// dump file and a fixture migrations directory, and asserts on its exit code
// and reported behaviour.
//
// The "dump" is hand-written SQL, not produced by pg_dump: embedded-postgres
// (this project's scratch-database dependency) ships only server binaries —
// postgres, pg_ctl, initdb — no client tools, and pg_dump/psql are not on
// PATH in every environment this runs in. Since the fixture is fully known,
// writing its SQL directly is both simpler and independent of a tool that
// may not exist here.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REHEARSE = path.join(ROOT, "scripts", "migrate-rehearse.mjs");

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// Stable content stamp matching migrationFiles.checksum() exactly — the
// baseline's ledger row must carry the checksum the runner will independently
// recompute from the fixture files, or ledgerDrift correctly refuses the
// rehearsal as drifted rather than proceeding on a false baseline.
function checksum(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

// --- fixtures: one baseline migration (as a dump already carrying it
// applied), two pending. -----------------------------------------------
const migDir = await mkdtemp(path.join(tmpdir(), "litmus-rehearse-test-mig-"));

const UP_0001 = "CREATE TABLE r_baseline (id INT);";
const DOWN_0001 = "DROP TABLE r_baseline;";
await writeFile(path.join(migDir, "0001_baseline.up.sql"), UP_0001);
await writeFile(path.join(migDir, "0001_baseline.down.sql"), DOWN_0001);
await writeFile(path.join(migDir, "0002_first_new.up.sql"), "CREATE TABLE r_first (id INT);");
await writeFile(path.join(migDir, "0002_first_new.down.sql"), "DROP TABLE r_first;");
await writeFile(path.join(migDir, "0003_second_new.up.sql"), "CREATE TABLE r_second (id INT);");
await writeFile(path.join(migDir, "0003_second_new.down.sql"), "DROP TABLE r_second;");

// The dump: 0001 already applied, exactly as a production dump would arrive.
// Hand-written, not generated, per the header.
const dumpFile = path.join(migDir, "baseline-dump.sql");
await writeFile(
  dumpFile,
  [
    UP_0001,
    `CREATE TABLE schema_migrations (`,
    `  version TEXT PRIMARY KEY, name TEXT NOT NULL,`,
    `  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checksum TEXT NOT NULL,`,
    `  down_checksum TEXT, irreversible BOOLEAN NOT NULL DEFAULT FALSE);`,
    `INSERT INTO schema_migrations (version, name, checksum, down_checksum, irreversible)`,
    `VALUES ('0001', '0001_baseline', '${checksum(UP_0001)}', '${checksum(DOWN_0001)}', false);`,
  ].join("\n"),
);

// --- run the REAL rehearsal script end to end ---------------------------
function runRehearsal(args) {
  return new Promise((resolve) => {
    const child = spawn("node", [REHEARSE, ...args], { cwd: ROOT, env: process.env });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("error", (err) => resolve({ code: -1, out: `spawn error: ${err.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const { code, out } = await runRehearsal([dumpFile, `--migrations-dir=${migDir}`]);

check(
  code === 0,
  "migrate-rehearse.mjs exits 0 against the fixture dump and directory",
  code === 0 ? "" : out.split("\n").slice(-30).join("\n"),
);
check(
  /3 migration file\(s\) on disk; 1 already applied/.test(out),
  "reports 3 files on disk, 1 already applied (the baseline)",
  out.match(/\d+ migration file\(s\) on disk; \d+ already applied[^\n]*/)?.[0] ?? "no match",
);
check(/this rehearsal added 2 migration/.test(out), "reports it added exactly 2 migrations (not 3 — the baseline was already there)");
check(/reversing 2 added migration\(s\), newest first/.test(out), "reverses exactly 2, newest first");
check(/REHEARSAL PASSED/.test(out), "the script itself reports PASSED");
check(!/REVERSAL WENT TOO FAR/.test(out), "did not report reversing the baseline");
check(!/REVERSAL INCOMPLETE/.test(out), "did not report an incomplete reversal");

// A negative control: an empty migrations directory must be a clean "nothing
// to rehearse", not a false pass on data it never looked at.
{
  const emptyDir = await mkdtemp(path.join(tmpdir(), "litmus-rehearse-test-empty-"));
  const r = await runRehearsal([`--migrations-dir=${emptyDir}`]);
  check(r.code === 0 && /nothing to rehearse/.test(r.out), "an empty migrations directory reports nothing to rehearse and exits 0");
  await rm(emptyDir, { recursive: true, force: true });
}

await rm(migDir, { recursive: true, force: true });

console.log(
  failures.length === 0
    ? "\nREHEARSAL SCRIPT PROVEN END TO END: 0002 and 0003 reverse in order, 0001 is left alone.\n"
    : `\nREHEARSAL SCRIPT TEST FAILED — ${failures.length} failure(s): ${failures.join("; ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
