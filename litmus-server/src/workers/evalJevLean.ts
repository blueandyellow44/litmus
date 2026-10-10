// Measure Jev's political lean against the stored (Haiku) lean, read only.
// Usage (from litmus-server), on a READ-ONLY Neon branch, never production:
//   DATABASE_URL=<branch> JEV_ACCOUNT_ID=... JEV_API_TOKEN=... OUT=lean.json npx tsx src/workers/evalJevLean.ts
// Asks Jev ONLY the political_lean question (jevJudge.ts) for every scored
// primary full-text member of an on-page story, over the same body window the
// scorer sees, and reports the share of exact zeros and the mean per outlet
// baseline for both. Writes nothing to the database.
import { writeFileSync } from "node:fs";
import { pool } from "../db/client.js";
import { listArticlesByIds } from "../db/repos/articlesRepo.js";
import { askJev } from "../lib/jev.js";
import { JEV_QUESTIONS, leanFrom } from "../scoring/jevJudge.js";
import { buildArticlePayload } from "../scoring/phScorer.js";
import { env } from "../lib/env.js";

const PRODUCTION_HOST = "ep-sweet-hall-a6w67kf5";
if (env.DATABASE_URL.includes(PRODUCTION_HOST)) throw new Error("refusing: this is the production database; use a read-only branch");

const { rows } = await pool.query<{ id: number; lean: number | null; baseline: string | null }>(`
  SELECT DISTINCT a.id, sc.political_lean AS lean, src.lean AS baseline
    FROM stories s JOIN story_members sm ON sm.story_id = s.id JOIN articles a ON a.id = sm.article_id
    JOIN sources src ON src.id = a.source_id JOIN scores sc ON sc.article_id = a.id
   WHERE s.status = 'open' AND s.touches_politics IS TRUE AND sm.role = 'primary' AND sm.kind = 'full'`);
const articles = new Map((await listArticlesByIds(rows.map((r) => r.id))).map((a) => [a.id, a]));

const results: Array<{ id: number; baseline: string; old: number | null; jev: number | null }> = [];
await Promise.all(rows.map(async (r) => {
  const article = articles.get(r.id);
  if (!article) return;
  const p = buildArticlePayload(article);
  try {
    const { answers } = await askJev({ title: p.title, body_is_complete: p.body_is_complete, body: p.body }, { political_lean: JEV_QUESTIONS.political_lean! });
    results.push({ id: r.id, baseline: r.baseline ?? "unknown", old: r.lean, jev: leanFrom(answers.political_lean) });
  } catch (err) {
    results.push({ id: r.id, baseline: r.baseline ?? "unknown", old: r.lean, jev: null });
    console.error(`jev failed on ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}));

function summarise(pick: (x: (typeof results)[number]) => number | null) {
  const vals = results.map((x) => ({ b: x.baseline, v: pick(x) })).filter((x): x is { b: string; v: number } => x.v !== null);
  const byBaseline: Record<string, { n: number; mean: number }> = {};
  for (const b of [...new Set(vals.map((x) => x.b))].sort()) {
    const vs = vals.filter((x) => x.b === b).map((x) => x.v);
    byBaseline[b] = { n: vs.length, mean: +(vs.reduce((s, v) => s + v, 0) / vs.length).toFixed(1) };
  }
  return { n: vals.length, exactlyZero: vals.filter((x) => x.v === 0).length, withinTen: vals.filter((x) => Math.abs(x.v) <= 10).length, byBaseline };
}
const report = { articles: results.length, jevFailed: results.filter((x) => x.jev === null).length, stored: summarise((x) => x.old), jev: summarise((x) => x.jev) };
console.log(JSON.stringify(report, null, 2));
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ report, results }, null, 2));
await pool.end();
