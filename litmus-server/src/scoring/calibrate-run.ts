// Calibration harness — rescores real articles with a candidate prompt and one
// or more candidate models, and reports MECHANICAL metrics beside the scores so
// a prompt change can be judged on evidence instead of vibes.
//
// It deliberately does NOT touch Postgres. The production funnel is parked (no
// local database), but every input this needs already lives in the shipped demo
// snapshot: full rawText for 221 articles plus the 39 scores the live prompt
// produced. Those stored scores are the BASELINE each run is measured against.
//
// Nothing here writes to the database, the snapshot, or the deployed site.
// Output is a new dated JSON file per run; runs never overwrite each other.
//
//   npm run calibrate -- --sample=12 --models=haiku --label=smoke
//   npm run calibrate -- --all-scored --models=haiku,sonnet --label=full
//   npm run calibrate -- --ids=101,102 --models=sonnet

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreBatch, type PHScore } from "./phScorer.js";
import { CALIBRATION_INSTRUCTIONS, bandFor, type PHMarker } from "./calibration.js";
import { buildExcerptWindow, splitParagraphs } from "../lib/paragraphs.js";
import type { Article } from "../types.js";
import { logger } from "../lib/logger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const SNAPSHOT = resolve(REPO_ROOT, "litmus-client/src/demo/snapshot.json");
const OUT_DIR = resolve(REPO_ROOT, "calibration-runs");

// Candidate scorer models. "haiku" is what production runs today; "sonnet" is
// the head-to-head arm — score compression is a known small-model-judge failure
// and the point of this run is to find out whether the prompt or the model is
// the ceiling.
// All three verified live against the API on 2026-08-02 before this run.
const MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001", // what production scores with today
  sonnet: "claude-sonnet-5",          // the head-to-head arm
  sonnet45: "claude-sonnet-4-5",      // what this repo already uses to translate and cluster
};

// Batch/concurrency mirror batchRunner.ts. Each batch is written to disk the
// moment it returns, so a crash costs only the in-flight batch, never the run.
const DEFAULT_BATCH_SIZE = 4;
const CONCURRENCY = 5;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 1500;

// ---------------------------------------------------------------- snapshot IO

interface SnapshotArticleDetail {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceLean: string;
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  wordCount: number;
  extractionStatus: string;
  paywallFlag: boolean;
  fetchedAt: string;
  rawText: string;
  score: StoredScore | null;
}

interface StoredScore {
  headline: number;
  language: number;
  sourcing: number;
  fallacies: number;
  structure: number;
  composite: number;
  label: string;
  rationale: Record<string, string>;
  markers: PHMarker[];
  excerptIndices: number[];
  politicalLean: number;
  articleSummary: string;
  section: string | null;
  modelUsed: string;
}

function loadSnapshot(): SnapshotArticleDetail[] {
  const raw = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
    articleDetail?: Record<string, SnapshotArticleDetail>;
  };
  if (!raw.articleDetail) throw new Error(`snapshot has no articleDetail: ${SNAPSHOT}`);
  return Object.values(raw.articleDetail);
}

// The scorer only reads these fields; the rest are filled to satisfy the type.
function toArticle(d: SnapshotArticleDetail): Article {
  return {
    id: d.id,
    sourceId: d.sourceId,
    url: d.url,
    title: d.title,
    author: d.author,
    publishedAt: d.publishedAt ? new Date(d.publishedAt) : null,
    rawText: d.rawText,
    wordCount: d.wordCount,
    extractionStatus: (d.extractionStatus as Article["extractionStatus"]) ?? "full",
    paywallFlag: d.paywallFlag,
    contentHash: "",
    extractedVia: null,
    syndicatedOfArticleId: null,
    fetchedAt: new Date(d.fetchedAt),
  };
}

// ------------------------------------------------------------------- metrics

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
function quotedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const RE = /[“"][^”"\n]*[”"]/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

const GREEN = new Set(["grounded", "hedging"]);

export interface ScoreMetrics {
  markerCount: number;
  redCount: number;
  greenCount: number;
  // Markers surviving into the ~250-500 word window the reader actually sees.
  markersInExcerpt: number;
  excerptWords: number;
  // Markers whose span starts inside a quotation: a hard-silo violation that the
  // client would drop anyway. Target is zero.
  markersInQuote: number;
  // Markers whose text is not a verbatim substring of the body. The scorer
  // already discards these, so this counts what the model wasted.
  markersUnmatched: number;
  // Model named one band, then emitted a composite from a different one.
  bandDisagreement: boolean;
}

function measure(article: Article, score: PHScore): ScoreMetrics {
  const text = article.rawText;
  const quotes = quotedSpans(text);
  const inQuote = (i: number) => quotes.some(([a, b]) => i >= a && i < b);

  let inQuoteCount = 0;
  let unmatched = 0;
  for (const m of score.markers) {
    const idx = text.indexOf(m.text);
    if (idx === -1) unmatched++;
    else if (inQuote(idx)) inQuoteCount++;
  }

  const window = buildExcerptWindow(text, score.excerptIndices, score.markers);
  const excerptWords = window
    ? window.paragraphs.join(" ").trim().split(/\s+/).filter(Boolean).length
    : 0;

  return {
    markerCount: score.markers.length,
    redCount: score.markers.filter((m) => !GREEN.has(m.category)).length,
    greenCount: score.markers.filter((m) => GREEN.has(m.category)).length,
    markersInExcerpt: window ? window.markers.length : 0,
    excerptWords,
    markersInQuote: inQuoteCount,
    markersUnmatched: unmatched,
    bandDisagreement: !!score.declaredBand && score.declaredBand !== bandFor(score.composite).label,
  };
}

// ----------------------------------------------------------------- run shapes

interface ArmResult {
  model: string;
  alias: string;
  score: PHScore;
  metrics: ScoreMetrics;
  excerptParagraphs: string[];
}

interface ArticleResult {
  articleId: number;
  title: string;
  sourceName: string;
  url: string;
  extractionStatus: string;
  wordCount: number;
  paragraphCount: number;
  rawText: string;
  baseline: (StoredScore & { metrics: ScoreMetrics; excerptParagraphs: string[] }) | null;
  arms: ArmResult[];
}

interface RunFile {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  // The exact prompt this run used, stored verbatim so every number in this file
  // is attributable to a prompt that can be diffed later. A run's scores mean
  // nothing without the prompt that produced them.
  promptText: string;
  promptChars: number;
  models: string[];
  usage: Record<string, { inputTokens: number; outputTokens: number; calls: number }>;
  articles: ArticleResult[];
  failures: Array<{ alias: string; articleIds: number[]; error: string }>;
}

// ------------------------------------------------------------------- scoring

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Score one arm (one model) over all articles, calling `onBatch` with each
// batch's scores the moment they land so the caller can persist incrementally.
async function runArm(
  alias: string,
  model: string,
  articles: Article[],
  batchSize: number,
  onUsage: (u: { inputTokens: number; outputTokens: number }) => void,
  onBatch: (scores: PHScore[]) => void,
): Promise<Array<{ articleIds: number[]; error: string }>> {
  const batches = chunk(articles, batchSize);
  const failures: Array<{ articleIds: number[]; error: string }> = [];
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= batches.length) return;
      const batch = batches[i]!;
      let lastErr: unknown = null;
      let ok = false;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const scores = await scoreBatch(batch, {
            model,
            instructions: CALIBRATION_INSTRUCTIONS,
            onUsage: (u) => onUsage({ inputTokens: u.inputTokens, outputTokens: u.outputTokens }),
          });
          onBatch(scores);
          logger.info("calibration batch scored", {
            alias,
            batch: `${++done}/${batches.length}`,
            returned: scores.length,
          });
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
          logger.warn("calibration batch failed", {
            alias,
            batchIndex: i,
            attempt,
            err: err instanceof Error ? err.message : String(err),
          });
          if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
        }
      }

      if (!ok) {
        failures.push({
          articleIds: batch.map((a) => a.id),
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));
  return failures;
}

// ---------------------------------------------------------------------- main

function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  return {
    ids: get("ids")?.split(",").map((s) => Number(s.trim())).filter(Number.isFinite) ?? [],
    sample: get("sample") ? Number(get("sample")) : 0,
    allScored: argv.includes("--all-scored"),
    political: argv.includes("--political"),
    models: (get("models") ?? "haiku").split(",").map((s) => s.trim()).filter(Boolean),
    label: get("label") ?? "run",
    batch: get("batch") ? Math.max(1, Number(get("batch"))) : DEFAULT_BATCH_SIZE,
  };
}

// The sources whose political coverage is what LITMUS is actually for. The
// snapshot's bulk is tech and science feed volume (Wired 50, ScienceDaily 60,
// CNBC 21) which cannot exercise the top of the scale at all; a run drawn from
// that bulk measures how the scorer handles material the product does not exist
// to judge. These are every political outlet in the corpus, across the spectrum.
const POLITICAL_SOURCES = [
  "Fox News — Politics",
  "Washington Examiner",
  "Washington Times",
  "The American Conservative",
  "The Intercept",
  "The Nation",
  "Vox",
  "Foreign Policy",
  "Axios — Politics & Policy",
  "Bloomberg — Politics",
  "BBC News — US & Canada",
  "NPR — News",
  "PBS NewsHour",
  "NBC News",
];

// The genre controls: pieces that MUST stay cool. If the register rule works,
// vivid sports and culture writing does not climb with the political material.
const CONTROL_SOURCES = ["BBC Sport", "Variety"];

// Every political article, plus genre controls, plus a few science/tech pieces
// carrying the highest baseline scores (where a catastrophizing headline over a
// modest study is the failure mode worth watching).
function politicalSet(details: SnapshotArticleDetail[]): SnapshotArticleDetail[] {
  const picked = new Map<number, SnapshotArticleDetail>();
  const add = (d: SnapshotArticleDetail | undefined) => {
    if (d) picked.set(d.id, d);
  };
  for (const d of details) {
    if (POLITICAL_SOURCES.includes(d.sourceName)) add(d);
    if (CONTROL_SOURCES.includes(d.sourceName)) add(d);
  }
  const hottestOther = details
    .filter((d) => d.score && !picked.has(d.id))
    .sort((a, b) => b.score!.composite - a.score!.composite)
    .slice(0, 6);
  hottestOther.forEach(add);
  return [...picked.values()];
}

// A stratified sample: the pieces most likely to expose a calibration error.
// Hottest baseline scores (should stay hot or go hotter), coldest (should stay
// cold), and every non-political section (the genre-register rule's target).
function stratifiedSample(details: SnapshotArticleDetail[], n: number): SnapshotArticleDetail[] {
  const scored = details.filter((d) => d.score);
  const byComposite = [...scored].sort((a, b) => b.score!.composite - a.score!.composite);
  const picked = new Map<number, SnapshotArticleDetail>();
  const take = (d: SnapshotArticleDetail | undefined) => {
    if (d && !picked.has(d.id) && picked.size < n) picked.set(d.id, d);
  };

  byComposite.slice(0, 4).forEach(take); // hottest under the old prompt
  // One from each non-Politics section — where the genre-register rule bites.
  for (const sec of ["Sports", "Culture", "Science", "Health", "Business", "Technology"]) {
    take(byComposite.find((d) => d.score!.section === sec && !picked.has(d.id)));
  }
  byComposite.slice(-3).forEach(take); // coldest under the old prompt
  for (const d of byComposite) take(d); // top up to n
  return [...picked.values()];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const details = loadSnapshot();

  let selected: SnapshotArticleDetail[];
  if (args.ids.length > 0) {
    const byId = new Map(details.map((d) => [d.id, d]));
    selected = args.ids.map((id) => byId.get(id)).filter((d): d is SnapshotArticleDetail => !!d);
  } else if (args.sample > 0) {
    selected = stratifiedSample(details, args.sample);
  } else if (args.political) {
    selected = politicalSet(details);
  } else if (args.allScored) {
    selected = details.filter((d) => d.score);
  } else {
    throw new Error("specify --ids=..., --sample=N, --political, or --all-scored");
  }
  selected = selected.filter((d) => (d.rawText ?? "").trim().length > 0);
  if (selected.length === 0) throw new Error("no articles selected");

  const models = args.models.map((alias) => {
    const model = MODEL_ALIASES[alias];
    if (!model) throw new Error(`unknown model alias "${alias}" (known: ${Object.keys(MODEL_ALIASES).join(", ")})`);
    return { alias, model };
  });

  const articles = selected.map(toArticle);
  const byId = new Map(selected.map((d) => [d.id, d]));
  const articleById = new Map(articles.map((a) => [a.id, a]));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = `${stamp}-${args.label}`;
  const outPath = resolve(OUT_DIR, `${runId}.json`);
  mkdirSync(OUT_DIR, { recursive: true });

  const run: RunFile = {
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    promptText: CALIBRATION_INSTRUCTIONS,
    promptChars: CALIBRATION_INSTRUCTIONS.length,
    models: models.map((m) => m.model),
    usage: {},
    articles: selected.map((d) => {
      const article = articleById.get(d.id)!;
      const stored = d.score;
      let baseline: ArticleResult["baseline"] = null;
      if (stored) {
        // Baseline metrics are computed with the SAME functions as the new arms,
        // so old and new are measured identically and the comparison is honest.
        const asScore = { ...stored, articleId: d.id, declaredBand: null } as unknown as PHScore;
        const win = buildExcerptWindow(d.rawText, stored.excerptIndices, stored.markers);
        baseline = {
          ...stored,
          metrics: measure(article, asScore),
          excerptParagraphs: win?.paragraphs ?? [],
        };
      }
      return {
        articleId: d.id,
        title: d.title,
        sourceName: d.sourceName,
        url: d.url,
        extractionStatus: d.extractionStatus,
        wordCount: d.wordCount,
        paragraphCount: splitParagraphs(d.rawText).length,
        rawText: d.rawText,
        baseline,
        arms: [],
      };
    }),
    failures: [],
  };

  const resultById = new Map(run.articles.map((r) => [r.articleId, r]));
  const flush = () => writeFileSync(outPath, JSON.stringify(run, null, 2));
  flush(); // write the shell immediately: a crash still leaves an inspectable file

  logger.info("calibration run start", {
    runId,
    articles: articles.length,
    models: models.map((m) => m.alias).join(","),
    promptChars: run.promptChars,
  });

  for (const { alias, model } of models) {
    run.usage[alias] = { inputTokens: 0, outputTokens: 0, calls: 0 };
    const failures = await runArm(
      alias,
      model,
      articles,
      args.batch,
      (u) => {
        const acc = run.usage[alias]!;
        acc.inputTokens += u.inputTokens;
        acc.outputTokens += u.outputTokens;
        acc.calls += 1;
      },
      (scores) => {
        for (const s of scores) {
          const article = articleById.get(s.articleId);
          const result = resultById.get(s.articleId);
          if (!article || !result) continue;
          const win = buildExcerptWindow(article.rawText, s.excerptIndices, s.markers);
          result.arms.push({
            model,
            alias,
            score: s,
            metrics: measure(article, s),
            excerptParagraphs: win?.paragraphs ?? [],
          });
        }
        flush(); // persist per batch — a paid call is never lost to a later crash
      },
    );
    for (const f of failures) run.failures.push({ alias, ...f });
    flush();
  }

  run.finishedAt = new Date().toISOString();
  flush();

  printSummary(run, byId);
  console.log(`\nrun written: ${outPath}`);
}

// A terminal summary is the fast read; the JSON is the record. Both come from
// the same computed metrics, so the console can never flatter the file.
function printSummary(run: RunFile, _byId: Map<number, SnapshotArticleDetail>) {
  const armNames = [...new Set(run.articles.flatMap((a) => a.arms.map((x) => x.alias)))];

  const line = (label: string, composites: number[], markers: number[], inExcerpt: number[], inQuote: number[], unmatched: number[], bandDis: number) => {
    if (composites.length === 0) return;
    const sorted = [...composites].sort((a, b) => a - b);
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)]! : 0;
    };
    const above3 = composites.filter((c) => c >= 3.0).length;
    const above35 = composites.filter((c) => c >= 3.5).length;
    console.log(
      `${label.padEnd(10)} n=${composites.length}` +
        `  composite min ${sorted[0]!.toFixed(1)} / med ${med(composites).toFixed(1)} / max ${sorted[sorted.length - 1]!.toFixed(1)}` +
        `  >=3.0: ${above3}  >=3.5: ${above35}` +
        `  markers med ${med(markers)}  in-excerpt med ${med(inExcerpt)}` +
        `  in-quote ${inQuote.reduce((a, b) => a + b, 0)}  unmatched ${unmatched.reduce((a, b) => a + b, 0)}` +
        `  band-disagree ${bandDis}`,
    );
  };

  console.log("\n=== calibration summary ===");
  const base = run.articles.map((a) => a.baseline).filter((b): b is NonNullable<typeof b> => !!b);
  line(
    "baseline",
    base.map((b) => b.composite),
    base.map((b) => b.metrics.markerCount),
    base.map((b) => b.metrics.markersInExcerpt),
    base.map((b) => b.metrics.markersInQuote),
    base.map((b) => b.metrics.markersUnmatched),
    0,
  );
  for (const alias of armNames) {
    const arms = run.articles.flatMap((a) => a.arms.filter((x) => x.alias === alias));
    line(
      alias,
      arms.map((x) => x.score.composite),
      arms.map((x) => x.metrics.markerCount),
      arms.map((x) => x.metrics.markersInExcerpt),
      arms.map((x) => x.metrics.markersInQuote),
      arms.map((x) => x.metrics.markersUnmatched),
      arms.filter((x) => x.metrics.bandDisagreement).length,
    );
  }

  console.log("\n--- per article (baseline -> arms) ---");
  for (const a of run.articles) {
    const b = a.baseline ? `${a.baseline.composite.toFixed(1)} ${a.baseline.label}` : "—";
    const arms = a.arms
      .map((x) => `${x.alias} ${x.score.composite.toFixed(1)} ${x.score.label} (${x.metrics.markerCount}m/${x.metrics.markersInExcerpt}in)`)
      .join("  ");
    console.log(`[${String(a.articleId).padStart(4)}] ${(a.baseline?.section ?? "?").padEnd(11)} ${b.padEnd(20)} -> ${arms}   ${a.title.slice(0, 60)}`);
  }

  // Flag rates are the diagnostic when the scale still will not move: the
  // composite is computed from these, so a flat run means the flags are never
  // being set, not that the arithmetic is wrong.
  for (const alias of armNames) {
    const arms = run.articles.flatMap((a) => a.arms.filter((x) => x.alias === alias));
    const n = arms.length || 1;
    const rate = (pred: (x: ArmResult) => boolean) =>
      `${arms.filter(pred).length}/${arms.length}`;
    const registers: Record<string, number> = {};
    for (const x of arms) registers[x.score.flags.register] = (registers[x.score.flags.register] ?? 0) + 1;
    console.log(
      `\nflags ${alias}: emotional_lede ${rate((x) => x.score.flags.emotionalLede)}` +
        `  loaded_headline ${rate((x) => x.score.flags.loadedHeadline)}` +
        `  one_sided ${rate((x) => x.score.flags.oneSidedSourcing)}` +
        `  opinion ${rate((x) => x.score.flags.opinionColumn)}` +
        `  mean fallacies ${(arms.reduce((s, x) => s + x.score.flags.fallacyCount, 0) / n).toFixed(1)}` +
        `  registers ${JSON.stringify(registers)}`,
    );
    const dimMax = (k: "headline" | "language" | "sourcing" | "fallacies" | "structure") =>
      Math.max(...arms.map((x) => x.score[k]));
    console.log(
      `dim maxima ${alias}: headline ${dimMax("headline")} language ${dimMax("language")} ` +
        `sourcing ${dimMax("sourcing")} fallacies ${dimMax("fallacies")} structure ${dimMax("structure")}`,
    );
  }

  for (const t of Object.entries(run.usage)) {
    const [alias, u] = t;
    console.log(`\nusage ${alias}: ${u.calls} calls, ${u.inputTokens} in, ${u.outputTokens} out`);
  }
  if (run.failures.length) console.log(`\nFAILURES: ${JSON.stringify(run.failures)}`);
}

main().catch((err) => {
  logger.error("calibration run failed", { err: err instanceof Error ? err.message : String(err) });
  console.error(err);
  process.exit(1);
});
