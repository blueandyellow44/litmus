// One edition, one judge. Run with: npm run rescore:haiku-judged  (add -- --count to only count)
//
// The live edition on 2026-10-02 mixed scores judged by Haiku (scored up to
// 16:34Z) with scores judged by Jev (19:04Z on), and the two are not on one
// scale: mean composite 1.99 vs 2.51, headline median 2.0 vs 2.8 (audit
// 2026-10-02, section 3.4). Every "X ran hottest, Y calmest" line that compared
// a Haiku-judged telling with a Jev-judged one compared two instruments.
//
// This step re-scores, with Jev judging, every primary full-text member of a
// story on the page (open, judged in political scope) whose stored score was
// judged by Haiku. A replacement is written only when Jev actually judged it:
// if Jev fails on an article, phScorer falls back to a Haiku judgement, and
// swapping one Haiku score for another would fix nothing, so that article keeps
// its old score and is counted as skipped.
//
// OFF unless RESCORE_HAIKU_JUDGED=1 (refresh.sh step 5b). Max turns it on;
// it is never run against production by a session.
//
//   --count   read only: report how many articles it would rescore and the Jev
//             and Haiku calls that would take, then exit without scoring.

import { pool } from "../db/client.js";
import { listArticlesByIds, setCleanText } from "../db/repos/articlesRepo.js";
import { replaceScore } from "../db/repos/scoresRepo.js";
import { BATCH_SIZE, runBatches } from "../scoring/batchRunner.js";
import type { PHScore } from "../scoring/phScorer.js";
import { JEV_MODEL } from "../lib/jev.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { shutdown, crashAndShutdown } from "../lib/shutdown.js";

// A ceiling on one run, so a backlog cannot turn into an unbounded bill.
const DEFAULT_LIMIT = 300;

export const TARGET_SQL = `
  SELECT DISTINCT a.id, s.updated_at
    FROM stories s
    JOIN story_members sm ON sm.story_id = s.id
    JOIN articles a ON a.id = sm.article_id
    JOIN scores sc ON sc.article_id = a.id
   WHERE s.status = 'open' AND s.touches_politics IS TRUE
     AND sm.role = 'primary' AND sm.kind = 'full'
     AND sc.model_used NOT LIKE 'typesafe/jev%'
   ORDER BY s.updated_at DESC, a.id
   LIMIT $1`;

export function isJevJudged(score: PHScore): boolean {
  return score.modelUsed.startsWith(JEV_MODEL);
}

async function main(): Promise<void> {
  const countOnly = process.argv.includes("--count");
  if (!countOnly && process.env.RESCORE_HAIKU_JUDGED !== "1") {
    logger.info("rescore of Haiku-judged members skipped (RESCORE_HAIKU_JUDGED not set)");
    return;
  }
  const limit = Number(process.env.RESCORE_LIMIT ?? DEFAULT_LIMIT);
  const ids = (await pool.query<{ id: number }>(TARGET_SQL, [Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT])).rows.map((r) => r.id);

  if (countOnly) {
    const furniture = env.FURNITURE_FILTER === "jev";
    const report = {
      articles: ids.length,
      // One judgement per article, plus one furniture read per article when the filter is on.
      jevCalls: ids.length * (furniture ? 2 : 1),
      // One writing call per batch, one excerpt-marking call per article, at most
      // one reason retry per batch.
      haikuCallsAtMost: Math.ceil(ids.length / BATCH_SIZE) * 2 + ids.length,
      furnitureFilter: furniture,
    };
    console.log(JSON.stringify(report));
    return;
  }

  if (env.P_H_JUDGE !== "jev") throw new Error("refusing: P_H_JUDGE must be jev, or the rescore would re-judge with Haiku");
  const articles = await listArticlesByIds(ids);
  let replaced = 0;
  let skipped = 0;
  const persist = async (scores: PHScore[]) => {
    for (const score of scores) {
      if (!isJevJudged(score)) { skipped++; continue; }
      await replaceScore(score);
      replaced++;
    }
  };
  const { failedArticleIds } = await runBatches(articles, persist, {}, setCleanText);
  logger.info("rescore of Haiku-judged members done", { requested: articles.length, replaced, skippedJevFailed: skipped, failed: failedArticleIds.length });
}

main().then(() => shutdown()).catch((err) => crashAndShutdown("rescore of Haiku-judged members", err));
