// Verification for the per-source register pin.
//
// Register is load-bearing in two places at once: it selects the marker
// exemption in both marking passes, and inside computeComposite a non-news
// register halves the language weight and switches off the loaded-headline and
// emotional-lede floors. It was observed flipping between "news" and "feature"
// for the same NPR politics article across two runs, which moves the highlights
// AND the score on a coin flip.
//
// This asserts three things:
//   1. A pinned source overrides whatever the model guessed.
//   2. An UNPINNED source is left completely alone (a mixed outlet must keep
//      its per-article judgement).
//   3. The pin actually changes the composite, i.e. it is load-bearing rather
//      than decorative.
//
// Run:  npx tsx scripts/check-register-pin.ts

import {
  applyRegisterPin,
  computeComposite,
  type CompositeFlags,
} from "../litmus-server/src/scoring/composite.js";

const base: CompositeFlags = {
  emotionalLede: false,
  loadedHeadline: false,
  fallacyCount: 0,
  oneSidedSourcing: false,
  opinionColumn: false,
  register: "news",
};

let failures = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => { failures++; console.log(`  FAIL  ${m}`); };

console.log("\npin overrides the model's guess:");
for (const [guess, pin, want] of [
  ["news", "sports", "sports"],
  ["feature", "sports", "sports"],   // the observed flip, corrected
  ["news", "culture", "culture"],
  ["sports", "sports", "sports"],    // already agreed; must be a no-op
] as const) {
  const got = applyRegisterPin({ ...base, register: guess }, pin).register;
  got === want ? ok(`guess=${guess} pin=${pin} -> ${got}`) : bad(`guess=${guess} pin=${pin}: expected ${want}, got ${got}`);
}

console.log("\nunpinned source keeps the model's judgement (a mixed outlet must not be forced):");
for (const guess of ["news", "feature", "sports", "culture"] as const) {
  const got = applyRegisterPin({ ...base, register: guess }, null).register;
  got === guess ? ok(`guess=${guess} pin=null -> ${got}`) : bad(`guess=${guess} pin=null: expected ${guess}, got ${got}`);
}

console.log("\na bogus pin is ignored rather than trusted:");
// @ts-expect-error deliberately invalid, to prove bad data cannot corrupt the register
const bogus = applyRegisterPin({ ...base, register: "news" }, "opinion");
bogus.register === "news" ? ok('pin="opinion" ignored -> news') : bad(`bogus pin leaked: ${bogus.register}`);

console.log("\nthe pin is load-bearing, not decorative (same dimensions, different register):");
const dims = { headline: 3.5, language: 4.0, sourcing: 2.0, fallacies: 1.0, structure: 3.5 };
const asNews = computeComposite(dims, { ...base, register: "news", loadedHeadline: true });
const asSports = computeComposite(dims, { ...base, register: "sports", loadedHeadline: true });
console.log(`    news   -> ${asNews.composite}  (floors: ${asNews.raised.join(", ") || "none"})`);
console.log(`    sports -> ${asSports.composite}  (floors: ${asSports.raised.join(", ") || "none"})`);
asNews.composite !== asSports.composite
  ? ok(`register moves the composite by ${(asNews.composite - asSports.composite).toFixed(2)}`)
  : bad("register did not change the composite — the pin would be pointless");

console.log("");
if (failures > 0) {
  console.error(`FAIL — ${failures} case(s) failed.`);
  process.exit(1);
}
console.log("PASS — pin binds where set, leaves unpinned sources alone, and moves the score.");
process.exit(0);
