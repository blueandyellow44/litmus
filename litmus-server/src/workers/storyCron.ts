// Persistent Story Ledger worker. Runs after ingest and before scoring.

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendStoryEvent,
  finishStoryRun,
  listStoryRunUsage,
  recordArticleSweep,
  recordStoryRunUsage,
  recordStorySweepChecks,
  listStorySweepChecks,
  setStoryArticleState,
  startStoryRun,
} from "../db/repos/storiesRepo.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import { crashAndShutdown, shutdown } from "../lib/shutdown.js";
import { assignArticleBatches, type ModelUsage } from "../stories/assignment.js";
import { jevAvailable } from "../lib/jev.js";
import type { StoryCard } from "../stories/retrieval.js";
import { jevAssignmentPrepass, jevReviewMerge, jevSweepArticles, withOpenings } from "../stories/jevGrouping.js";
import {
  loadCriticStories,
  mergeCandidatePairs,
  needsSplitReview,
  reviewMerge,
  reviewSplit,
} from "../stories/critic.js";
import {
  buildCoverageReport,
  loadCoverageReportInput,
  writeCoverageReport,
} from "../stories/coverageReport.js";
import {
  applyStoryDecisions,
  applyStorySplit,
  applySweepAttachment,
  attachDeterministically,
  mergeReviewedPair,
  type AppliedArticleOutcome,
} from "../stories/ledger.js";
import {
  findDeterministicStoryForArticle,
  listOpenStoryCards,
  listUnassignedStoryArticles,
  retrieveCandidateStories,
  type StoryArticle,
} from "../stories/retrieval.js";
import { sweepArticles } from "../stories/sweep.js";
import { assessStories } from "../stories/assessment.js";
import { insertScores } from "../db/repos/scoresRepo.js";
import { listUnscoredStoryMembers, setCleanText } from "../db/repos/articlesRepo.js";
import { runBatches } from "../scoring/batchRunner.js";
import { mapLimit } from "../stories/concurrency.js";
import { resolveStoryLookbackDays } from "../stories/lookbackLimit.js";
import { FatalModelError, rethrowIfFatal } from "../stories/modelErrors.js";

// A hard per-run cap, the same shape as scoreCron.ts's MAX_PER_CYCLE: bounded
// so a run finishes inside the funnel's 25-minute step timeout. Articles are
// taken NEWEST first (2026-09-27, Max: "why is it showing yesterday's paper?"):
// oldest-first, set on 2026-09-21 to drain a backlog, left the day's own news
// ungrouped behind yesterday's leftovers (398 eligible, 200 taken). 400 covers
// a normal day; grouping 200 cost about $0.53 on 2026-09-26.
//
// 800 since 2026-10-06 (Max: "offer all 600 articles"). At 400 the cap was
// binding every day: 600 eligible on 10-06 and 436 on 10-05, so a third of a
// day's articles never reached the matcher, and a page where new stories
// (128) roughly equal attachments (129) is the arithmetic of two-source
// stories. The 10-06 run's grouping phases took under 7 minutes for 400
// articles inside a 45-minute step, and Jev's grouping cost $0.57 for the
// day, so eligible should mean offered; 800 is a safety ceiling for a
// backlog, not a dial.
export const MAX_ARTICLES_PER_RUN = 800;

// The critic's caps (2026-09-22). Before these, the merge review compared
// every pair of open stories that shared one name, one call at a time with no
// limit: 957 calls for a 200-article day, about 2,800 with leftover stories,
// and every production ledger timeout (docs/run-failures/inventory-2026-09-22.md).
// Reviews now run CRITIC_CONCURRENCY at a time, like assignment and sweep, and
// stop at these caps, strongest candidates first. At 2 s a call the worst case
// is about 2 minutes. Pairs past the cap are skipped and counted in the log.
//
// Merge cap 1000 since 2026-10-06 (Max: "check every merge pair"). At 150 the
// 10-06 run flagged 329 pairs and skipped 179 of them, so stories the critic
// itself suspected were one event stayed split. Jev reviewed the 150 in 9 s
// for $0.007; even on Haiku at 2 s a call, 5 at a time, 1000 pairs is under
// 7 minutes of a 45-minute step. The cap stays only as a backlog ceiling.
export const MAX_MERGE_REVIEWS_PER_RUN = 1000;
export const MAX_SPLIT_REVIEWS_PER_RUN = 50;
const CRITIC_CONCURRENCY = 5;

// The plain-language assessment (2026-09-26): the lede on every front-page
// item. Most-covered stories first, one to two Haiku calls each, capped so the
// phase stays around two and a half minutes (150 since 2026-09-27; 60 left
// the day's new stories unjudged and hidden); stories past the cap keep the ledger's
// event statement as their lede until the next run.
export const MAX_ASSESSMENTS_PER_RUN = 150;

// Scoring coverage (2026-09-26): after grouping, score the unscored members of
// multi-outlet stories, most-covered first, so every story can show its
// calmest and hottest telling. Runs before the assessment so the assessment
// reads their summaries. Capped; the rest wait for the next run.
//
// 200 since 2026-10-07 (Max: "do it"). At 100 the 10-07 edition scored 92
// and 26 of its 51 front-page stories showed one graded outlet; 92 took about
// 6 minutes, so 200 adds about 6 more.
export const MAX_MEMBER_SCORES_PER_RUN = 200;

export interface StoryRunResult {
  runId: number;
  counts: Record<string, number>;
  sweepComplete: boolean;
  coveragePath: string;
}

export interface StoryRunOptions {
  coveragePath?: string;
  now?: () => Date;
}

function countOutcomes(outcomes: readonly AppliedArticleOutcome[]): Record<string, number> {
  const counts = { offered: outcomes.length, attached: 0, new: 0, flagged: 0, not_news: 0 };
  for (const outcome of outcomes) counts[outcome.category] += 1;
  const resolved = counts.attached + counts.new + counts.flagged + counts.not_news;
  if (resolved !== counts.offered) {
    throw new Error(`offered equation failed: ${counts.offered} != ${resolved}`);
  }
  return counts;
}

function aggregateUsage(rows: Awaited<ReturnType<typeof listStoryRunUsage>>): Record<string, unknown> {
  const stages: Record<string, { calls: number; inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; wallMs: number }> = {};
  for (const row of rows) {
    const current = stages[row.stage] ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      wallMs: 0,
    };
    current.calls += 1;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheCreationInputTokens += row.cacheCreationInputTokens;
    current.cacheReadInputTokens += row.cacheReadInputTokens;
    current.wallMs += row.wallMs;
    stages[row.stage] = current;
  }
  return stages;
}

function countByCategory(outcomes: readonly AppliedArticleOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) counts[outcome.category] = (counts[outcome.category] ?? 0) + 1;
  return counts;
}

const PROGRESS_EVERY = 25;
const ERROR_LOG_LIMIT = 3;

// Progress for the one-review-at-a-time critic loops: a line every
// PROGRESS_EVERY reviews, and the first few errors in full. Errors past that
// are counted and reported when the phase ends, so a run where every call
// fails cannot flood the log, and cannot be silent either.
function progressLogger(runId: number, phase: string, total: number) {
  let done = 0;
  let errors = 0;
  return {
    tick() {
      done += 1;
      if (done % PROGRESS_EVERY === 0) logger.info("story ledger progress", { runId, phase, done, total, errors });
    },
    error(error: unknown) {
      errors += 1;
      if (errors <= ERROR_LOG_LIMIT) {
        logger.warn("story ledger review failed", {
          runId,
          phase,
          errors,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        });
      }
    },
    get errors() {
      return errors;
    },
  };
}

export async function runStoryLedger(options: StoryRunOptions = {}): Promise<StoryRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const run = await startStoryRun();
  const coveragePath = path.resolve(
    options.coveragePath ?? process.env.STORY_COVERAGE_OUT ?? path.join(process.cwd(), "coverage-report.json"),
  );
  logger.info("story ledger run start", { runId: run.id, coveragePath });

  // Progress logging (2026-09-22). Before this, a run printed three lines and
  // then nothing until it finished or was killed; the 15-20 minute timeouts
  // on 2026-09-21/22 were an uncapped merge loop that logged nothing at all
  // (docs/run-failures/inventory-2026-09-22.md). Every phase now logs its
  // start and end with counts, calls, failures and elapsed time.
  const callStats = new Map<string, { calls: number; failed: number }>();
  let currentPhase = "setup";
  const outcomes: AppliedArticleOutcome[] = [];
  const countCall = (stage: string, status: "succeeded" | "failed") => {
    const stats = callStats.get(stage) ?? { calls: 0, failed: 0 };
    stats.calls += 1;
    if (status === "failed") stats.failed += 1;
    callStats.set(stage, stats);
  };
  const startPhase = (phase: string, detail: Record<string, unknown> = {}) => {
    currentPhase = phase;
    const phaseStartedAt = Date.now();
    const before = new Map([...callStats].map(([stage, stats]) => [stage, { ...stats }]));
    logger.info("story ledger phase start", { runId: run.id, phase, ...detail });
    return (result: Record<string, unknown> = {}) => {
      const calls: Record<string, { calls: number; failed: number }> = {};
      for (const [stage, stats] of callStats) {
        const prior = before.get(stage) ?? { calls: 0, failed: 0 };
        if (stats.calls > prior.calls) calls[stage] = { calls: stats.calls - prior.calls, failed: stats.failed - prior.failed };
      }
      logger.info("story ledger phase done", {
        runId: run.id,
        phase,
        elapsedMs: Date.now() - phaseStartedAt,
        calls,
        ...result,
      });
    };
  };

  const recordUsage = (stage: string) => async (
    usage: ModelUsage & { model: string; callIndex: number; wallMs: number; status: "succeeded" | "failed"; error: string | null },
  ): Promise<void> => {
    countCall(stage, usage.status);
    await recordStoryRunUsage({ runId: run.id, stage, ...usage });
  };

  try {
    const lookbackDays = resolveStoryLookbackDays(process.env.STORY_LOOKBACK_DAYS);
    const eligible = await listUnassignedStoryArticles(lookbackDays);
    const offered = eligible.slice(0, MAX_ARTICLES_PER_RUN);
    logger.info("story ledger offered articles", {
      runId: run.id,
      lookbackDays,
      eligibleCount: eligible.length,
      offeredCount: offered.length,
      maxArticlesPerRun: MAX_ARTICLES_PER_RUN,
    });
    const forModel: StoryArticle[] = [];

    // This stays serial: a deterministic copy can point at an article that was
    // itself attached earlier in the same run.
    const endDeterministic = startPhase("deterministic attach", { articles: offered.length });
    for (const article of offered) {
      const storyId = await findDeterministicStoryForArticle(article.id);
      if (storyId) outcomes.push(await attachDeterministically(run.id, article, storyId));
      else forModel.push(article);
    }

    const forModelIds = new Set(forModel.map((article) => article.id));
    const deferredIds = new Set<number>();
    const firstByOutletAndUrl = new Map<string, number>();
    for (const article of forModel) {
      if (article.syndicatedOfArticleId !== null && forModelIds.has(article.syndicatedOfArticleId)) {
        deferredIds.add(article.id);
      }
      const key = `${article.outletKey}\u0000${article.url}`;
      const first = firstByOutletAndUrl.get(key);
      if (first === undefined) {
        firstByOutletAndUrl.set(key, article.id);
      } else {
        deferredIds.add(article.id);
      }
    }

    endDeterministic({ attached: outcomes.length, forModel: forModel.length });

    const firstPass = forModel.filter((article) => !deferredIds.has(article.id));
    const delayedPass = forModel.filter((article) => deferredIds.has(article.id));

    const candidates = new Map<number, Awaited<ReturnType<typeof retrieveCandidateStories>>>();
    const allModeled = [...firstPass, ...delayedPass];
    const endRetrieval = startPhase("candidate retrieval", { articles: allModeled.length });
    const retrieved = await mapLimit(allModeled, 8, (article) => retrieveCandidateStories(article, 20, lookbackDays));
    allModeled.forEach((article, index) => candidates.set(article.id, retrieved[index]!));
    endRetrieval({ candidates: retrieved.reduce((sum, list) => sum + list.length, 0) });

    // Jev decides same-event questions when STORY_JUDGE=jev and it is
    // configured; an unconfigured Jev means the Haiku ledger, said out loud.
    const jevJudges = env.STORY_JUDGE === "jev" && jevAvailable();
    if (env.STORY_JUDGE === "jev" && !jevJudges) logger.warn("STORY_JUDGE=jev but Jev is not configured; the ledger runs on Haiku alone", { runId: run.id });
    let assignmentCallIndex = 0;
    let jevPrepassRound = 0;
    const runAssignment = async (articles: StoryArticle[]) => {
      if (articles.length === 0) return;
      let decided: Awaited<ReturnType<typeof jevAssignmentPrepass>>["decided"] = [];
      let forHaiku = articles;
      let haikuCandidates: ReadonlyMap<number, readonly StoryCard[]> = candidates;
      if (jevJudges) {
        const round = ++jevPrepassRound;
        const prepass = await jevAssignmentPrepass(await withOpenings(articles), candidates, recordUsage(`jev_assignment_${round}`));
        logger.info("jev assignment pre-pass", { runId: run.id, round, offered: articles.length, ...prepass.stats });
        decided = prepass.decided;
        forHaiku = prepass.forHaiku;
        haikuCandidates = prepass.candidatesForHaiku;
      }
      const assignment = forHaiku.length === 0
        ? { decisions: [], calls: 0 }
        : await assignArticleBatches(forHaiku, haikuCandidates, {
          onUsage: recordUsage("assignment"),
          startingCallIndex: assignmentCallIndex,
          model: env.STORY_MODEL,
        });
      assignmentCallIndex += assignment.calls;
      const byId = new Map([...decided, ...assignment.decisions].map((decision) => [decision.articleId, decision]));
      const applied = await applyStoryDecisions(run.id, articles, articles.map((article) => byId.get(article.id)!));
      outcomes.push(...applied.outcomes);
    };

    const endAssignment = startPhase("assignment", { firstPass: firstPass.length, delayed: delayedPass.length });
    await runAssignment(firstPass);

    const delayedCandidates: StoryArticle[] = [];
    for (const article of delayedPass) {
      const storyId = await findDeterministicStoryForArticle(article.id);
      if (storyId) outcomes.push(await attachDeterministically(run.id, article, storyId));
      else delayedCandidates.push(article);
    }
    await runAssignment(delayedCandidates);
    endAssignment({ outcomes: countByCategory(outcomes) });

    const outcomeByArticle = new Map(outcomes.map((outcome) => [outcome.articleId, outcome]));
    const articleById = new Map(offered.map((article) => [article.id, article]));
    const newStorySizes = new Map<string, number>();
    for (const outcome of outcomes) {
      if (outcome.category === "new" && outcome.seededStoryId) {
        newStorySizes.set(outcome.seededStoryId, (newStorySizes.get(outcome.seededStoryId) ?? 0) + 1);
      }
    }
    const sweepTargets = outcomes
      .filter((outcome) => outcome.category === "flagged"
        || (outcome.category === "new" && outcome.seededStoryId !== null && newStorySizes.get(outcome.seededStoryId) === 1))
      .map((outcome) => articleById.get(outcome.articleId)!);
    const seededStoryIds = new Map(
      outcomes
        .filter((outcome) => outcome.seededStoryId !== null)
        .map((outcome) => [outcome.articleId, outcome.seededStoryId!] as const),
    );
    const openCards = await listOpenStoryCards(lookbackDays);
    const endSweep = startPhase("sweep", { articles: sweepTargets.length, openStories: openCards.length });
    const onValidatedBatch = async ({ shard, articleIds, checkedByArticle, checks }: Parameters<NonNullable<Parameters<typeof sweepArticles>[2]>["onValidatedBatch"] & {}>[0]) => {
      await Promise.all(articleIds.map((articleId) =>
        recordArticleSweep({ runId: run.id, articleId, shard, storiesChecked: checkedByArticle.get(articleId) ?? 0 }),
      ));
      await recordStorySweepChecks(checks.map((check) => ({ runId: run.id, ...check })));
    };
    const sweep = jevJudges
      ? await jevSweepArticles(await withOpenings(sweepTargets), openCards, { seededStoryIds, onUsage: recordUsage("jev_sweep"), onValidatedBatch })
      : await sweepArticles(sweepTargets, openCards, {
        seededStoryIds,
        model: env.STORY_MODEL,
        onUsage: recordUsage("sweep"),
        onValidatedBatch,
      });

    for (const decision of sweep.decisions) {
      const article = articleById.get(decision.articleId)!;
      const original = outcomeByArticle.get(decision.articleId)!;
      if (decision.action === "attach") {
        await applySweepAttachment(
          run.id,
          article,
          decision.storyIds,
          decision.role,
          decision.reason,
          original.seededStoryId,
        );
        original.category = "attached";
        original.storyIds = [...decision.storyIds];
        original.seededStoryId = null;
      } else if (decision.action === "flag") {
        await setStoryArticleState(article.id, "flag", decision.reason, run.id);
        await appendStoryEvent({
          runId: run.id,
          articleId: article.id,
          storyId: original.seededStoryId,
          action: "sweep_flag",
          reason: decision.reason,
        });
        original.category = "flagged";
        original.storyIds = [];
        original.seededStoryId = null;
      }
    }

    endSweep({
      decisions: sweep.decisions.length,
      incomplete: sweep.incompleteArticleIds.length,
      outcomes: countByCategory([...outcomeByArticle.values()]),
    });

    const sweepChecks = await listStorySweepChecks(run.id);
    const expectedChecks = new Map<number, Set<string>>();
    for (const article of sweepTargets) {
      const storyId = outcomeByArticle.get(article.id)?.seededStoryId ?? null;
      expectedChecks.set(
        article.id,
        new Set(openCards.filter((card) => card.id !== storyId).map((card) => card.id)),
      );
    }
    const observedChecks = new Map<number, Set<string>>();
    let checksMatch = true;
    for (const check of sweepChecks) {
      if (!expectedChecks.has(check.articleId)) {
        checksMatch = false;
        break;
      }
      const articleChecks = observedChecks.get(check.articleId) ?? new Set<string>();
      articleChecks.add(check.storyId);
      observedChecks.set(check.articleId, articleChecks);
    }
    if (checksMatch && expectedChecks.size !== observedChecks.size) checksMatch = false;
    if (checksMatch) {
      for (const [articleId, expected] of expectedChecks) {
        const observed = observedChecks.get(articleId) ?? new Set<string>();
        if (expected.size !== observed.size) {
          checksMatch = false;
          break;
        }
        for (const storyId of expected) {
          if (!observed.has(storyId)) {
            checksMatch = false;
            break;
          }
        }
        if (!checksMatch) break;
      }
    }

    const sweepComplete = sweep.incompleteArticleIds.length === 0 && checksMatch;
    if (!sweepComplete) {
      await appendStoryEvent({
        runId: run.id,
        articleId: null,
        storyId: null,
        action: "sweep_incomplete",
        reason: "Sweep check persistence did not match model coverage.",
      });
    }

    let criticCall = 0;
    const criticUsage = async (
      usage: ModelUsage & { model: string; stage: "critic"; callIndex: number; wallMs: number; status: "succeeded" | "failed"; error: string | null },
    ): Promise<void> => {
      countCall(usage.stage, usage.status);
      await recordStoryRunUsage({ runId: run.id, ...usage });
    };
    const criticStories = await loadCriticStories(run.id, lookbackDays);
    // Split review: the biggest stories first, capped, reviewed CRITIC_CONCURRENCY
    // at a time; the splits are applied afterwards, one at a time.
    const splitCandidates = criticStories
      .filter(needsSplitReview)
      .sort((a, b) => b.primaryMembers.length - a.primaryMembers.length);
    const splitTargets = splitCandidates.slice(0, MAX_SPLIT_REVIEWS_PER_RUN);
    const endSplit = startPhase("split review", {
      stories: splitCandidates.length,
      reviewing: splitTargets.length,
      skippedOverCap: splitCandidates.length - splitTargets.length,
    });
    const splitProgress = progressLogger(run.id, "split review", splitTargets.length);
    const splitReviews = await mapLimit(splitTargets, CRITIC_CONCURRENCY, async (story) => {
      try {
        const review = await reviewSplit(story, {
          callIndex: ++criticCall,
          model: env.STORY_MODEL,
          onUsage: criticUsage,
        });
        splitProgress.tick();
        return review;
      } catch (error) {
        rethrowIfFatal(error);
        splitProgress.tick();
        splitProgress.error(error);
        await appendStoryEvent({
          runId: run.id,
          articleId: null,
          storyId: story.card.id,
          action: "split_review_error",
          reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        });
        return null;
      }
    });
    let splitsApplied = 0;
    for (const review of splitReviews) {
      if (!review) continue;
      if (!review.valid) {
        await appendStoryEvent({
          runId: run.id,
          articleId: review.anchorArticleId,
          storyId: review.storyId,
          action: "split_review_flag",
          reason: review.reason,
        });
      } else if (review.groups.length > 1) {
        await applyStorySplit(run.id, review.storyId, review.anchorArticleId, review.groups, review.reason);
        splitsApplied += 1;
      }
    }
    endSplit({ errors: splitProgress.errors, splitsApplied });

    // Merge review: strongest pairs first (mergeCandidatePairs ranks them),
    // capped, reviewed CRITIC_CONCURRENCY at a time against this one snapshot.
    // The "yes" merges are applied afterwards, one at a time, each side
    // followed to its live survivor first (mergeReviewedPair), so A-B then A-C
    // cannot clash. Before 2026-09-22 this was one uncapped call at a time
    // over every pair, and it was the whole of every ledger timeout.
    const cardsAfterSplits = await listOpenStoryCards(lookbackDays);
    const mergeCandidates = mergeCandidatePairs(cardsAfterSplits);
    const mergePairs = mergeCandidates.slice(0, MAX_MERGE_REVIEWS_PER_RUN);
    const endMerge = startPhase("merge review", {
      openStories: cardsAfterSplits.length,
      pairs: mergeCandidates.length,
      reviewing: mergePairs.length,
      skippedOverCap: mergeCandidates.length - mergePairs.length,
    });
    const mergeProgress = progressLogger(run.id, "merge review", mergePairs.length);
    const mergeReviews = await mapLimit(mergePairs, CRITIC_CONCURRENCY, async ({ left, right }) => {
      try {
        const review = jevJudges
          ? await jevReviewMerge(left, right, recordUsage("jev_merge"), ++criticCall)
          : await reviewMerge(left, right, {
            callIndex: ++criticCall,
            model: env.STORY_MODEL,
            onUsage: criticUsage,
          });
        mergeProgress.tick();
        return { left, right, review };
      } catch (error) {
        rethrowIfFatal(error);
        mergeProgress.tick();
        mergeProgress.error(error);
        await appendStoryEvent({
          runId: run.id,
          articleId: null,
          storyId: left.id,
          action: "merge_review_error",
          reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          detail: { otherStoryId: right.id },
        });
        return null;
      }
    });
    let mergesApplied = 0;
    for (const result of mergeReviews) {
      if (!result) continue;
      const { left, right, review } = result;
      if (review.decision === "yes") {
        const outcome = await mergeReviewedPair(run.id, left.id, right.id, review.reason);
        if (outcome.merged) mergesApplied += 1;
      } else if (review.decision === "unsure") {
        await appendStoryEvent({
          runId: run.id,
          articleId: null,
          storyId: left.id,
          action: "merge_review_flag",
          reason: review.reason,
          detail: { otherStoryId: right.id },
        });
      }
    }
    endMerge({ errors: mergeProgress.errors, mergesApplied });

    const toScore = await listUnscoredStoryMembers(lookbackDays, MAX_MEMBER_SCORES_PER_RUN);
    const endMemberScoring = startPhase("member scoring", { articles: toScore.length, cap: MAX_MEMBER_SCORES_PER_RUN });
    let scoringCall = 0;
    const scoringUsage: Promise<void>[] = [];
    const memberScores = await runBatches(toScore, insertScores, {
      onUsage: (usage) => {
        countCall("member_scoring", "succeeded");
        scoringUsage.push(
          recordStoryRunUsage({
            runId: run.id,
            stage: "member_scoring",
            model: usage.model,
            callIndex: ++scoringCall,
            wallMs: 0,
            status: "succeeded",
            error: null,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          }).catch((error: unknown) => {
            logger.warn("member scoring usage not recorded", { error: error instanceof Error ? error.message : String(error) });
          }),
        );
      },
    }, setCleanText);
    await Promise.all(scoringUsage);
    endMemberScoring({ scored: memberScores.scores.length, failed: memberScores.failedArticleIds.length });

    const endAssessment = startPhase("assessment", { maxStories: MAX_ASSESSMENTS_PER_RUN });
    const assessed = await assessStories({
      days: lookbackDays,
      maxStories: MAX_ASSESSMENTS_PER_RUN,
      model: env.ASSESSMENT_MODEL ?? env.STORY_MODEL,
      onUsage: async (usage) => {
        countCall(usage.stage, usage.status);
        await recordStoryRunUsage({
          runId: run.id,
          stage: usage.stage,
          model: usage.model,
          callIndex: usage.callIndex,
          wallMs: usage.wallMs,
          status: usage.status,
          error: usage.error,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
        });
      },
    });
    endAssessment({
      assessed: assessed.assessedStoryIds.length,
      upToDate: assessed.skippedUpToDateStoryIds.length,
      skippedOverCap: assessed.skippedOverCapStoryIds.length,
      unassessable: assessed.flaggedUnassessableStoryIds.length,
      openedWithOutlet: assessed.flaggedOpeningWithOutletStoryIds.length,
    });

    const counts = countOutcomes([...outcomeByArticle.values()]);
    const finishedAt = now();
    const usageRows = await listStoryRunUsage(run.id);
    await finishStoryRun(run.id, { counts, usage: aggregateUsage(usageRows), sweepComplete });
    const reportInput = await loadCoverageReportInput(
      run.id,
      startedAt,
      finishedAt,
      counts,
      sweepComplete,
      usageRows,
    );
    await writeCoverageReport(buildCoverageReport(reportInput), coveragePath);
    logger.info("story ledger run done", {
      runId: run.id,
      counts,
      sweepComplete,
      coveragePath,
      elapsedMs: finishedAt.getTime() - startedAt.getTime(),
      usage: aggregateUsage(usageRows),
    });
    return { runId: run.id, counts, sweepComplete, coveragePath };

  } catch (error) {
    if (!(error instanceof FatalModelError)) throw error;
    // Close the run as aborted. Nothing is flagged: articles already placed
    // stay placed, and the rest stay unassigned for the next run.
    const usageRows = await listStoryRunUsage(run.id);
    await finishStoryRun(run.id, {
      counts: { ...countByCategory(outcomes), aborted: error.reason, abortedInPhase: currentPhase },
      usage: aggregateUsage(usageRows),
      sweepComplete: false,
    });
    logger.error("story ledger aborted", {
      runId: run.id,
      reason: error.reason,
      phase: currentPhase,
      placedBeforeAbort: outcomes.length,
      elapsedMs: now().getTime() - startedAt.getTime(),
      usage: aggregateUsage(usageRows),
      error: error.message,
    });
    throw error;
  }
}

async function main(): Promise<void> {
  await runStoryLedger();
  await shutdown();
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) main().catch((error) => crashAndShutdown("story ledger", error));
