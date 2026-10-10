import { pool } from "../db/client.js";
import {
  addStoryMember,
  appendStoryEvent,
  clearStoryArticleState,
  getStory,
  insertStory,
  listStoryMembers,
  removeStoryMember,
  setStoryArticleState,
  setStoryCard,
  setStoryAnchorIfUnset,
  setStoryStatus,
  type MemberConfidence,
  type Queryable,
} from "../db/repos/storiesRepo.js";
import type { StoryArticle } from "./retrieval.js";
import type { StoryDecision } from "./assignment.js";

export type OfferedCategory = "attached" | "new" | "flagged" | "not_news";

export interface AppliedArticleOutcome {
  articleId: number;
  category: OfferedCategory;
  storyIds: string[];
  seededStoryId: string | null;
}

export interface LedgerApplyResult {
  outcomes: AppliedArticleOutcome[];
  changedStoryIds: string[];
}

export function storyMemberKind(article: StoryArticle): "full" | "headline_only" | "syndicated" {
  if (article.syndicatedOfArticleId !== null) return "syndicated";
  // The scoring/admission floor is 200 words. A body below it exists privately
  // but is not enough to support a public excerpt or a telling assessment.
  if (article.extractionStatus === "failed" || article.wordCount < 200) return "headline_only";
  return "full";
}

async function inTransaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface StorySplitGroup {
  headline: string;
  eventStatement: string;
  articleIds: number[];
}

export async function applyStorySplit(
  runId: number,
  storyId: string,
  anchorArticleId: number,
  groups: readonly StorySplitGroup[],
  reason: string,
): Promise<string[]> {
  return inTransaction(async (db) => {
    const members = await listStoryMembers(storyId, db);
    const primary = members.filter((member) => member.role === "primary");
    const offered = [...primary.map((member) => member.articleId)].sort((a, b) => a - b);
    const partition = groups.flatMap((group) => group.articleIds).sort((a, b) => a - b);
    if (offered.length !== partition.length || offered.some((id, index) => id !== partition[index])) {
      throw new Error("split groups must partition every primary member exactly once");
    }
    const anchorGroups = groups.filter((group) => group.articleIds.includes(anchorArticleId));
    if (anchorGroups.length !== 1) throw new Error("split needs exactly one anchor group");
    await setStoryCard(
      storyId,
      { headline: anchorGroups[0]!.headline, eventStatement: anchorGroups[0]!.eventStatement },
      db,
    );
      const articleRows = await db.query<{ article_id: number; published_at: Date | null; fetched_at: Date | null }>(
        "SELECT id AS article_id, published_at, fetched_at FROM articles WHERE id = ANY($1)",
        [primary.map((member) => member.articleId)],
      );
    const firstSeenByArticle = new Map(
      articleRows.rows.map((row) => [row.article_id, row.published_at ?? row.fetched_at ?? new Date()]),
    );
      const created: string[] = [];
      for (const group of groups) {
        if (group === anchorGroups[0]) continue;
        const groupMembers = group.articleIds.map((id) => primary.find((member) => member.articleId === id)!);
        const story = await insertStory(
          {
            headline: group.headline,
            eventStatement: group.eventStatement,
            section: null,
            firstSeenAt: groupMembers.reduce<Date>((earliest, member) => {
              const date = firstSeenByArticle.get(member.articleId);
              if (!date) {
                throw new Error(`missing first-seen date for article ${member.articleId}`);
              }
              return date < earliest ? date : earliest;
            }, new Date()),
          },
          db,
        );
      created.push(story.id);
      for (const member of groupMembers) {
        await removeStoryMember(storyId, member.articleId, db);
        await addStoryMember(
          {
            storyId: story.id,
            articleId: member.articleId,
            role: member.role,
            kind: member.kind,
            syndicatedOfArticleId: member.syndicatedOfArticleId,
            confidence: member.confidence,
            reason,
            addedRunId: runId,
          },
          db,
        );
        await appendStoryEvent(
          {
            runId,
            articleId: member.articleId,
            storyId: story.id,
            action: "split_member",
            reason,
            detail: { from: storyId },
          },
          db,
        );
      }
    }
    return [storyId, ...created];
  });
}

function byArticle(articles: readonly StoryArticle[]): Map<number, StoryArticle> {
  const result = new Map<number, StoryArticle>();
  for (const article of articles) {
    if (result.has(article.id)) throw new Error(`article ${article.id} appears more than once`);
    result.set(article.id, article);
  }
  return result;
}

async function attach(
  db: Queryable,
  runId: number,
  article: StoryArticle,
  storyIds: readonly string[],
  role: "primary" | "secondary",
  reason: string,
  confidence: MemberConfidence,
  action: string,
): Promise<void> {
  for (const storyId of storyIds) {
    await addStoryMember(
      {
        storyId,
        articleId: article.id,
        role,
        kind: storyMemberKind(article),
        syndicatedOfArticleId: article.syndicatedOfArticleId,
        confidence,
        reason,
        addedRunId: runId,
      },
      db,
    );
    if (role === "primary") await setStoryAnchorIfUnset(storyId, article.id, db);
    await appendStoryEvent(
      { runId, articleId: article.id, storyId, action, reason, detail: { role } },
      db,
    );
  }
  await clearStoryArticleState(article.id, db);
}

export async function attachDeterministically(
  runId: number,
  article: StoryArticle,
  storyId: string,
): Promise<AppliedArticleOutcome> {
  await inTransaction((db) =>
    attach(db, runId, article, [storyId], "primary", "Deterministic syndicated or sister-feed match.", "high", "attach_deterministic"),
  );
  return { articleId: article.id, category: "attached", storyIds: [storyId], seededStoryId: null };
}

export async function applyStoryDecisions(
  runId: number,
  articles: readonly StoryArticle[],
  decisions: readonly StoryDecision[],
): Promise<LedgerApplyResult> {
  const articlesById = byArticle(articles);
  if (decisions.length !== articles.length) throw new Error("ledger needs exactly one decision per article");
  const seen = new Set<number>();
  for (const decision of decisions) {
    if (!articlesById.has(decision.articleId)) throw new Error(`decision names unoffered article ${decision.articleId}`);
    if (seen.has(decision.articleId)) throw new Error(`article ${decision.articleId} has duplicate decisions`);
    seen.add(decision.articleId);
  }

  const outcomes = new Map<number, AppliedArticleOutcome>();
  const changed = new Set<string>();

  for (const decision of decisions.filter((entry) => entry.action === "attach")) {
    const article = articlesById.get(decision.articleId)!;
    await inTransaction((db) =>
      attach(db, runId, article, decision.storyIds, decision.role, decision.reason, decision.confidence, "attach_model"),
    );
    decision.storyIds.forEach((id) => changed.add(id));
    outcomes.set(article.id, {
      articleId: article.id,
      category: "attached",
      storyIds: [...decision.storyIds],
      seededStoryId: null,
    });
  }

  // New decisions are resolved serially by key. Parallel model batches can
  // therefore propose the same new event without minting duplicate stories.
  const newGroups = new Map<string, Extract<StoryDecision, { action: "new" }>[]>();
  for (const decision of decisions) {
    if (decision.action !== "new") continue;
    const group = newGroups.get(decision.newStoryKey) ?? [];
    group.push(decision);
    newGroups.set(decision.newStoryKey, group);
  }
  for (const group of newGroups.values()) {
    await inTransaction(async (db) => {
      const first = group[0]!;
      const firstArticle = articlesById.get(first.articleId)!;
      const story = await insertStory(
        {
          headline: first.headline,
          eventStatement: first.eventStatement,
          section: firstArticle.section,
          firstSeenAt: firstArticle.publishedAt ?? firstArticle.fetchedAt,
        },
        db,
      );
      changed.add(story.id);
      for (const decision of group) {
        const article = articlesById.get(decision.articleId)!;
        await attach(
          db,
          runId,
          article,
          [story.id],
          "primary",
          decision.reason,
          decision.confidence,
          "new_story",
        );
        outcomes.set(article.id, {
          articleId: article.id,
          category: "new",
          storyIds: [story.id],
          seededStoryId: story.id,
        });
      }
    });
  }

  for (const decision of decisions) {
    if (decision.action !== "flag" && decision.action !== "not_news") continue;
    await inTransaction(async (db) => {
      const state = decision.action === "flag" ? "flag" : "not_news";
      await setStoryArticleState(decision.articleId, state, decision.reason, runId, db);
      await appendStoryEvent(
        { runId, articleId: decision.articleId, storyId: null, action: state, reason: decision.reason },
        db,
      );
    });
    outcomes.set(decision.articleId, {
      articleId: decision.articleId,
      category: decision.action === "flag" ? "flagged" : "not_news",
      storyIds: [],
      seededStoryId: null,
    });
  }

  return {
    outcomes: articles.map((article) => {
      const outcome = outcomes.get(article.id);
      if (!outcome) throw new Error(`article ${article.id} has no persisted outcome`);
      return outcome;
    }),
    changedStoryIds: [...changed],
  };
}

// Sweep decisions for a whole run are computed once against a single
// openCards snapshot, then applied one article at a time, and applying one
// decision can merge a story away. A later decision in the same run can
// still name that now-merged story as its target. Follow merged_into to the
// live survivor rather than handing a stale id to addStoryMember/
// setStoryStatus, which both refuse to touch an already-merged story.
async function resolveLiveStoryId(db: Queryable, storyId: string): Promise<string> {
  let current = storyId;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) throw new Error(`story merge chain cycle detected at ${current}`);
    seen.add(current);
    const story = await getStory(current, db);
    if (!story) throw new Error(`story ${current} does not exist`);
    if (story.status !== "merged" || !story.mergedInto) return current;
    current = story.mergedInto;
  }
}

export async function applySweepAttachment(
  runId: number,
  article: StoryArticle,
  storyIds: readonly string[],
  role: "primary" | "secondary",
  reason: string,
  seededStoryId: string | null,
): Promise<string[]> {
  if (role === "primary" && storyIds.length !== 1) throw new Error("a primary sweep attachment needs one story");
  if (storyIds.length === 0) throw new Error("a sweep attachment needs at least one story");
  return inTransaction(async (db) => {
    const resolved = new Set<string>();
    for (const storyId of storyIds) resolved.add(await resolveLiveStoryId(db, storyId));
    const liveStoryIds = [...resolved];

    if (seededStoryId && !liveStoryIds.includes(seededStoryId)) {
      await removeStoryMember(seededStoryId, article.id, db);
    }
    await attach(db, runId, article, liveStoryIds, role, reason, "high", "sweep_attach");
    if (seededStoryId && !liveStoryIds.includes(seededStoryId)) {
      const left = await listStoryMembers(seededStoryId, db);
      if (left.length === 0) {
        await setStoryStatus(seededStoryId, "merged", liveStoryIds[0]!, db);
        await appendStoryEvent(
          {
            runId,
            articleId: article.id,
            storyId: seededStoryId,
            action: "merge_empty_singleton",
            reason: "Exhaustive sweep found the older same-event story.",
            detail: { mergedInto: liveStoryIds[0] },
          },
          db,
        );
      }
    }
    return [...liveStoryIds, ...(seededStoryId ? [seededStoryId] : [])];
  });
}

// Applies one merge the critic approved. Merge reviews run in parallel
// against one snapshot of open stories and are applied afterwards, one at a
// time (2026-09-22), so by the time a "yes" for A-C is applied, an earlier
// A-B may already have merged A away. Both sides are followed to their live
// survivor first; if they already ended up in the same story, there is
// nothing left to do. The earlier-seen story survives, ties broken by id,
// the same rule the serial loop used.
export async function mergeReviewedPair(
  runId: number,
  leftStoryId: string,
  rightStoryId: string,
  reason: string,
): Promise<{ merged: boolean; survivorId: string }> {
  const [liveLeftId, liveRightId] = await Promise.all([
    resolveLiveStoryId(pool, leftStoryId),
    resolveLiveStoryId(pool, rightStoryId),
  ]);
  if (liveLeftId === liveRightId) return { merged: false, survivorId: liveLeftId };
  const [left, right] = await Promise.all([getStory(liveLeftId, pool), getStory(liveRightId, pool)]);
  if (!left || !right) throw new Error(`merge target vanished: ${liveLeftId} / ${liveRightId}`);
  const leftWins = left.firstSeenAt < right.firstSeenAt
    || (left.firstSeenAt.getTime() === right.firstSeenAt.getTime() && left.id < right.id);
  const survivor = leftWins ? left : right;
  const absorbed = leftWins ? right : left;
  await mergeStoryInto(runId, absorbed.id, survivor.id, reason);
  return { merged: true, survivorId: survivor.id };
}

export async function mergeStoryInto(
  runId: number,
  absorbedStoryId: string,
  survivorStoryId: string,
  reason: string,
): Promise<void> {
  if (absorbedStoryId === survivorStoryId) throw new Error("a story cannot merge into itself");
  await inTransaction(async (db) => {
    const moved = await listStoryMembers(absorbedStoryId, db);
    for (const member of moved) await removeStoryMember(absorbedStoryId, member.articleId, db);
    for (const member of moved) {
      await addStoryMember(
        {
          storyId: survivorStoryId,
          articleId: member.articleId,
          role: member.role,
          kind: member.kind,
          syndicatedOfArticleId: member.syndicatedOfArticleId,
          confidence: member.confidence,
          reason,
          addedRunId: runId,
        },
        db,
      );
      await appendStoryEvent(
        {
          runId,
          articleId: member.articleId,
          storyId: survivorStoryId,
          action: "merge_member",
          reason,
          detail: { from: absorbedStoryId },
        },
        db,
      );
    }
    await setStoryStatus(absorbedStoryId, "merged", survivorStoryId, db);
    await appendStoryEvent(
      {
        runId,
        articleId: null,
        storyId: absorbedStoryId,
        action: "merge_story",
        reason,
        detail: { mergedInto: survivorStoryId },
      },
      db,
    );
  });
}
