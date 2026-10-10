// The server's band table and the client's must describe the same instrument.
//
// There is no shared package by design (docs/architecture.md decision #1), so
// litmus-server/src/scoring/calibration.ts and litmus-client/src/lib/phBand.ts
// hold two copies of the same five boundaries. A copy is only safe if something
// notices when one of them moves. Nothing did.
//
// This also holds tailwind.config.js's ph-* palette to the client table, since
// the badge reads its colour through a Tailwind class while The Map reads the
// same colour as a hex, and the two are separate literals.
//
// Run:  npx tsx scripts/check-band-parity.ts
//       npx tsx scripts/check-band-parity.ts --prove-it-fails
//
// The second mode mutates each table in memory and requires the check to catch
// it. A parity check nobody has watched fail is an untested claim.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BANDS as SERVER_BANDS, checkBandTable } from "../litmus-server/src/scoring/calibration.js";
import { PH_BANDS as CLIENT_BANDS } from "../litmus-client/src/lib/phBand.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROVE = process.argv.includes("--prove-it-fails");

interface Row {
  min: number;
  max: number;
  below: number;
  label: string;
}

let failures = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const check = (label: string, condition: boolean) => (condition ? ok(label) : bad(label));

// ── The two TypeScript tables ──────────────────────────────────────────────

function compare(server: readonly Row[], client: readonly Row[]): string[] {
  const problems: string[] = [];
  if (server.length !== client.length) {
    problems.push(`band count: server ${server.length}, client ${client.length}`);
    return problems;
  }
  for (let i = 0; i < server.length; i++) {
    const s = server[i]!;
    const c = client[i]!;
    if (s.label !== c.label) problems.push(`band ${i}: label server "${s.label}" vs client "${c.label}"`);
    if (s.min !== c.min) problems.push(`${s.label}: min server ${s.min} vs client ${c.min}`);
    if (s.max !== c.max) problems.push(`${s.label}: max server ${s.max} vs client ${c.max}`);
    if (s.below !== c.below) problems.push(`${s.label}: cut server ${s.below} vs client ${c.below}`);
  }
  return problems;
}

console.log("\nserver and client band tables:");
const drift = compare(SERVER_BANDS, CLIENT_BANDS);
check(
  drift.length === 0 ? "identical boundaries and labels" : `boundaries drifted — ${drift.join("; ")}`,
  drift.length === 0,
);

console.log("\nthe server table is internally consistent:");
const serverProblems = checkBandTable();
check(
  serverProblems.length === 0 ? "published boundaries meet the cuts" : serverProblems.join("; "),
  serverProblems.length === 0,
);

// ── The Tailwind palette against the client table ──────────────────────────

const TAILWIND_KEY: Record<string, string> = {
  Proportionate: "practical", // the CSS token keeps its original name
  Grounded: "grounded",
  "Mixed Signals": "mixed",
  "Running Hot": "hot",
  Hyperbolic: "hysterical",
};

function tailwindPalette(source: string): Map<string, string> {
  // The ph block, then `key: "#hex"` inside it. Deliberately a narrow read of a
  // known-shape file rather than an import — the config is ESM with a Tailwind
  // type import and evaluating it here would pull in the build toolchain.
  const block = /ph:\s*\{([\s\S]*?)\n\s*\}/.exec(source);
  const out = new Map<string, string>();
  if (!block) return out;
  for (const m of block[1]!.matchAll(/(\w+)\s*:\s*"(#[0-9a-fA-F]{6})"/g)) {
    out.set(m[1]!, m[2]!.toLowerCase());
  }
  return out;
}

console.log("\ntailwind ph-* palette against the client table:");
const palette = tailwindPalette(readFileSync(join(ROOT, "litmus-client", "tailwind.config.js"), "utf8"));
check(`found all ${CLIENT_BANDS.length} ph-* colours in tailwind.config.js`, palette.size === CLIENT_BANDS.length);
for (const b of CLIENT_BANDS) {
  const key = TAILWIND_KEY[b.label]!;
  const configured = palette.get(key);
  check(
    `ph-${key} is ${b.hex} in both (config has ${configured ?? "nothing"})`,
    configured === b.hex.toLowerCase(),
  );
}

// ── Watched to fail ────────────────────────────────────────────────────────

if (PROVE) {
  console.log("\n--prove-it-fails: each mutation must be caught");
  let caught = 0;
  const attempts = 3;

  const movedCut = CLIENT_BANDS.map((b, i) => (i === 1 ? { ...b, below: 2.6 } : b));
  if (compare(SERVER_BANDS, movedCut).length > 0) {
    ok("a moved client cut is caught");
    caught++;
  } else bad("a moved client cut was NOT caught");

  const renamed = CLIENT_BANDS.map((b, i) => (i === 3 ? { ...b, label: "Warm" } : b));
  if (compare(SERVER_BANDS, renamed).length > 0) {
    ok("a renamed client band is caught");
    caught++;
  } else bad("a renamed client band was NOT caught");

  const wrongHex = tailwindPalette('ph: {\n  practical: "#000000",\n}\n}');
  if (wrongHex.get("practical") !== CLIENT_BANDS[0]!.hex.toLowerCase()) {
    ok("a changed tailwind hex is caught");
    caught++;
  } else bad("a changed tailwind hex was NOT caught");

  if (caught !== attempts) {
    console.log("\nthis check has stopped measuring anything. Repair it rather than deleting it.");
    process.exit(1);
  }
}

console.log(
  failures === 0
    ? "\nPASS — the server table, the client table, and the Tailwind palette agree.\n"
    : `\nFAIL — ${failures} parity problem(s).\n`,
);
process.exit(failures === 0 ? 0 : 1);
