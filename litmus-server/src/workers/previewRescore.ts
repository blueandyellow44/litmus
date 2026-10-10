// Preview step 2 (Max approved a $6 session cap, 2026-09-27): re-score every
// scored member of today's in-scope stories on the PREVIEW Neon branch through
// the real production path: runBatches -> furniture filter -> Jev judges ->
// Haiku writes -> insertScores. Refuses any database but the preview branch.
// Stops the process before the next paid call once spend passes MAX_DOLLARS.
// Usage (from litmus-server): DATABASE_URL=<preview> P_H_JUDGE=jev FURNITURE_FILTER=jev \
//   JEV_ACCOUNT_ID=... JEV_API_TOKEN=... ANTHROPIC_API_KEY=... MAX_DOLLARS=4.2 npx tsx src/workers/previewRescore.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "../db/client.js";
import { listArticlesByIds, setCleanText } from "../db/repos/articlesRepo.js";
import { insertScores } from "../db/repos/scoresRepo.js";
import { runBatches } from "../scoring/batchRunner.js";
import { JEV_INPUT_DOLLARS_PER_MILLION, JEV_MODEL } from "../lib/jev.js";
import { env } from "../lib/env.js";

const PREVIEW_HOST = "ep-square-glade-a6m61k7q";
if (!env.DATABASE_URL.includes(PREVIEW_HOST)) throw new Error("refusing: DATABASE_URL is not the jev-preview branch");
if (env.P_H_JUDGE !== "jev" || env.FURNITURE_FILTER !== "jev") throw new Error("set P_H_JUDGE=jev and FURNITURE_FILTER=jev");
const MAX_DOLLARS = Number(process.env.MAX_DOLLARS ?? "0");
if (!(MAX_DOLLARS > 0)) throw new Error("MAX_DOLLARS required");

// Haiku 4.5 list price, dollars per million tokens.
const HAIKU = { in: 1, out: 5 };
let spent = 0;
const onUsage = (u: { inputTokens: number; outputTokens: number; model: string }) => {
  spent += u.model === JEV_MODEL ? (u.inputTokens * JEV_INPUT_DOLLARS_PER_MILLION) / 1e6 : (u.inputTokens * HAIKU.in + u.outputTokens * HAIKU.out) / 1e6;
  if (spent > MAX_DOLLARS) {
    console.error(`SPEND CAP: $${spent.toFixed(4)} > $${MAX_DOLLARS}; stopping`);
    process.exit(2);
  }
};

// The id list is saved before any score is deleted, so a re-run after a crash
// re-scores the same set instead of finding nothing (the query joins on scores).
const ID_FILE = process.env.PREVIEW_IDS_FILE ?? "";
if (!ID_FILE) throw new Error("PREVIEW_IDS_FILE required");
const ids: number[] = existsSync(ID_FILE) ? JSON.parse(readFileSync(ID_FILE, "utf8")) : (await pool.query(`
  SELECT DISTINCT a.id FROM stories s JOIN story_members sm ON sm.story_id = s.id JOIN articles a ON a.id = sm.article_id
    JOIN scores sc ON sc.article_id = a.id
   WHERE s.status <> 'merged' AND s.touches_politics AND s.updated_at >= now() - interval '26 hours'`)).rows.map((r: { id: number }) => r.id);
if (!existsSync(ID_FILE)) writeFileSync(ID_FILE, JSON.stringify(ids));
// ONLY_FALLBACK=1 re-scores just the articles a previous pass left unscored or
// judged with Haiku (the local Cloudflare login expires after about an hour; a
// production API token does not).
const targets: number[] = process.env.ONLY_FALLBACK === "1"
  ? (await pool.query(`SELECT id FROM unnest($1::int[]) AS id WHERE NOT EXISTS (SELECT 1 FROM scores s WHERE s.article_id = id AND s.model_used LIKE 'typesafe/jev%')`, [ids])).rows.map((r: { id: number }) => r.id)
  : ids;
// insertScores never overwrites (ON CONFLICT DO NOTHING), so the preview branch's
// copies of these scores are removed first. Production is a different database.
await pool.query(`DELETE FROM scores WHERE article_id = ANY($1)`, [targets]);
const articles = await listArticlesByIds(targets);
console.log(`re-scoring ${articles.length} of ${ids.length} articles on the preview branch`);
const { scores, failedArticleIds } = await runBatches(articles, insertScores, { onUsage }, setCleanText);
console.log(JSON.stringify({ requested: articles.length, scored: scores.length, failed: failedArticleIds.length, dollars: +spent.toFixed(4) }));
await pool.end();
