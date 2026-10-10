// Preview step 1 (pennies, Jev only): for every scored member of today's
// in-scope stories on the PREVIEW Neon branch, run the furniture filter (stored
// on the preview branch only) and Jev's judgement through production code, and
// compare the resulting band with the score production published.
// Refuses to run against anything but the preview branch host.
// Usage (from litmus-server): DATABASE_URL=<preview> P_H_JUDGE=jev FURNITURE_FILTER=jev \
//   JEV_ACCOUNT_ID=... JEV_API_TOKEN=... npx tsx src/workers/previewJev.ts <out.json>
import { writeFileSync } from "node:fs";
import { pool } from "../db/client.js";
import { setCleanText } from "../db/repos/articlesRepo.js";
import { prepareForScoring } from "../scoring/batchRunner.js";
import { judgeWithJev } from "../scoring/jevJudge.js";
import { buildScoreWindow } from "../scoring/scoreWindow.js";
import { splitParagraphs } from "../lib/paragraphs.js";
import { applyRegisterPin, computeComposite } from "../scoring/composite.js";
import { bandFor } from "../scoring/calibration.js";
import type { Article } from "../types.js";

const PREVIEW_HOST = "ep-square-glade-a6m61k7q";
if (!(process.env.DATABASE_URL ?? "").includes(PREVIEW_HOST)) throw new Error("refusing: DATABASE_URL is not the jev-preview branch");
const out = process.argv[2];
if (!out) throw new Error("usage: preview-jev-judgements.ts <out.json>");

const rows = (await pool.query(`
  SELECT DISTINCT a.*, src.register AS source_register, sc.composite AS prod_composite, sc.label AS prod_label, src.name AS outlet
    FROM stories s JOIN story_members sm ON sm.story_id = s.id JOIN articles a ON a.id = sm.article_id
    JOIN scores sc ON sc.article_id = a.id JOIN sources src ON src.id = a.source_id
   WHERE s.status <> 'merged' AND s.touches_politics AND s.updated_at >= now() - interval '26 hours'`)).rows;
const articles: Article[] = rows.map((r: any) => ({
  id: r.id, sourceId: r.source_id, url: r.url, title: r.title, author: r.author, publishedAt: r.published_at,
  rawText: r.clean_text ?? r.raw_text, cleaned: r.clean_text != null, wordCount: r.word_count, extractionStatus: r.extraction_status,
  paywallFlag: r.paywall_flag, contentHash: r.content_hash, extractedVia: r.extracted_via, syndicatedOfArticleId: r.syndicated_of_article_id,
  fetchedAt: r.fetched_at, sourceRegister: r.source_register,
}));
const prod = new Map(rows.map((r: any) => [r.id, { composite: r.prod_composite, label: r.prod_label, outlet: r.outlet, title: r.title }]));
const cleaned = await prepareForScoring(articles, setCleanText);
const result: any[] = [];
await Promise.all(cleaned.map(async (a) => {
  try {
    const w = buildScoreWindow(splitParagraphs(a.rawText));
    const j = await judgeWithJev(a.title, w.body, w.complete);
    const b = computeComposite(j.dimensions, applyRegisterPin(j.flags, (a.sourceRegister ?? null) as any));
    result.push({ id: a.id, ...prod.get(a.id), jev_composite: b.composite, jev_label: bandFor(b.composite).label, raised: b.raised, content_type: j.contentType });
  } catch (err) { result.push({ id: a.id, ...prod.get(a.id), error: err instanceof Error ? err.message : String(err) }); }
}));
const furniture = (await pool.query(`SELECT count(*)::int n, sum(jsonb_array_length(furniture))::int paragraphs FROM articles WHERE id = ANY($1) AND furniture IS NOT NULL AND jsonb_array_length(furniture) > 0`, [articles.map((a) => a.id)])).rows[0];
await pool.end();
const BANDS = ["Proportionate", "Grounded", "Mixed Signals", "Running Hot", "Hyperbolic"];
const count = (k: string) => Object.fromEntries(BANDS.map((b) => [b, result.filter((r) => r[k] === b).length]));
const summary = { articles: articles.length, jev_errors: result.filter((r) => r.error).length, articles_with_furniture_set_aside: furniture.n, furniture_paragraphs: furniture.paragraphs, production: count("label"), jev: count("jev_label") };
writeFileSync(out, JSON.stringify({ summary, result }, null, 2));
console.log(JSON.stringify(summary, null, 1));
