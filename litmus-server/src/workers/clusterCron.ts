// Phase 8 worker. Run with: npm run cluster
//
// Pulls scored articles from the last 24h, sends headlines + snippets to
// Sonnet for topic grouping, replaces all cluster rows in a single txn.
// Idempotent — safe to run on a 30-minute cron.

import { listRecentScoredArticles, FRESH_WINDOW_HOURS } from "../db/repos/articlesRepo.js";
import { replaceAllClusters, getArticleSections } from "../db/repos/clustersRepo.js";
import { clusterArticles } from "../clustering/topicClusterer.js";
import { logger } from "../lib/logger.js";
import { shutdown, crashAndShutdown } from "../lib/shutdown.js";

// Majority vote over the member articles' scored sections. Articles with no
// section (scored before Phase 2, or unclassified) do not vote; a cluster
// whose members are all unsectioned gets section null.
function majoritySection(articleIds: number[], sections: Map<number, string | null>): string | null {
  const counts = new Map<string, number>();
  for (const id of articleIds) {
    const s = sections.get(id);
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [s, n] of counts) {
    if (n > bestCount) {
      best = s;
      bestCount = n;
    }
  }
  return best;
}

// How many articles a single edition draws from. A rewspaper is a finite paper,
// not a firehose: ingest deliberately casts a wide net (roughly 1,400 articles a
// day, which costs nothing because no model call is involved), but the edition
// is curated down to this. Set to 100 by Max on 2026-08-02, down from 200, so
// each story gets more room and the day's paper stays readable.
//
// This number also sizes the scoring spend. Scoring is the expensive step and
// there is no point paying for an article the edition can never print, so
// scripts/refresh.sh scores to a target derived from this cap plus headroom
// rather than draining the whole unscored backlog. If you change this, change
// SCORE_CYCLES there in the same edit.
// How many scored articles are offered to the clusterer. Deliberately generous,
// and NOT the same lever as scoring spend.
//
// Clustering is ONE model call whatever the input size, so feeding it 40
// articles instead of 200 saves almost nothing and costs a great deal: two
// outlets can only be shown side by side if both are in front of the clusterer
// at the same time, so every article withheld is a source a story cannot have.
// A lead story with many sources requires many candidates, and this was briefly
// set to 40 on the mistaken assumption that it tracked cost.
//
// The expensive knob is MAX_PER_CYCLE in scoreCron (per-article model calls).
// If stories are still thin, raise THAT, not this.
const EDITION_ARTICLE_CAP = 200;

async function main(): Promise<void> {
  logger.info("cluster cycle start");

  const stubs = await listRecentScoredArticles(24, EDITION_ARTICLE_CAP);
  if (stubs.length < 2) {
    logger.info("not enough scored articles to cluster", { count: stubs.length });
    await shutdown();
    return;
  }

  logger.info("clustering articles", { count: stubs.length });

  const proposalsRaw = await clusterArticles(stubs);
  logger.info("clusters proposed", { count: proposalsRaw.length });

  // A story runs only if it contains current reporting. Older analysis — an
  // Economist or Atlantic piece from last week — is welcome and often the most
  // valuable thing on the page, but it earns its place by attaching to a story
  // that is running NOW, not on its own. A cluster made entirely of older
  // material is not a current story; it is back copy, and printing it as
  // today's news is how a June feed item ends up leading an August edition.
  //
  // Note this keeps the older piece IN its cluster: the whole point is that it
  // sits beside the reporting it illuminates. Only clusters with no fresh
  // member at all are dropped.
  const freshIds = new Set(stubs.filter((s) => s.isFresh).map((s) => s.id));
  const proposals = proposalsRaw.filter((p) => p.articleIds.some((id) => freshIds.has(id)));
  const dropped = proposalsRaw.length - proposals.length;
  if (dropped > 0) {
    logger.info("dropped stale-only clusters", {
      dropped,
      kept: proposals.length,
      freshWindowHours: FRESH_WINDOW_HOURS,
    });
  }
  if (proposals.length === 0) {
    logger.warn("every proposed cluster lacked a fresh article; nothing to publish", {
      proposed: proposalsRaw.length,
    });
    await shutdown();
    return;
  }

  // Derive each cluster's section from its members' scored sections.
  const sections = await getArticleSections(proposals.flatMap((p) => p.articleIds));
  const sectioned = proposals.map((p) => ({
    ...p,
    section: majoritySection(p.articleIds, sections),
  }));

  await replaceAllClusters(sectioned);

  const totalClustered = proposals.reduce((n, p) => n + p.articleIds.length, 0);
  logger.info("cluster cycle done", {
    clusters: proposals.length,
    articlesClustered: totalClustered,
    articlesUnclustered: stubs.length - totalClustered,
  });

  await shutdown();
}

main().catch((err) => crashAndShutdown("cluster cycle", err));
