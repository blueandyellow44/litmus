// Isolation guards for the snapshot writer.
//
// build-snapshot.mjs is a plain node script that imports none of the server's
// TypeScript, and it is the process that actually writes the published
// edition. Guards that live only in the server protect every path except the
// one that does the writing, so this is the real boundary.
//
// Everything here runs BEFORE the first fetch and before any write, so a
// refused run has neither read from a remote API nor touched the filesystem.

import { realpath, lstat, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const PUBLISHED_SNAPSHOT = path.join(
  REPO_ROOT,
  "litmus-client",
  "src",
  "demo",
  "snapshot.json",
);
export const PUBLISHED_SNAPSHOT_DIR = path.dirname(PUBLISHED_SNAPSHOT);

export class IsolationRefusal extends Error {}

// Resolve ANY path — existing or not — to its canonical, symlink-resolved
// form. This is what makes the boundary check below actually a boundary
// rather than a string comparison an attacker (or a typo) can route around:
//
//   - a dangling or live symlink at the final component is followed by hand,
//     because realpath() throws on a dangling link, which would let an alias
//     to a not-yet-created file slip past a naive resolver;
//   - a nonexistent destination is resolved by walking up to the nearest
//     EXISTING ancestor and realpath-ing that, then reattaching the missing
//     suffix — so a symlinked ancestor directory (macOS's /tmp is itself a
//     symlink to /private/tmp) still canonicalises correctly even when the
//     leaf file does not exist yet;
//   - literal `..` segments are collapsed by path.resolve on the RAW string
//     at the top of this function, at runtime — the caller must pass them
//     through unresolved for this to mean anything;
//   - a case-insensitive alias on a case-preserving filesystem (macOS APFS)
//     resolves to the same canonical string as the real name, because
//     realpath() returns the stored case for a path that exists, regardless
//     of the case it was queried with.
export async function canonicalPath(rawPath) {
  let abs = path.resolve(rawPath);

  for (let hop = 0; hop < 20; hop++) {
    let st;
    try {
      st = await lstat(abs);
    } catch {
      break; // does not exist at all; the ancestor walk below takes over
    }
    if (!st.isSymbolicLink()) break;
    const link = await readlink(abs);
    abs = path.isAbsolute(link) ? link : path.resolve(path.dirname(abs), link);
  }

  const suffix = [];
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return path.join(probe, ...suffix.reverse()); // hit "/"; nothing exists
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

function isInside(target, root) {
  return target === root || target.startsWith(root + path.sep);
}

export function assertLocalApi(apiUrl, { isolated }) {
  if (!isolated) return;
  let host;
  try {
    host = new URL(apiUrl).hostname;
  } catch {
    throw new IsolationRefusal(`LITMUS_ISOLATED=1 but API_URL is not a valid URL: ${apiUrl}`);
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new IsolationRefusal(
      `LITMUS_ISOLATED=1 but API_URL points off this machine (${apiUrl}). ` +
        "An isolated run may only read its own API; otherwise it would assemble an " +
        "edition from a deployment and report it as a local experiment.",
    );
  }
}

// A hard link sharing the published snapshot's inode IS that file by another
// name. Path containment cannot see this: realpath() resolves symlinks, not
// hard links, so a hard link literally living inside an approved scratch root
// still needs a separate check. Identity is device+inode, compared only when
// both sides exist — a target that does not exist yet cannot be hard-linked
// to anything.
async function assertNotHardLinkedToPublished(target) {
  let targetStat;
  let publishedStat;
  try {
    targetStat = await lstat(target);
  } catch {
    return;
  }
  try {
    publishedStat = await lstat(PUBLISHED_SNAPSHOT);
  } catch {
    return; // no published snapshot on disk (fresh checkout) — nothing to alias
  }
  if (targetStat.dev === publishedStat.dev && targetStat.ino === publishedStat.ino) {
    throw new IsolationRefusal(
      `LITMUS_ISOLATED=1 but SNAPSHOT_OUT (${target}) is hard-linked to the published ` +
        "snapshot — same device and inode, so it is that file under another name.",
    );
  }
}

// The boundary is now positive, not a deny-list of one file. A deny-list
// comparing SNAPSHOT_OUT against exactly the published snapshot's path missed
// every alias that resolves to somewhere else entirely dangerous: another
// worktree's snapshot.json, a symlink planted anywhere, a case-variant name.
// None of those equal the one forbidden path, so none were refused.
//
// The fix is containment, not exclusion: LITMUS_SCRATCH_ROOT names a directory
// declared for isolated output, and SNAPSHOT_OUT must resolve INSIDE it.
// Everything outside the declared root is refused, which is the only rule that
// generalises to aliases nobody enumerated in advance.
export async function assertScratchSnapshotOut(rawOut, { isolated, scratchRoot: rawScratchRoot }) {
  if (!isolated) return;

  const scratchRootValue = (rawScratchRoot ?? "").trim();
  if (scratchRootValue === "") {
    throw new IsolationRefusal(
      "LITMUS_ISOLATED=1 requires LITMUS_SCRATCH_ROOT: an explicit directory that SNAPSHOT_OUT " +
        "must resolve inside. A deny-list naming one forbidden file is not a boundary — every " +
        "path that is not that exact file passes it, including every alias of it.",
    );
  }
  const scratchRoot = await canonicalPath(scratchRootValue);

  // The root itself must not be able to contain the published snapshot's
  // directory. Pointing LITMUS_SCRATCH_ROOT at the repo, or at
  // litmus-client/src/demo directly, would make every "contained" path
  // trivially true and defeat the whole check.
  const publishedDir = await canonicalPath(PUBLISHED_SNAPSHOT_DIR);
  if (isInside(publishedDir, scratchRoot)) {
    throw new IsolationRefusal(
      `LITMUS_SCRATCH_ROOT (${scratchRootValue} -> ${scratchRoot}) contains the published ` +
        `snapshot's directory (${publishedDir}). Choose a root that cannot contain it.`,
    );
  }

  const value = (rawOut ?? "").trim();
  if (value === "") {
    throw new IsolationRefusal(
      "LITMUS_ISOLATED=1 requires an explicit SNAPSHOT_OUT inside LITMUS_SCRATCH_ROOT.",
    );
  }

  const target = await canonicalPath(value);
  if (!isInside(target, scratchRoot)) {
    throw new IsolationRefusal(
      "LITMUS_ISOLATED=1 but SNAPSHOT_OUT does not resolve inside LITMUS_SCRATCH_ROOT.\n" +
        `  given:        ${value}\n` +
        `  resolves to:  ${target}\n` +
        `  scratch root: ${scratchRoot}\n` +
        "Choose a destination under the declared scratch root.",
    );
  }

  await assertNotHardLinkedToPublished(target);
}

// One call for the writer: every guard, before it does anything observable.
export async function assertIsolatedWriter({ apiUrl, snapshotOut, env = process.env }) {
  const isolated = (env.LITMUS_ISOLATED ?? "").trim() === "1";
  assertLocalApi(apiUrl, { isolated });
  await assertScratchSnapshotOut(snapshotOut, {
    isolated,
    scratchRoot: env.LITMUS_SCRATCH_ROOT,
  });
}
