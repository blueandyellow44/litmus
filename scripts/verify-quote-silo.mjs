// Verifies the quote-silo regex fix. Free: no database, no API calls. Run with:
//   node scripts/verify-quote-silo.mjs
//
// Background. quotedSpans() exists in four byte-identical copies (phScorer,
// markExcerpt, calibrate-run, loadedLexicon) but each caller runs it over a
// DIFFERENT string: the full rawText, the joined excerpt passage, and
// per-paragraph on the client. With the old body [^”"]* a span could cross
// newlines, so a single unpaired straight quote flipped open/close pairing for
// the whole remainder of the string — and because the scopes differ, the
// mispairing landed somewhere different in each. That is how plain narration
// was siloed server-side while the client disagreed.
//
// Section C is the important one and is deliberately NOT derived from the run
// data. Sections A and B can only show the count going DOWN, and "down" is
// ambiguous: it conflates "removed false flags" with "stopped siloing genuine
// quotes". The run corpus contains zero markers that legitimately sit inside a
// quotation, so it cannot demonstrate the silo still works at all. C asserts
// that directly on constructed text, including the multi-paragraph quotation
// convention (each paragraph opens with a quote mark, only the last closes it)
// which is exactly what a newline-sensitive regex is most likely to break.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const OLD_RE = () => /[“"][^”"]*[”"]/g;
const NEW_RE = () => /[“"][^”"\n]*[”"]/g;

function spans(makeRe, text) {
  const re = makeRe();
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  return out;
}
const inside = (sp, i) => sp.some(([a, b]) => i >= a && i < b);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── A + B: replay the fix over the recorded calibration run ────────────────
const runsDir = join(ROOT, "calibration-runs");
const runFile = readdirSync(runsDir).filter((f) => f.endsWith("-political.json")).sort().pop();
if (!runFile) {
  console.log("SKIP  no *-political.json in calibration-runs/; sections A and B not run");
} else {
  const run = JSON.parse(readFileSync(join(runsDir, runFile), "utf-8"));
  let oldInQuote = 0, newInQuote = 0, located = 0;
  let oldClientDrop = 0, newClientDrop = 0;
  const lostBy = new Map();

  for (const a of run.articles ?? []) {
    const raw = a.rawText ?? "";
    const so = spans(OLD_RE, raw), sn = spans(NEW_RE, raw);
    for (const arm of a.arms ?? []) {
      for (const mk of arm.score?.markers ?? []) {
        const t = mk.text;
        if (!t) continue;
        const i = raw.indexOf(t);
        if (i < 0) continue;
        located++;
        const o = inside(so, i), n = inside(sn, i);
        if (o) oldInQuote++;
        if (n) newInQuote++;
        if (o && !n) lostBy.set(a.articleId, (lostBy.get(a.articleId) ?? 0) + 1);
      }
      // Client scope: per-paragraph. A marker is dropped when its offset inside
      // its own paragraph falls in a quote span computed for that paragraph.
      for (const para of arm.excerptParagraphs ?? []) {
        const po = spans(OLD_RE, para), pn = spans(NEW_RE, para);
        for (const mk of arm.score?.markers ?? []) {
          const t = mk.text;
          if (!t) continue;
          const i = para.indexOf(t);
          if (i < 0) continue;
          if (inside(po, i)) oldClientDrop++;
          if (inside(pn, i)) newClientDrop++;
        }
      }
    }
  }

  console.log(`\n[A] run=${runFile}  markers located in rawText: ${located}`);
  console.log(`    server markersInQuote   old=${oldInQuote}  new=${newInQuote}`);
  console.log(`    client per-para dropped old=${oldClientDrop}  new=${newClientDrop}`);
  for (const [id, n] of lostBy) console.log(`    article ${id}: ${n} marker(s) no longer siloed`);
  check("[A] server in-quote count does not grow", newInQuote <= oldInQuote, `${oldInQuote} -> ${newInQuote}`);
  check("[B] client dropped count does not grow", newClientDrop <= oldClientDrop, `${oldClientDrop} -> ${newClientDrop}`);
}

// ── C: the silo must still WORK (not derived from run data) ────────────────
console.log("");
const single = `The mayor said the plan was ready.\n"This is a catastrophe," Smith said.\nOfficials disagreed.`;
const sSpans = spans(NEW_RE, single);
check(
  "[C1] single-line quotation is still siloed",
  inside(sSpans, single.indexOf("catastrophe")),
  "word inside quotation marks",
);
check(
  "[C2] narration outside the quote is NOT siloed",
  !inside(sSpans, single.indexOf("Officials disagreed")),
  "plain narration stays markable",
);

// The multi-paragraph convention: opener on each paragraph, closer only on the
// last. This is the case a newline-sensitive regex is most at risk of missing.
const multi = `"We reviewed every file this week.\n\n"We found nothing improper," the auditor said.\n\nThe report lands Friday.`;
const mSpans = spans(NEW_RE, multi);
check(
  "[C3] closing paragraph of a multi-paragraph quote is siloed",
  inside(mSpans, multi.indexOf("nothing improper")),
  "paragraph carrying both an opener and a closer",
);
const contIdx = multi.indexOf("every file");
const contSiloed = inside(mSpans, contIdx);
console.log(
  `NOTE  [C4] continuation paragraph of a multi-paragraph quote siloed=${contSiloed}. ` +
    `A paragraph that opens a quote without closing it has no complete span, so it is NOT siloed. ` +
    `Known and accepted limit of a regex-based silo: the model is separately instructed never to ` +
    `mark quoted speech, and this is the backstop, not the only defence. Tightened here from the ` +
    `old behaviour, where the unpaired opener instead swallowed an arbitrary run of following text.`,
);

// Cross-scope agreement is the actual point of the fix.
const para = `"We found nothing improper," the auditor said.`;
const full = `Intro line.\n${para}\nClosing line.`;
const offsetInFull = full.indexOf("nothing improper");
const offsetInPara = para.indexOf("nothing improper");
check(
  "[C5] server (full text) and client (per-paragraph) scopes agree",
  inside(spans(NEW_RE, full), offsetInFull) === inside(spans(NEW_RE, para), offsetInPara),
  "same marker, same verdict in both scopes",
);

// The regression that motivated the fix: one unpaired quote must not flip
// pairing for everything after it.
const stray = `He called it a "win" for the city.\nA lone " appears here.\nLater narration continues.`;
check(
  "[C6] a stray unpaired quote does not silo later narration",
  !inside(spans(NEW_RE, stray), stray.indexOf("Later narration")),
  "pairing restarts per line",
);

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
