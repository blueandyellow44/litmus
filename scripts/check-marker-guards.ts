// Verification for the two marker guards in litmus-server/src/scoring/markerGuards.ts.
//
// Both were written against defects observed in the live corpus, so the cases
// below are the real strings, not invented ones:
//   - "Unlimited Cashback Match" (card advertising inside a CNN piece) was
//     published as a loaded_terms marker.
//   - Axios's standing "Why it matters:" label was published as
//     structural_manipulation.
//   - The quote silo resolved a span with indexOf(), i.e. its FIRST occurrence,
//     so a phrase used both inside a quotation and in the reporter's own
//     narration was adjudicated on whichever came first in the article.
//
// Run:  npx tsx scripts/check-marker-guards.ts
//       npx tsx scripts/check-marker-guards.ts --prove-it-fails
//
// The second mode re-runs the same cases against the OLD first-occurrence
// behaviour and requires them to fail. A guard nobody has watched fail is an
// untested claim; if that mode ever reports success, this check has stopped
// measuring anything and must be repaired rather than deleted.

import {
  occursOutsideQuotes,
  isPageFurniture,
} from "../litmus-server/src/scoring/markerGuards.js";

const PROVE = process.argv.includes("--prove-it-fails");

// The pre-fix implementation, kept verbatim so the mutation is faithful.
function occursOutsideQuotes_OLD(
  haystack: string,
  text: string,
  startsInQuote: (i: number) => boolean,
): boolean {
  const at = haystack.indexOf(text);
  return at !== -1 && !startsInQuote(at);
}

// Same regex the passes use to find quoted speech.
function quotedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const RE = /[“"][^”"\n]*[”"]/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

const impl = PROVE ? occursOutsideQuotes_OLD : occursOutsideQuotes;

interface Case {
  name: string;
  body: string;
  span: string;
  markable: boolean; // true = the outlet used it in its own voice somewhere
}

const QUOTE_CASES: Case[] = [
  {
    name: "quoted FIRST, then used in the reporter's own narration",
    body:
      'The senator said the plan was a "reckless gamble" with the economy.\n' +
      "Analysts noted the reckless gamble had already been priced in by markets.",
    span: "reckless gamble",
    markable: true, // the outlet says it too, so it is the outlet's framing
  },
  {
    name: "narration FIRST, then quoted",
    body:
      "The bill faces a reckless gamble of a vote next week.\n" +
      'One aide called it a "reckless gamble" that nobody wanted.',
    span: "reckless gamble",
    markable: true,
  },
  {
    name: "ONLY ever inside a quotation (the silo must hold)",
    body:
      'The governor called the policy a "total disaster" on Tuesday.\n' +
      'She repeated that it was a "total disaster" the following day.',
    span: "total disaster",
    markable: false,
  },
  {
    name: "never appears verbatim",
    body: "The committee met on Thursday and adjourned without a vote.",
    span: "screaming match",
    markable: false,
  },
];

const FURNITURE_MUST_CATCH = [
  "Why it matters:",
  "Why it matters",
  "Unlimited Cashback Match",
  "The big picture:",
  "Go deeper:",
  "Advertisement",
  "Getty Images",
  // Observed live on 2026-08-10 AFTER the first version of this guard shipped:
  // the model marked the label together with the sentence it introduces, and an
  // exact-match list passed it straight through to the page.
  "Why it matters: Controversial vaccine policy changes appear to be roaring back ahead of the midterms.",
  "By the numbers: 44 people have been hospitalized.",
];

// Real prose from the corpus that the furniture list must NOT swallow. These
// are fixed by the rubric (describing vs editorializing), not by this list, and
// deleting them here would silently destroy real marks.
const FURNITURE_MUST_NOT_CATCH = [
  "capstone project",
  "The late Sen. Lindsey Graham",
  "rejected the notion",
  "clashed",
  "suffocated Leeds with their press",
  "Why it matters to the families involved is still unclear",
];

let failures = 0;
const fail = (m: string) => { failures++; console.log(`  FAIL  ${m}`); };
const pass = (m: string) => console.log(`  ok    ${m}`);

console.log(`\nmode: ${PROVE ? "--prove-it-fails (old behaviour, expects failures)" : "guard"}\n`);
console.log("quote-instance resolution:");
for (const c of QUOTE_CASES) {
  const quotes = quotedSpans(c.body);
  const startsInQuote = (i: number) => quotes.some(([a, b]) => i >= a && i < b);
  const got = impl(c.body, c.span, startsInQuote);
  if (got === c.markable) pass(`${c.name} -> ${got}`);
  else fail(`${c.name}: expected ${c.markable}, got ${got}`);
}

console.log("\npage furniture (must catch):");
for (const s of FURNITURE_MUST_CATCH) {
  isPageFurniture(s) ? pass(JSON.stringify(s)) : fail(`${JSON.stringify(s)} was not caught`);
}

console.log("\nreal prose (must NOT be caught):");
for (const s of FURNITURE_MUST_NOT_CATCH) {
  !isPageFurniture(s) ? pass(JSON.stringify(s)) : fail(`${JSON.stringify(s)} was wrongly discarded`);
}

console.log("");
if (PROVE) {
  if (failures > 0) {
    console.log(`PASS — the old first-occurrence behaviour fails ${failures} case(s), so this check can fail.`);
    process.exit(0);
  }
  console.error("FAIL — the old behaviour passed every case. This check is not measuring anything.");
  console.error("Repair it; do not delete it.");
  process.exit(1);
}
if (failures > 0) {
  console.error(`FAIL — ${failures} guard case(s) failed.`);
  process.exit(1);
}
console.log("PASS — all guard cases hold.");
process.exit(0);
