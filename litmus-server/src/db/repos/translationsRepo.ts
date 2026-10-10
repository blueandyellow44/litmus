import { pool } from "../client.js";
import type { TranslationResult } from "../../translation/translator.js";

// Persist a translation row for an article. Primary key is article_id, so
// ON CONFLICT DO NOTHING — we never regenerate a translation over itself.
// If the scoring/translation model is upgraded, a conscious rescore flow
// should DELETE the old row first.
export async function insertTranslation(articleId: number, t: TranslationResult): Promise<void> {
  await pool.query(
    `INSERT INTO translations
       (article_id, translated_text, diff_json, removed_fallacies_json, model_used)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (article_id) DO NOTHING`,
    [
      articleId,
      t.translatedText,
      JSON.stringify({ notableChanges: t.notableChanges }),
      JSON.stringify(t.removedFallacies),
      t.modelUsed,
    ],
  );
}

// Check if a translation already exists for an article. Used by the API
// handler to short-circuit before hitting Claude.
export async function existsForArticle(articleId: number): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM translations WHERE article_id = $1) AS exists",
    [articleId],
  );
  return rows[0]!.exists;
}
