// The Internet Archive fallback was removed from LITMUS on 2026-09-13, not
// switched off (the excerpt policy). This turns that into a checked invariant
// instead of an assumption, which is exactly how the old flag drifted: CI
// pinned it false while a laptop .env had it true, and both deployed to the
// same public site.
//
// Scans every tracked (and untracked, non-ignored) file for an archive host
// reference and exits 1 on any hit. Dependency-free, Node 18+.
//
//   node scripts/check-no-archive.mjs                  # scan the repo
//   node scripts/check-no-archive.mjs --prove-it-fails # first prove the scanner
//                                                      # catches planted references
//
// Not scanned: docs/ and tasks/, because the legal record and the plan history
// must be able to name what was removed.
//
// Allowed lines: a line that exists to DETECT archive hosts may carry the marker
// "archive-guard:" with a reason, and the marker is honoured ONLY in the files
// listed in DETECTOR_FILES. Anywhere else a marked line is still a violation, so
// the marker cannot be used to smuggle a fetch back in.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ARCHIVE_PATTERN = /web\.archive\.org|\barchive\.(?:org|ph|today|is|li|vn|fo|md)\b|wayback/i; // archive-guard: the scanner's own pattern
const MARKER = "archive-guard:";
const EXCLUDED_PREFIXES = ["docs/", "tasks/"];
const DETECTOR_FILES = new Set(["scripts/check-no-archive.mjs", "scripts/edition-manifest.mjs", "scripts/verify-edition.mjs"]);

export function scanFile(relPath, text) {
  const honourMarker = DETECTOR_FILES.has(relPath);
  const hits = [];
  text.split("\n").forEach((line, i) => {
    if (!ARCHIVE_PATTERN.test(line)) return;
    if (honourMarker && line.includes(MARKER)) return;
    hits.push({ file: relPath, line: i + 1, text: line.trim().slice(0, 160) });
  });
  return hits;
}

function listFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split("\0").filter(Boolean))].filter((f) => !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)));
}

function scanRepo() {
  const hits = [];
  let scanned = 0;
  for (const rel of listFiles()) {
    let buf;
    try {
      buf = readFileSync(join(ROOT, rel));
    } catch (err) {
      if (err.code === "ENOENT") continue; // deleted in the working tree, not yet committed
      throw err;
    }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    scanned++;
    hits.push(...scanFile(rel, buf.toString("utf8")));
  }
  return { hits, scanned };
}

function proveItFails() {
  const cases = [
    ["litmus-server/src/x.ts", 'await fetch("https://web.archive.org/web/2/https://wsj.com/a")', 1], // archive-guard: planted case
    ["litmus-server/src/x.ts", "const api = `https://archive.org/wayback/available?url=${u}`;", 1], // archive-guard: planted case
    ["litmus-server/src/x.ts", "// try archive.ph/newest when Wayback misses", 1], // archive-guard: planted case
    ["scripts/refresh.sh", "npm run reextract # WAYBACK recovery", 1], // archive-guard: planted case
    ["litmus-server/src/x.ts", 'fetch("https://archive.today/x") // archive-guard: sneaky', 1],
    ["scripts/edition-manifest.mjs", '"archive.org", // archive-guard: detector list', 0],
    ["litmus-client/src/x.ts", 'const u = "https://www.theatlantic.com/archive/2026/09/x/";', 0],
    ["litmus-client/src/x.ts", "if (archive.isArray) {}", 0],
    ["litmus-server/src/x.ts", "// Internet Archive fallback removed 2026-09-13", 0],
  ];
  let bad = 0;
  for (const [file, text, expected] of cases) {
    const got = scanFile(file, text).length;
    const ok = got === expected;
    if (!ok) bad++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${expected ? "catches" : "allows "} ${file}: ${text.slice(0, 70)}`);
  }
  if (bad > 0) {
    console.error(`\nthe scanner itself is wrong (${bad} case${bad === 1 ? "" : "s"}); refusing to trust a clean scan`);
    process.exit(1);
  }
}

if (process.argv.includes("--prove-it-fails")) {
  console.log("proving the scanner catches planted archive references");
  proveItFails();
}

const { hits, scanned } = scanRepo();
if (hits.length > 0) {
  console.error(`\nInternet Archive reference found in ${hits.length} place${hits.length === 1 ? "" : "s"}:`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}`);
  console.error("\nThe archive fallback was removed on 2026-09-13; see the excerpt policy.");
  process.exit(1);
}
console.log(`no Internet Archive references in ${scanned} scanned files`);
