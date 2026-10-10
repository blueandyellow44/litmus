import { pool } from "../client.js";
import type { PHScore } from "../../scoring/phScorer.js";
import { logger } from "../../lib/logger.js";

// Insert a score row. ON CONFLICT DO NOTHING because article_id is the primary
// key — if a score already exists we leave it alone (we don't rescore).
export async function insertScore(score: PHScore): Promise<void> {
  await pool.query(
    `INSERT INTO scores
       (article_id, headline, language, sourcing, fallacies, structure,
        composite, label, rationale_json, markers, excerpt_indices,
        political_lean, article_summary, reacting_to, section, model_used,
        flags, breakdown, declared_band)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19)
     ON CONFLICT (article_id) DO NOTHING`,
    [
      score.articleId,
      score.headline,
      score.language,
      score.sourcing,
      score.fallacies,
      score.structure,
      score.composite,
      score.label,
      JSON.stringify(score.rationale),
      JSON.stringify(score.markers),
      JSON.stringify(score.excerptIndices),
      score.politicalLean,
      score.articleSummary,
      score.reactingTo,
      score.section,
      score.modelUsed,
      JSON.stringify(score.flags),
      JSON.stringify(score.breakdown),
      score.declaredBand ?? null,
    ],
  );
}

// Replace an existing score with a new one, for the one-judge rescore
// (workers/rescoreHaikuJudged.ts). Every other path keeps insertScore's
// never-overwrite rule; this is the only writer allowed to replace a row.
export async function replaceScore(score: PHScore): Promise<void> {
  await pool.query(
    `INSERT INTO scores
       (article_id, headline, language, sourcing, fallacies, structure,
        composite, label, rationale_json, markers, excerpt_indices,
        political_lean, article_summary, reacting_to, section, model_used,
        flags, breakdown, declared_band)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19)
     ON CONFLICT (article_id) DO UPDATE SET
       headline = EXCLUDED.headline, language = EXCLUDED.language, sourcing = EXCLUDED.sourcing,
       fallacies = EXCLUDED.fallacies, structure = EXCLUDED.structure, composite = EXCLUDED.composite,
       label = EXCLUDED.label, rationale_json = EXCLUDED.rationale_json, markers = EXCLUDED.markers,
       excerpt_indices = EXCLUDED.excerpt_indices, political_lean = EXCLUDED.political_lean,
       article_summary = EXCLUDED.article_summary, reacting_to = EXCLUDED.reacting_to,
       section = EXCLUDED.section, model_used = EXCLUDED.model_used, flags = EXCLUDED.flags,
       breakdown = EXCLUDED.breakdown, declared_band = EXCLUDED.declared_band, scored_at = now()`,
    scoreParams(score),
  );
}

function scoreParams(score: PHScore): unknown[] {
  return [
    score.articleId, score.headline, score.language, score.sourcing, score.fallacies, score.structure,
    score.composite, score.label, JSON.stringify(score.rationale), JSON.stringify(score.markers),
    JSON.stringify(score.excerptIndices), score.politicalLean, score.articleSummary, score.reactingTo,
    score.section, score.modelUsed, JSON.stringify(score.flags), JSON.stringify(score.breakdown),
    score.declaredBand ?? null,
  ];
}

// The inputs the composite was computed FROM, read back for a stored row.
// Every field is nullable: rows written before these columns existed have no
// record of them, and a row is still perfectly valid without one.
export interface StoredCompositeInputs {
  articleId: number;
  composite: number;
  flags: unknown | null;
  breakdown: unknown | null;
  declaredBand: string | null;
}

// JSONB comes back from pg already parsed, but a column written by an older
// path (or by hand) can still arrive as a string. Accept either, and never let
// a malformed value take down the read — an unexplainable score is a smaller
// problem than a query that throws.
function parseJsonb(value: unknown, articleId: number, column: string): unknown | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    logger.warn("scores column held unparseable JSON; treating as absent", {
      articleId,
      column,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function findCompositeInputs(articleId: number): Promise<StoredCompositeInputs | null> {
  const { rows } = await pool.query<{
    article_id: number;
    composite: number;
    flags: unknown;
    breakdown: unknown;
    declared_band: string | null;
  }>(
    `SELECT article_id, composite, flags, breakdown, declared_band
       FROM scores WHERE article_id = $1`,
    [articleId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    articleId: r.article_id,
    composite: r.composite,
    flags: parseJsonb(r.flags, r.article_id, "flags"),
    breakdown: parseJsonb(r.breakdown, r.article_id, "breakdown"),
    declaredBand: r.declared_band ?? null,
  };
}

export async function insertScores(scores: PHScore[]): Promise<void> {
  // Sequential, not parallel — easier to reason about and the volume per cycle
  // is low (tens, not thousands). One bad row must not drop the rest of the
  // batch: log it and keep going.
  for (const s of scores) {
    try {
      await insertScore(s);
    } catch (err) {
      logger.error("insertScore failed, skipping row", {
        articleId: s.articleId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
