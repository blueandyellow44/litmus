// Phase 2 worker. Run with: npm run score
//
// Pulls unscored articles, batches them, sends to Haiku, persists EACH batch as
// soon as it succeeds. Idempotent and crash-resumable — safe to run on a cron:
// articles that already have a score row are excluded by the SQL JOIN, so a
// re-run after any crash simply continues from where it stopped. A crash loses
// at most the single in-flight batch (which was never persisted anyway).

import { listUnscoredArticles, setCleanText } from "../db/repos/articlesRepo.js";
import { insertScores } from "../db/repos/scoresRepo.js";
import { runBatches } from "../scoring/batchRunner.js";
import { resolveScoreLimit } from "../scoring/scoreLimit.js";
import { logger } from "../lib/logger.js";
import { shutdown, crashAndShutdown } from "../lib/shutdown.js";

// Sized to what the paper actually renders, not to the backlog.
//
// This was 50 and scripts/refresh.sh ran three cycles, so a run paid to score
// 150 articles. Measured against the edition that produced: clustering kept 30
// of them and the section pages surfaced 15, because the paper shows roughly
// one story per section. The rest were scored and then displayed nowhere.
// Dropped to 40 by Max on 2026-08-02 with SCORE_CYCLES=1, which fills the paper
// with margin and cuts the scoring bill by roughly three quarters.
//
// Raising this only helps if the surfaces that display articles grow too; see
// EDITION_ARTICLE_CAP in clusterCron and the /stories route on the client.
const MAX_PER_CYCLE = 40;

// SCORE_LIMIT was documented in refresh.sh but never read by anything, so a run
// that set it still scored forty. It is honoured here, as a cap that can only
// lower MAX_PER_CYCLE — see scoring/scoreLimit.ts for why it cannot raise it.

async function main(): Promise<void> {
  const limit = resolveScoreLimit(process.env.SCORE_LIMIT, MAX_PER_CYCLE);
  logger.info("score cycle start", { limit, maxPerCycle: MAX_PER_CYCLE });

  const articles = await listUnscoredArticles(limit);
  if (articles.length === 0) {
    logger.info("no unscored articles");
    await shutdown();
    return;
  }

  logger.info("unscored articles found", { count: articles.length });

  // insertScores runs per-batch inside runBatches (durable/resumable), not once
  // at the end — so a mid-cycle crash keeps every batch already written.
  const { scores, failedArticleIds } = await runBatches(articles, insertScores, {}, setCleanText);

  logger.info("score cycle done", {
    requested: articles.length,
    scored: scores.length,
    failed: failedArticleIds.length,
  });
  await shutdown();
}

main().catch((err) => crashAndShutdown("score cycle", err));
