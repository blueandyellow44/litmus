// Exhaustive alias coverage for the snapshot writer's isolation boundary.
//
//   node scripts/snapshot-writer-guard-test.mjs
//
// scripts/isolation-guards-test.mjs proves the layered stack (bash presence
// checks, JS containment, DSN allowlist) refuses a production-shaped
// environment. This file answers a narrower, harder question: given a VALID
// LITMUS_SCRATCH_ROOT, does every way of naming a path OUTSIDE it — including
// the ones that look like they might be inside it — still get refused?
//
// The boundary moved from a deny-list (compare SNAPSHOT_OUT against exactly
// the published snapshot's path) to an allow-list (SNAPSHOT_OUT must resolve
// inside a declared scratch root). A deny-list is defeated by any alias of the
// one forbidden name; an allow-list is defeated only by something that
// resolves inside the root while pointing somewhere else — which is exactly
// what symlinks and hard links do, and exactly what this file tries.
//
// Every refusal case asserts THREE things: the run exits non-zero, the
// counting API received zero requests, and every file this test can name as a
// "candidate destination" — the repair worktree's published snapshot, the
// OTHER worktree's published snapshot at ~/LITMUS2, and the specific alias
// path used in that case — is byte-identical before and after. Read-only
// hashing of ~/LITMUS2's snapshot is the only interaction this file has with
// that directory; nothing here ever opens it for writing.

import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, link, mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const WRITER = path.join(ROOT, "scripts/build-snapshot.mjs");
const PUBLISHED = path.join(ROOT, "litmus-client/src/demo/snapshot.json");
// Read-only reference to the SIBLING worktree's published snapshot. Never
// opened for writing anywhere in this file — see the header.
const OTHER_WORKTREE_SNAPSHOT = "/path/to/litmus/litmus-client/src/demo/snapshot.json";

async function sha256(file) {
  if (!existsSync(file)) return null;
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

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

let hits = 0;
const apiPort = await freePort();
const api = http.createServer((_req, res) => {
  hits++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise((r) => api.listen(apiPort, "127.0.0.1", r));
const localApi = `http://127.0.0.1:${apiPort}/api`;

function run(env) {
  return new Promise((resolve) => {
    const child = spawn("node", [WRITER], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("exit", (code) => resolve({ code, out }));
    child.on("error", (err) => resolve({ code: -1, out: `spawn error: ${err.message}` }));
  });
}

const failures = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// One tmp root for this whole run's scratch material (symlink/hardlink
// targets, the declared scratch root). Wiped at the end.
const workDir = await mkdtemp(path.join(tmpdir(), "litmus-writer-guard-"));
const scratchRoot = path.join(workDir, "scratch-root");
await mkdir(scratchRoot, { recursive: true });

// The hash of every file a refusal case must leave untouched, taken ONCE
// up front. Any refusal case that changes one of these fails immediately,
// regardless of what else it asserts — this is the "zero writes to every
// candidate destination" requirement, not just "the repair worktree's own
// snapshot is unchanged".
const guardedFiles = {
  "this worktree's published snapshot": PUBLISHED,
  "the sibling worktree's published snapshot (~/LITMUS2, read-only check)": OTHER_WORKTREE_SNAPSHOT,
};
const baselineHashes = {};
for (const [label, file] of Object.entries(guardedFiles)) {
  baselineHashes[label] = await sha256(file);
}

async function assertGuardedFilesUnchanged(caseName) {
  for (const [label, file] of Object.entries(guardedFiles)) {
    const now = await sha256(file);
    check(now === baselineHashes[label], `[${caseName}] ${label} is unchanged`, now === baselineHashes[label] ? "" : "CONTENT CHANGED");
  }
}

async function refusalCase(name, env, expectPattern, { extraCandidate } = {}) {
  hits = 0;
  const candidateBefore = extraCandidate && existsSync(extraCandidate) ? await sha256(extraCandidate) : null;
  const candidateExistedBefore = extraCandidate ? existsSync(extraCandidate) : null;

  const { code, out } = await run({
    LITMUS_ISOLATED: "1",
    API_URL: localApi,
    LITMUS_SCRATCH_ROOT: scratchRoot,
    ...env,
  });

  const refused = code !== 0 && expectPattern.test(out);
  check(refused, name, refused ? "" : `exit=${code}\n${out.trim().split("\n").slice(-8).join("\n")}`);
  check(hits === 0, `[${name}] zero API requests`, `hits=${hits}`);
  await assertGuardedFilesUnchanged(name);

  if (extraCandidate) {
    const existsAfter = existsSync(extraCandidate);
    if (!candidateExistedBefore) {
      check(!existsAfter, `[${name}] candidate destination was not created`, existsAfter ? "IT WAS CREATED" : "");
    } else {
      const after = await sha256(extraCandidate);
      check(after === candidateBefore, `[${name}] candidate destination content is unchanged`);
    }
  }
}

// ---------------------------------------------------------------- defaults

await refusalCase(
  "default output (SNAPSHOT_OUT unset) is refused",
  { SNAPSHOT_OUT: "" },
  /requires an explicit SNAPSHOT_OUT/,
);

// ------------------------------------------------------------- off-host API

// Not the real live site. 192.0.2.1 is RFC 5737 TEST-NET-1, reserved
// specifically for documentation and testing and guaranteed to never be a
// real reachable host — an "observable local substitute" in the sense that
// this test can distinguish a fast, clean refusal (the correct behaviour)
// from a hang against a black-holed address (what a broken guard would do,
// since the guard runs before any fetch and refuses synchronously).
{
  const started = Date.now();
  await refusalCase(
    "remote API_URL (non-routable test address, not the real site) is refused",
    { API_URL: "http://192.0.2.1/api", SNAPSHOT_OUT: path.join(scratchRoot, "out.json") },
    /points off this machine/,
  );
  const elapsed = Date.now() - started;
  check(elapsed < 5000, "refusal was fast (no network attempt was made)", `${elapsed}ms`);
}

// ------------------------------------------------------- another worktree

await refusalCase(
  "another worktree's snapshot (~/LITMUS2) is refused",
  { SNAPSHOT_OUT: OTHER_WORKTREE_SNAPSHOT },
  /does not resolve inside LITMUS_SCRATCH_ROOT/,
  { extraCandidate: OTHER_WORKTREE_SNAPSHOT },
);

// --------------------------------------------------------------- ../ alias

{
  // Constructed by STRING CONCATENATION, not path.join — path.join would
  // collapse the literal ".." before it ever reached the child process's
  // environment, which would prove nothing about whether build-snapshot.mjs
  // itself resolves it. The raw string crosses the process boundary intact;
  // canonicalPath() inside the child is what has to collapse it.
  const escapingDotDot = scratchRoot + "/../escaped-outside/out.json";
  await refusalCase(
    "a literal ../ that escapes the scratch root is refused",
    { SNAPSHOT_OUT: escapingDotDot },
    /does not resolve inside LITMUS_SCRATCH_ROOT/,
  );
}

{
  // The positive control: a literal ../ that COLLAPSES BACK inside the root
  // must be accepted. If everything containing ".." were blanket-refused,
  // this would wrongly fail too.
  const innerDir = path.join(scratchRoot, "inner");
  await mkdir(innerDir, { recursive: true });
  const staysInside = innerDir + "/../out.json"; // resolves to scratchRoot/out.json
  hits = 0;
  const { code, out } = await run({
    LITMUS_ISOLATED: "1",
    API_URL: localApi,
    LITMUS_SCRATCH_ROOT: scratchRoot,
    SNAPSHOT_OUT: staysInside,
  });
  const passedGuards = !/snapshot REFUSED/.test(out);
  check(passedGuards, "a ../ that collapses back inside the root is NOT refused by the guards");
  check(hits > 0, "and the run proceeds to read the API", `hits=${hits}`);
}

// ------------------------------------------------------- nonexistent paths

await (async () => {
  // Several nonexistent nested directories, all inside the root. Must be
  // accepted — the destination not existing yet is normal, not a violation.
  const deepNonexistent = path.join(scratchRoot, "does", "not", "exist", "yet", "out.json");
  hits = 0;
  const { out } = await run({
    LITMUS_ISOLATED: "1",
    API_URL: localApi,
    LITMUS_SCRATCH_ROOT: scratchRoot,
    SNAPSHOT_OUT: deepNonexistent,
  });
  check(!/snapshot REFUSED/.test(out), "a nonexistent multi-level path inside the root is NOT refused");
  check(hits > 0, "and the run proceeds", `hits=${hits}`);
})();

await refusalCase(
  "a nonexistent path that escapes the root is still refused",
  { SNAPSHOT_OUT: path.join(scratchRoot, "..", "..", "escaped", "out.json") },
  /does not resolve inside LITMUS_SCRATCH_ROOT/,
);

// --------------------------------------------------------- case aliasing

{
  // On a case-insensitive, case-preserving filesystem (macOS APFS), a
  // case-different name resolves to the SAME file via realpath — proved
  // directly here rather than only end-to-end, so a case-sensitive CI runner
  // (most Linux filesystems) still gets a meaningful assertion either way.
  const real = path.join(scratchRoot, "casetest.json");
  await writeFile(real, "{}");
  const { canonicalPath } = await import("./isolation-guard.mjs");
  const viaReal = await canonicalPath(real);
  const viaUpper = await canonicalPath(path.join(scratchRoot, "CASETEST.JSON"));
  const caseInsensitiveFs = viaReal === viaUpper;
  console.log(
    `  info  filesystem is case-${caseInsensitiveFs ? "INSENSITIVE" : "sensitive"} here` +
      ` (${viaReal} ${caseInsensitiveFs ? "==" : "!="} ${viaUpper})`,
  );
  if (caseInsensitiveFs) {
    check(true, "case-different alias of an existing scratch file resolves to the same canonical path");
  } else {
    console.log("  SKIP  (this filesystem is case-sensitive; the alias is genuinely a different file here)");
  }
}

await refusalCase(
  "a case-different alias of the published snapshot's filename is refused",
  { SNAPSHOT_OUT: path.join(path.dirname(PUBLISHED), "SNAPSHOT.JSON") },
  /does not resolve inside LITMUS_SCRATCH_ROOT/,
);

// ------------------------------------------ scratch root swallows published

{
  // A root that is an ANCESTOR of the published snapshot's directory would
  // make every "contained" check trivially true — the allow-list degenerating
  // back into "everything passes". This is checked before build-snapshot.mjs
  // even looks at SNAPSHOT_OUT, so it fires regardless of what SNAPSHOT_OUT is
  // set to. build-snapshot.mjs, not refresh.sh's full funnel, is invoked here
  // specifically because refresh.sh runs db:init before the snapshot step and
  // would hit the DSN guard first — see isolation-guards-test.mjs's header.
  const clientDir = path.resolve(path.dirname(PUBLISHED), "..", "..", "..");
  await refusalCase(
    "a scratch root that would contain the published snapshot's directory is refused",
    {
      LITMUS_SCRATCH_ROOT: clientDir,
      SNAPSHOT_OUT: path.join(clientDir, "scratch", "snapshot.json"),
    },
    /contains the published snapshot's directory/,
  );
}

// ----------------------------------------------------------- symlink alias

{
  const symlinkPath = path.join(scratchRoot, "symlink-to-published.json");
  await symlink(PUBLISHED, symlinkPath).catch(() => {});
  // The symlink's LITERAL path is inside the declared scratch root. Only
  // canonical resolution — following it to what it actually points at —
  // catches that it is not really inside the root at all.
  await refusalCase(
    "a symlink living inside the scratch root but pointing at the published snapshot is refused",
    { SNAPSHOT_OUT: symlinkPath },
    /does not resolve inside LITMUS_SCRATCH_ROOT|hard-linked to the published/,
  );
  await rm(symlinkPath, { force: true });
}

// --------------------------------------------------------- hard-link alias

{
  const hardlinkPath = path.join(scratchRoot, "hardlink-to-published.json");
  let hardlinkCreated = false;
  try {
    await link(PUBLISHED, hardlinkPath);
    hardlinkCreated = true;
  } catch (err) {
    console.log(`  SKIP  hard-link alias case — could not create a hard link here (${err.code ?? err.message})`);
  }
  if (hardlinkCreated) {
    await refusalCase(
      "a hard link living inside the scratch root, sharing the published snapshot's inode, is refused",
      { SNAPSHOT_OUT: hardlinkPath },
      /hard-linked to the published/,
    );
    await rm(hardlinkPath, { force: true });
  }
}

// ------------------------------------------------------- positive control

{
  // A genuinely valid destination must pass the guards and be judged on its
  // own merits afterward (an empty fixture API cannot produce a publishable
  // edition, which is a DIFFERENT, later failure — not a guard refusal).
  hits = 0;
  const scratchOut = path.join(scratchRoot, "legitimate-output.json");
  const { code, out } = await run({
    LITMUS_ISOLATED: "1",
    API_URL: localApi,
    LITMUS_SCRATCH_ROOT: scratchRoot,
    SNAPSHOT_OUT: scratchOut,
  });
  const passedGuards = !/snapshot REFUSED/.test(out);
  check(passedGuards, "a legitimate scratch destination passes the guards", passedGuards ? "" : out);
  check(hits > 0, "and the run proceeds to read the API", `hits=${hits}`);
  check(code !== 0, "but is still judged on its own merits (an empty fixture API is not publishable)");
}

// ----------------------------------------------------- non-isolated control

{
  const probe = path.join(workDir, "normal.json");
  const { out } = await run({ API_URL: localApi, SNAPSHOT_OUT: probe });
  check(!/snapshot REFUSED/.test(out), "a non-isolated run is not affected by any of these guards");
}

await new Promise((r) => api.close(r));
await rm(workDir, { recursive: true, force: true });

console.log(
  failures.length === 0
    ? "\nWRITER GUARDS HOLD: every alias of the published snapshot is refused; every legitimate destination is not.\n"
    : `\nWRITER GUARDS LEAK — ${failures.length} failure(s): ${failures.join("; ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
