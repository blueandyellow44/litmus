// Groups articles into batches, scores them through Haiku with bounded
// concurrency, retries transient failures, and persists each batch the moment
// it succeeds. The cron worker calls into here.

import type { Article } from "../types.js";
import { scoreBatch, type PHScore, type ScoreBatchOptions } from "./phScorer.js";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { jevAvailable } from "../lib/jev.js";
import { filterFurniture, type SetAside } from "./furniture.js";

export type PersistCleanText = (id: number, cleanText: string, furniture: SetAside[]) => Promise<void>;

// Run the furniture filter (FURNITURE_FILTER=jev) on every article in the batch
// that has not been filtered yet, store the result, and return the articles as
// the scorer should see them. Storing happens BEFORE scoring, so a stored score
// is always computed on the text its excerpt is later built from. A filter
// failure leaves that article unfiltered: it is scored on its raw text as before.
export async function prepareForScoring(articles: Article[], persist: PersistCleanText): Promise<Article[]> {
  if (env.FURNITURE_FILTER !== "jev") return articles;
  if (!jevAvailable()) {
    logger.warn("FURNITURE_FILTER is jev but Jev is not available; scoring raw text", { articles: articles.length });
    return articles;
  }
  return Promise.all(articles.map(async (article) => {
    if (article.cleaned) return article;
    try {
      const { cleanText, furniture } = await filterFurniture(article.title, article.rawText);
      await persist(article.id, cleanText, furniture);
      if (furniture.length > 0) logger.info("furniture set aside", { articleId: article.id, paragraphs: furniture.length });
      return { ...article, rawText: cleanText, cleaned: true };
    } catch (err) {
      logger.warn("furniture filter failed; scoring raw text", { articleId: article.id, err: err instanceof Error ? err.message : String(err) });
      return article;
    }
  }));
}

// Small batches keep each Haiku call light (less input, less output → faster,
// no max_tokens truncation of the tool JSON). Concurrency is where the wall-time
// win comes from: CONCURRENCY batches are in flight at once instead of one at a
// time. 4×5 = up to 20 articles scoring simultaneously, well inside Haiku limits.
export const BATCH_SIZE = 4;
export const CONCURRENCY = 5;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 1500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface BatchRunResult {
  scores: PHScore[];
  failedArticleIds: number[];
}

// Score every article. Batches run through a fixed pool of CONCURRENCY workers.
// Each batch is retried up to MAX_RETRIES times on transient errors; articles in
// a batch that exhausts retries are reported in failedArticleIds so the caller
// can re-enqueue them next cycle.
//
// `onBatchScored` (if given) is awaited right after each batch succeeds. Pass a
// DB writer here so a crash mid-run can never lose already-scored batches: the
// unscored-article queue + the scores.article_id primary key make the whole job
// idempotent and resumable — just run it again. A persist failure is logged but
// does not retry the (paid) Haiku call.
export async function runBatches(
  articles: Article[],
  onBatchScored?: (scores: PHScore[]) => Promise<void>,
  scoreOptions: ScoreBatchOptions = {},
  persistCleanText?: PersistCleanText,
): Promise<BatchRunResult> {
  const batches = chunk(articles, BATCH_SIZE);
  const allScores: PHScore[] = [];
  const failed: number[] = [];
  let next = 0; // shared cursor; ++ is atomic in JS's single-threaded loop
  let done = 0;

  logger.info("scoring start", {
    articles: articles.length,
    batches: batches.length,
    concurrency: CONCURRENCY,
  });

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= batches.length) return;
      // Filtered once per article; a retry reuses the stored result via `cleaned`.
      const batch = persistCleanText ? await prepareForScoring(batches[i]!, persistCleanText) : batches[i]!;
      let lastErr: unknown = null;
      let success = false;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const scores = await scoreBatch(batch, scoreOptions);
          // Persist immediately: a crash after this point cannot lose this
          // batch. A write failure must NOT re-run the paid Haiku call, so it is
          // caught here (insertScores itself already swallows per-row errors).
          if (onBatchScored && scores.length > 0) {
            try {
              await onBatchScored(scores);
            } catch (persistErr) {
              logger.error("batch persist failed", {
                batchIndex: i,
                err: persistErr instanceof Error ? persistErr.message : String(persistErr),
              });
            }
          }
          allScores.push(...scores);
          logger.info("batch scored", {
            batchIndex: i,
            returned: scores.length,
            progress: `${++done}/${batches.length}`,
          });
          success = true;
          break;
        } catch (err) {
          lastErr = err;
          logger.warn("batch scoring attempt failed", {
            batchIndex: i,
            attempt,
            err: err instanceof Error ? err.message : String(err),
          });
          if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * (attempt + 1));
        }
      }

      if (!success) {
        logger.error("batch failed after retries", {
          batchIndex: i,
          articleIds: batch.map((a) => a.id),
          err: lastErr instanceof Error ? lastErr.message : String(lastErr),
        });
        failed.push(...batch.map((a) => a.id));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()),
  );

  return { scores: allScores, failedArticleIds: failed };
}
