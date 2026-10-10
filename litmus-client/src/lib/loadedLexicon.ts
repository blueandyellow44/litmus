// A deterministic word-level backstop for the LLM markers. Single charged words
// slip past a phrase-oriented model scan, so we catch a curated set here: RED
// hyperbolic/loaded words and GREEN neutral/attribution words. This runs on
// existing data (no re-score) and complements the LLM markers rather than
// replacing them. Kept CONSERVATIVE: only words that read loaded (or neutral)
// in essentially every news context, to avoid false positives.

// RED loaded words -> intensity (1-5).
export const LOADED_WORDS: Record<string, number> = {
  // extreme (4-5)
  catastrophic: 5, catastrophe: 5, apocalyptic: 5, devastating: 5, devastate: 5, devastated: 5,
  horrific: 5, horrifying: 5, nightmare: 4, disaster: 4, disastrous: 4, calamity: 5,
  destroy: 4, destroyed: 4, destroying: 4, annihilate: 5, obliterate: 5, decimate: 4,
  outrage: 4, outrageous: 4, outraged: 4, shocking: 4, shocked: 4, shockingly: 4,
  chaos: 4, chaotic: 4, meltdown: 4, bombshell: 4, explosive: 4, firestorm: 4, bloodbath: 5,
  // strong (3-4)
  awful: 3, terrible: 3, horrible: 4, appalling: 4, disgraceful: 4, disgusting: 4, vile: 4,
  reckless: 3, radical: 3, extremist: 4, dangerous: 3, alarming: 3, terrifying: 5, dire: 3,
  slammed: 4, slams: 4, blasted: 4, blasts: 4, torched: 4, torches: 4, ripped: 3, savaged: 4,
  crushed: 3, blistering: 4, scathing: 4, furious: 3, fury: 3, raged: 4, rages: 4, erupted: 3,
  betrayal: 4, betrayed: 4, treason: 5, traitor: 5, corrupt: 3, sinister: 4, tyranny: 5, tyrant: 5,
  // moderate (2-3)
  stunned: 3, stunning: 3, brutal: 4, brutally: 4, shameful: 4, shameless: 4, sham: 4,
  fiasco: 4, debacle: 4, scandal: 3, scandalous: 4, unprecedented: 2, crisis: 2, embattled: 3,
  besieged: 3, spiraling: 3, plunge: 2, plummet: 3, plummeted: 3, skyrocket: 3, skyrocketed: 3,
  desperate: 3, frantic: 3, grim: 2, bleak: 2, ominous: 3, damning: 4, explosively: 4,
  smear: 3, smeared: 3, lie: 3, lies: 3, hoax: 4, witch: 4, weaponize: 4, weaponized: 4,
};

// GREEN neutral / attribution words -> intensity (how cleanly factual). These
// are the tells of restrained reporting: neutral attribution and hedging.
export const NEUTRAL_WORDS: Record<string, number> = {
  said: 3, told: 2, stated: 3, added: 2, noted: 2, wrote: 2,
  announced: 3, confirmed: 4, reported: 3, reportedly: 3, testified: 3,
  according: 4, estimated: 4, projected: 3, measured: 3, recorded: 3,
  percent: 3, data: 3, figures: 2, survey: 2, filing: 2, filed: 2,
  approved: 2, passed: 2, voted: 2, ruled: 2, signed: 2, released: 2,
};

export type HitColor = "red" | "green";

function buildRe(words: string[]): RegExp {
  return new RegExp(`\\b(${words.sort((a, b) => b.length - a.length).join("|")})\\b`, "gi");
}
const LOADED_RE = buildRe(Object.keys(LOADED_WORDS));
const NEUTRAL_RE = buildRe(Object.keys(NEUTRAL_WORDS));

// Spans of quoted speech (curly or straight). The hard silo: a span inside a
// named speaker's quote is not the outlet's voice, so it is never marked.
//
// MUST STAY BYTE-IDENTICAL with the other three copies:
//   litmus-server/src/scoring/phScorer.ts
//   litmus-server/src/scoring/markExcerpt.ts
//   litmus-server/src/scoring/calibrate-run.ts
//   litmus-client/src/lib/loadedLexicon.ts
// Each one runs over a DIFFERENT string — the full rawText, the joined excerpt
// passage, and per-paragraph on the client — so any divergence silos different
// text in each scope, and the client drops a highlight the server allowed.
//
// The body excludes \n deliberately. Without it, one unpaired straight quote
// flips open/close pairing for the entire remainder of the string, and because
// the scopes differ that mispairing lands in a different place in each — which
// is how a stretch of plain narration got siloed server-side while the client
// disagreed. Forbidding a span from crossing a line break makes pairing restart
// per line, so all three scopes agree.
export function quotedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const RE = /[“"][^”"\n]*[”"]/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

export interface LexHit {
  start: number;
  end: number;
  intensity: number;
  color: HitColor;
}

// Loaded (red) and neutral (green) single-word hits, excluding any inside a
// quotation. The caller merges these with the LLM ranges, dropping any that
// overlap a richer marker so phrases still win.
export function loadedWordHits(text: string): LexHit[] {
  const quotes = quotedSpans(text);
  const inQuote = (i: number) => quotes.some(([a, b]) => i >= a && i < b);
  const hits: LexHit[] = [];
  const scan = (re: RegExp, table: Record<string, number>, color: HitColor) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (inQuote(m.index)) continue;
      hits.push({ start: m.index, end: m.index + m[0].length, intensity: table[m[0].toLowerCase()] ?? 3, color });
    }
  };
  scan(LOADED_RE, LOADED_WORDS, "red");
  scan(NEUTRAL_RE, NEUTRAL_WORDS, "green");
  return hits;
}
