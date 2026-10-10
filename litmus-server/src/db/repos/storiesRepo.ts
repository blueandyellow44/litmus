// The Story Ledger's persistence: stories, their members, the runs that change
// them and the sweep record. Schema in migrations/0001_story_ledger.up.sql.
//
// Unlike clustersRepo's replaceAllClusters, nothing here wipes and rewrites. A
// run inserts stories and members and moves status, so a story's id survives
// every later run. Every writer takes an optional client so the story stage can
// group its writes in one transaction.
//
// Where a merge redirect lives (decided 2026-09-13, recorded in the plan's
// Contract section): on stories.merged_into, and nowhere else. The audit
// sketched a separate story_redirects table for the same fact; two homes for
// one pointer can disagree, and the column is the one an applied migration has
// already committed to. Later phases add no story_redirects table.

import type pg from "pg";
import { pool } from "../client.js";
import type { StoryMemberKind } from "../../api/storyTypes.js";
import {
  membershipHash,
  mintStoryId,
  storySlug,
  type StoryMemberRole,
} from "../../stories/identity.js";

export type { StoryMemberRole } from "../../stories/identity.js";
export type StoryStatus = "open" | "dormant" | "merged";
export type MemberConfidence = "high" | "medium" | "low";

// Both the pool and a checked-out client (inside a transaction) satisfy this.
export type Queryable = Pick<pg.ClientBase, "query">;

// ─────────────────────────────────────────────────────────────────────
// Runs
// ─────────────────────────────────────────────────────────────────────

export interface StoryRunRecord {
  id: number;
  startedAt: Date;
  finishedAt: Date | null;
  counts: Record<string, unknown>;
  sweepComplete: boolean;
  usage: Record<string, unknown>;
}

interface StoryRunRow {
  id: string; // BIGSERIAL arrives from pg as a string
  started_at: Date;
  finished_at: Date | null;
  counts: Record<string, unknown>;
  sweep_complete: boolean;
  usage: Record<string, unknown>;
}

// pg returns BIGINT as a string so it never loses precision. A run id past 2^53
// is not a real case, but reading one as a rounded number would silently point
// at a different run, so it is refused instead.
function toRunId(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`story run id ${raw} is not a safe positive integer`);
  return n;
}

function rowToRun(r: StoryRunRow): StoryRunRecord {
  return {
    id: toRunId(r.id),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    counts: r.counts,
    sweepComplete: r.sweep_complete,
    usage: r.usage,
  };
}

export async function startStoryRun(db: Queryable = pool): Promise<StoryRunRecord> {
  const { rows } = await db.query<StoryRunRow>("INSERT INTO story_runs DEFAULT VALUES RETURNING *");
  return rowToRun(rows[0]!);
}

export interface StoryRunOutcome {
  counts: Record<string, unknown>;
  usage: Record<string, unknown>;
  sweepComplete: boolean;
}

// A run is finished exactly once. Finishing it twice would overwrite the first
// record of what it did, so a second call throws.
export async function finishStoryRun(
  runId: number,
  outcome: StoryRunOutcome,
  db: Queryable = pool,
): Promise<StoryRunRecord> {
  const { rows } = await db.query<StoryRunRow>(
    `UPDATE story_runs
     SET finished_at = NOW(), counts = $2::jsonb, usage = $3::jsonb, sweep_complete = $4
     WHERE id = $1 AND finished_at IS NULL
     RETURNING *`,
    [runId, JSON.stringify(outcome.counts), JSON.stringify(outcome.usage), outcome.sweepComplete],
  );
  if (rows.length === 0) {
    throw new Error(`story run ${runId} does not exist or has already finished`);
  }
  return rowToRun(rows[0]!);
}

export async function getStoryRun(runId: number, db: Queryable = pool): Promise<StoryRunRecord | null> {
  const { rows } = await db.query<StoryRunRow>("SELECT * FROM story_runs WHERE id = $1", [runId]);
  return rows[0] ? rowToRun(rows[0]) : null;
}

// ─────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────

export interface StoryAssessmentRecord {
  text: string;
  model: string;
  generatedAt: Date;
}

export interface StoryRecord {
  id: string;
  slug: string;
  section: string | null;
  headline: string;
  eventStatement: string;
  assessment: StoryAssessmentRecord | null;
  membershipHash: string | null;
  // Political Wire scope, judged with the assessment (2026-09-26); null until judged.
  touchesPolitics: boolean | null;
  firstSeenAt: Date;
  updatedAt: Date;
  status: StoryStatus;
  mergedInto: string | null;
  anchorArticleId: number | null;
}

interface StoryRow {
  id: string;
  slug: string;
  section: string | null;
  headline: string;
  event_statement: string;
  assessment_text: string | null;
  assessment_model: string | null;
  assessment_generated_at: Date | null;
  membership_hash: string | null;
  touches_politics: boolean | null;
  first_seen_at: Date;
  updated_at: Date;
  status: StoryStatus;
  merged_into: string | null;
  anchor_article_id: number | null;
}

function rowToStory(r: StoryRow): StoryRecord {
  // The stories_assessment_complete constraint guarantees all three or none.
  const assessment =
    r.assessment_text !== null && r.assessment_model !== null && r.assessment_generated_at !== null
      ? { text: r.assessment_text, model: r.assessment_model, generatedAt: r.assessment_generated_at }
      : null;
  return {
    id: r.id,
    slug: r.slug,
    section: r.section,
    headline: r.headline,
    eventStatement: r.event_statement,
    assessment,
    membershipHash: r.membership_hash,
    touchesPolitics: r.touches_politics ?? null,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
    status: r.status,
    mergedInto: r.merged_into,
    anchorArticleId: r.anchor_article_id,
  };
}

export interface NewStory {
  headline: string;
  eventStatement: string;
  section: string | null;
  // When the event was first seen, if earlier than now (a bootstrap run over
  // older articles). Defaults to now.
  firstSeenAt?: Date;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${field} must not be empty`);
  return trimmed;
}

// Mints the id and the slug here, once. Neither is ever regenerated: a later
// headline rewrite changes the headline, not the address.
export async function insertStory(story: NewStory, db: Queryable = pool): Promise<StoryRecord> {
  const headline = requireText(story.headline, "story headline");
  const eventStatement = requireText(story.eventStatement, "story event statement");
  const id = mintStoryId();
  const slug = storySlug(headline, id);
  const { rows } = await db.query<StoryRow>(
    `INSERT INTO stories (id, slug, section, headline, event_statement, first_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()), NOW())
     RETURNING *`,
    [id, slug, story.section, headline, eventStatement, story.firstSeenAt ?? null],
  );
  return rowToStory(rows[0]!);
}

export async function getStory(id: string, db: Queryable = pool): Promise<StoryRecord | null> {
  const { rows } = await db.query<StoryRow>("SELECT * FROM stories WHERE id = $1", [id]);
  return rows[0] ? rowToStory(rows[0]) : null;
}

export async function getStoryBySlug(slug: string, db: Queryable = pool): Promise<StoryRecord | null> {
  const { rows } = await db.query<StoryRow>("SELECT * FROM stories WHERE slug = $1", [slug]);
  return rows[0] ? rowToStory(rows[0]) : null;
}

export async function setStoryCard(
  storyId: string,
  card: { headline: string; eventStatement: string; section?: string | null },
  db: Queryable = pool,
): Promise<StoryRecord> {
  const headline = requireText(card.headline, "story headline");
  const eventStatement = requireText(card.eventStatement, "story event statement");
  const { rows } = await db.query<StoryRow>(
    `UPDATE stories
     SET headline = $2, event_statement = $3,
         section = CASE WHEN $4::boolean THEN $5::text ELSE section END
     WHERE id = $1 AND status <> 'merged'
     RETURNING *`,
    [storyId, headline, eventStatement, Object.prototype.hasOwnProperty.call(card, "section"), card.section ?? null],
  );
  if (rows.length === 0) throw new Error(`story ${storyId} does not exist or has been merged`);
  return rowToStory(rows[0]!);
}

export async function setStoryAnchorIfUnset(
  storyId: string,
  articleId: number,
  db: Queryable = pool,
): Promise<number> {
  const { rows } = await db.query<{ anchor_article_id: number }>(
    `UPDATE stories st
     SET anchor_article_id = $2
     WHERE st.id = $1 AND st.status <> 'merged' AND st.anchor_article_id IS NULL
       AND EXISTS (
         SELECT 1 FROM story_members sm
         WHERE sm.story_id = st.id AND sm.article_id = $2 AND sm.role = 'primary'
       )
     RETURNING anchor_article_id`,
    [storyId, articleId],
  );
  if (rows[0]) return rows[0].anchor_article_id;
  const story = await getStory(storyId, db);
  if (!story?.anchorArticleId) throw new Error(`story ${storyId} has no primary anchor member ${articleId}`);
  return story.anchorArticleId;
}

// Stories that can still take members: not merged, and touched since `since`.
// Newest first.
export async function listStoriesUpdatedSince(since: Date, db: Queryable = pool): Promise<StoryRecord[]> {
  const { rows } = await db.query<StoryRow>(
    `SELECT * FROM stories
     WHERE status <> 'merged' AND updated_at >= $1
     ORDER BY updated_at DESC, id`,
    [since],
  );
  return rows.map(rowToStory);
}

export interface StoryAssessmentWrite {
  text: string;
  model: string;
  generatedAt: Date;
  membershipHash: string;
  touchesPolitics: boolean;
}

// Records the assessment together with the membership it was written for, so
// the assessment stage can tell a current assessment from a stale one. A merged
// story is never assessed; its readers are sent to the survivor.
export async function setStoryAssessment(
  storyId: string,
  a: StoryAssessmentWrite,
  db: Queryable = pool,
): Promise<StoryRecord> {
  const text = requireText(a.text, "assessment text");
  const model = requireText(a.model, "assessment model");
  const hash = requireText(a.membershipHash, "membership hash");
  const { rows } = await db.query<StoryRow>(
    `UPDATE stories
     SET assessment_text = $2, assessment_model = $3, assessment_generated_at = $4, membership_hash = $5,
         touches_politics = $6
     WHERE id = $1 AND status <> 'merged'
     RETURNING *`,
    [storyId, text, model, a.generatedAt, hash, a.touchesPolitics],
  );
  if (rows.length === 0) throw new Error(`story ${storyId} does not exist or has been merged`);
  return rowToStory(rows[0]!);
}

// open <-> dormant, or merged into a live story.
//
// A redirect is always exactly one hop, and it takes two guards to keep that
// true, not one. Refusing to merge INTO an already-merged story only closes
// half the door: A -> B is legal while B is open, and nothing stopped B -> C
// afterwards, which left A pointing at a story that had itself been emptied and
// redirected. So merging B into C also re-points everyone already pointing at B.
// Both happen in one statement, so a reader can never observe the half-done
// state, whether the caller passed the pool or a transaction client.
export async function setStoryStatus(
  storyId: string,
  status: StoryStatus,
  mergedInto: string | null = null,
  db: Queryable = pool,
): Promise<StoryRecord> {
  if (status === "merged" && mergedInto === null) {
    throw new Error(`merging story ${storyId} needs the id of the story it merges into`);
  }
  if (status !== "merged" && mergedInto !== null) {
    throw new Error(`story ${storyId} can only point at another story when it is merged`);
  }
  if (mergedInto === storyId) throw new Error(`story ${storyId} cannot merge into itself`);

  // The re-point is safe to write as a sibling CTE because the two UPDATEs can
  // never touch the same row: stories_not_merged_into_self means no row has
  // merged_into = its own id, so $1 is not in the re-pointed set. And the new
  // target is never merged, so re-pointing cannot build a cycle.
  const { rows } = await db.query<StoryRow>(
    `WITH moved AS (
       UPDATE stories s
       SET status = $2, merged_into = $3
       WHERE s.id = $1
         AND s.status <> 'merged'
         AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM stories t WHERE t.id = $3 AND t.status <> 'merged'))
       RETURNING s.*
     ),
     repointed AS (
       UPDATE stories r
       SET merged_into = $3
       WHERE $3::text IS NOT NULL
         AND r.merged_into = $1
         AND EXISTS (SELECT 1 FROM moved)
       RETURNING r.id
     )
     SELECT * FROM moved`,
    [storyId, status, mergedInto],
  );
  if (rows.length === 0) {
    throw new Error(
      `cannot set story ${storyId} to ${status}: it does not exist, is already merged` +
        (mergedInto ? `, or its target ${mergedInto} does not exist or is itself merged` : ""),
    );
  }
  return rowToStory(rows[0]!);
}

// ─────────────────────────────────────────────────────────────────────
// Members
// ─────────────────────────────────────────────────────────────────────

export interface StoryMemberRecord {
  storyId: string;
  articleId: number;
  role: StoryMemberRole;
  kind: StoryMemberKind;
  syndicatedOfArticleId: number | null;
  confidence: MemberConfidence;
  reason: string;
  addedRunId: number | null;
  addedAt: Date;
}

interface StoryMemberRow {
  story_id: string;
  article_id: number;
  role: StoryMemberRole;
  kind: StoryMemberKind;
  syndicated_of_article_id: number | null;
  confidence: MemberConfidence;
  reason: string;
  added_run_id: string | null;
  added_at: Date;
}

function rowToMember(r: StoryMemberRow): StoryMemberRecord {
  return {
    storyId: r.story_id,
    articleId: r.article_id,
    role: r.role,
    kind: r.kind,
    syndicatedOfArticleId: r.syndicated_of_article_id,
    confidence: r.confidence,
    reason: r.reason,
    addedRunId: r.added_run_id === null ? null : toRunId(r.added_run_id),
    addedAt: r.added_at,
  };
}

export interface NewStoryMember {
  storyId: string;
  articleId: number;
  role: StoryMemberRole;
  kind: StoryMemberKind;
  syndicatedOfArticleId: number | null;
  confidence: MemberConfidence;
  reason: string;
  addedRunId: number | null;
}

export interface MemberWriteResult {
  member: StoryMemberRecord;
  // False when the article was already in this story and only its role, kind,
  // confidence or reason changed.
  inserted: boolean;
}

// Adds an article to a story, or updates how it belongs if it is already there.
// Only a genuine addition moves the story's updated_at, because dormancy means
// "no NEW member for 7 days"; re-affirming a member every run would keep a dead
// story open forever. The original added_run_id and added_at are kept on update.
//
// Refused by the database, and surfaced as its error: an article that is already
// primary in another story being made primary here (story_members_one_primary_story).
export async function addStoryMember(m: NewStoryMember, db: Queryable = pool): Promise<MemberWriteResult> {
  const reason = requireText(m.reason, "member reason");
  if (m.kind === "syndicated" && m.syndicatedOfArticleId === null) {
    throw new Error(`article ${m.articleId} is marked syndicated but names no original`);
  }
  if (m.kind !== "syndicated" && m.syndicatedOfArticleId !== null) {
    throw new Error(`article ${m.articleId} names an original but is not marked syndicated`);
  }
  if (m.syndicatedOfArticleId === m.articleId) {
    throw new Error(`article ${m.articleId} cannot be a syndicated copy of itself`);
  }

  const { rows } = await db.query<StoryMemberRow & { inserted: boolean }>(
    `WITH target AS (
       SELECT id FROM stories WHERE id = $1 AND status <> 'merged'
     ),
     upserted AS (
       INSERT INTO story_members
         (story_id, article_id, role, kind, syndicated_of_article_id, confidence, reason, added_run_id)
       SELECT target.id, $2, $3, $4, $5, $6, $7, $8 FROM target
       ON CONFLICT (story_id, article_id) DO UPDATE SET
         role = EXCLUDED.role,
         kind = EXCLUDED.kind,
         syndicated_of_article_id = EXCLUDED.syndicated_of_article_id,
         confidence = EXCLUDED.confidence,
         reason = EXCLUDED.reason
       RETURNING *, (xmax = 0) AS inserted
     ),
     touched AS (
       UPDATE stories SET updated_at = NOW(), status = 'open'
       WHERE id = $1 AND EXISTS (SELECT 1 FROM upserted WHERE inserted)
       RETURNING id
     )
     SELECT * FROM upserted`,
    [m.storyId, m.articleId, m.role, m.kind, m.syndicatedOfArticleId, m.confidence, reason, m.addedRunId],
  );
  if (rows.length === 0) {
    throw new Error(`story ${m.storyId} does not exist or has been merged; attach to the story it merged into`);
  }
  const row = rows[0]!;
  return { member: rowToMember(row), inserted: row.inserted };
}

// Evicts an article from a story. Returns false when it was not a member.
// updated_at is left alone: an eviction is not a new member, and the membership
// hash already tells the assessment stage the story changed.
export async function removeStoryMember(storyId: string, articleId: number, db: Queryable = pool): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM story_members WHERE story_id = $1 AND article_id = $2", [
    storyId,
    articleId,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function listStoryMembers(storyId: string, db: Queryable = pool): Promise<StoryMemberRecord[]> {
  const { rows } = await db.query<StoryMemberRow>(
    `SELECT * FROM story_members WHERE story_id = $1 ORDER BY added_at, article_id`,
    [storyId],
  );
  return rows.map(rowToMember);
}

// The fingerprint of the story's live membership, or null when it has no
// members. Compare with StoryRecord.membershipHash to decide whether the
// assessment is stale.
export async function currentMembershipHash(storyId: string, db: Queryable = pool): Promise<string | null> {
  const members = await listStoryMembers(storyId, db);
  if (members.length === 0) return null;
  return membershipHash(members);
}

// Stories carrying an assessment with no members left. Deleting an article
// cascades its story_members rows away; the assessment it helped produce stays.
// currentMembershipHash then returns null forever, so it can never DISAGREE
// with the stored hash, and staleness-by-comparison cannot see this state at
// all. That is why it gets its own query: the S6 publish gate refuses these
// stories, and the assessment stage reads a null live hash as "unassessable"
// rather than "unchanged".
export async function listAssessedStoriesWithoutMembers(db: Queryable = pool): Promise<StoryRecord[]> {
  const { rows } = await db.query<StoryRow>(
    `SELECT s.* FROM stories s
     WHERE s.assessment_text IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM story_members m WHERE m.story_id = s.id)
     ORDER BY s.id`,
  );
  return rows.map(rowToStory);
}

// ─────────────────────────────────────────────────────────────────────
// Sweep record
// ─────────────────────────────────────────────────────────────────────

export interface ArticleSweepWrite {
  runId: number;
  articleId: number;
  shard: number;
  storiesChecked: number;
}

// Idempotent per (run, article, shard): a retried shard overwrites its own row
// rather than double-counting the stories it checked.
export async function recordArticleSweep(s: ArticleSweepWrite, db: Queryable = pool): Promise<void> {
  if (!Number.isInteger(s.shard) || s.shard < 0) throw new Error(`sweep shard ${s.shard} must be a non-negative integer`);
  if (!Number.isInteger(s.storiesChecked) || s.storiesChecked < 0) {
    throw new Error(`stories checked ${s.storiesChecked} must be a non-negative integer`);
  }
  await db.query(
    `INSERT INTO article_sweeps (run_id, article_id, shard, stories_checked)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (run_id, article_id, shard) DO UPDATE SET
       stories_checked = EXCLUDED.stories_checked,
       checked_at = NOW()`,
    [s.runId, s.articleId, s.shard, s.storiesChecked],
  );
}

// The articles, of those given, that this run did NOT check against at least
// `requiredStoriesChecked` open stories, including those with no sweep row at
// all. An empty result is what lets a run set sweep_complete. Sorted ascending.
export async function listIncompletelySweptArticleIds(
  runId: number,
  articleIds: readonly number[],
  requiredStoriesChecked: number,
  db: Queryable = pool,
): Promise<number[]> {
  if (!Number.isInteger(requiredStoriesChecked) || requiredStoriesChecked < 0) {
    throw new Error(`required stories checked ${requiredStoriesChecked} must be a non-negative integer`);
  }
  if (articleIds.length === 0) return [];
  const { rows } = await db.query<{ article_id: number }>(
    `SELECT a.article_id
     FROM unnest($2::int[]) AS a(article_id)
     LEFT JOIN article_sweeps s ON s.run_id = $1 AND s.article_id = a.article_id
     GROUP BY a.article_id
     HAVING COALESCE(SUM(s.stories_checked), 0) < $3
     ORDER BY a.article_id`,
    [runId, [...new Set(articleIds)], requiredStoriesChecked],
  );
  return rows.map((r) => r.article_id);
}

// ─────────────────────────────────────────────────────────────────────
// Durable run evidence
// ─────────────────────────────────────────────────────────────────────

export type StoryArticleState = "flag" | "not_news";

export interface StoryArticleStateRecord {
  articleId: number;
  state: StoryArticleState;
  reason: string;
  runId: number | null;
  updatedAt: Date;
}

interface StoryArticleStateRow {
  article_id: number;
  state: StoryArticleState;
  reason: string;
  run_id: string | null;
  updated_at: Date;
}

function rowToArticleState(row: StoryArticleStateRow): StoryArticleStateRecord {
  return {
    articleId: row.article_id,
    state: row.state,
    reason: row.reason,
    runId: row.run_id === null ? null : toRunId(row.run_id),
    updatedAt: row.updated_at,
  };
}

export async function setStoryArticleState(
  articleId: number,
  state: StoryArticleState,
  reason: string,
  runId: number | null,
  db: Queryable = pool,
): Promise<StoryArticleStateRecord> {
  if (!Number.isSafeInteger(articleId) || articleId <= 0) throw new Error("article id must be a positive integer");
  const safeReason = requireText(reason, "article state reason");
  const { rows } = await db.query<StoryArticleStateRow>(
    `INSERT INTO story_article_states (article_id, state, reason, run_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (article_id) DO UPDATE SET
       state = EXCLUDED.state, reason = EXCLUDED.reason, run_id = EXCLUDED.run_id, updated_at = NOW()
     RETURNING *`,
    [articleId, state, safeReason, runId],
  );
  return rowToArticleState(rows[0]!);
}

export async function clearStoryArticleState(articleId: number, db: Queryable = pool): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM story_article_states WHERE article_id = $1", [articleId]);
  return (rowCount ?? 0) > 0;
}

export async function getStoryArticleState(
  articleId: number,
  db: Queryable = pool,
): Promise<StoryArticleStateRecord | null> {
  const { rows } = await db.query<StoryArticleStateRow>(
    "SELECT * FROM story_article_states WHERE article_id = $1",
    [articleId],
  );
  return rows[0] ? rowToArticleState(rows[0]) : null;
}

export interface StoryEventWrite {
  runId: number | null;
  articleId: number | null;
  storyId: string | null;
  action: string;
  reason: string;
  detail?: Record<string, unknown>;
}

export async function appendStoryEvent(event: StoryEventWrite, db: Queryable = pool): Promise<number> {
  const action = requireText(event.action, "story event action");
  const reason = requireText(event.reason, "story event reason");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO story_events_log (run_id, article_id, story_id, action, reason, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id::text`,
    [event.runId, event.articleId, event.storyId, action, reason, JSON.stringify(event.detail ?? {})],
  );
  return toRunId(rows[0]!.id);
}

export type StorySweepOutcome = "excluded" | "match" | "uncertain";

export interface StorySweepCheckWrite {
  runId: number;
  articleId: number;
  storyId: string;
  outcome: StorySweepOutcome;
  reason: string;
}

export interface StorySweepCheckRecord extends StorySweepCheckWrite {
  checkedAt: Date;
}

interface StorySweepCheckRow {
  run_id: string;
  article_id: number;
  story_id: string;
  outcome: StorySweepOutcome;
  reason: string;
  checked_at: Date;
}

function rowToSweepCheck(row: StorySweepCheckRow): StorySweepCheckRecord {
  return {
    runId: toRunId(row.run_id),
    articleId: row.article_id,
    storyId: row.story_id,
    outcome: row.outcome,
    reason: row.reason,
    checkedAt: row.checked_at,
  };
}

export async function recordStorySweepCheck(check: StorySweepCheckWrite, db: Queryable = pool): Promise<void> {
  const reason = requireText(check.reason, "sweep check reason");
  await db.query(
    `INSERT INTO story_sweep_checks (run_id, article_id, story_id, outcome, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (run_id, article_id, story_id) DO UPDATE SET
       outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, checked_at = NOW()`,
    [check.runId, check.articleId, check.storyId, check.outcome, reason],
  );
}

export async function recordStorySweepChecks(
  checks: readonly StorySweepCheckWrite[],
  db: Queryable = pool,
): Promise<void> {
  if (checks.length === 0) return;
  for (const check of checks) requireText(check.reason, "sweep check reason");
  await db.query(
    `INSERT INTO story_sweep_checks (run_id, article_id, story_id, outcome, reason)
     SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[], $4::text[], $5::text[])
     ON CONFLICT (run_id, article_id, story_id) DO UPDATE SET
       outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, checked_at = NOW()`,
    [
      checks.map((check) => check.runId),
      checks.map((check) => check.articleId),
      checks.map((check) => check.storyId),
      checks.map((check) => check.outcome),
      checks.map((check) => check.reason),
    ],
  );
}

export async function listStorySweepChecks(
  runId: number,
  storyId: string | null = null,
  db: Queryable = pool,
): Promise<StorySweepCheckRecord[]> {
  const { rows } = await db.query<StorySweepCheckRow>(
    `SELECT * FROM story_sweep_checks
     WHERE run_id = $1 AND ($2::text IS NULL OR story_id = $2)
     ORDER BY article_id, story_id`,
    [runId, storyId],
  );
  return rows.map(rowToSweepCheck);
}

export interface StoryRunUsageWrite {
  runId: number;
  stage: string;
  callIndex: number;
  model: string;
  status: "succeeded" | "failed";
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  wallMs: number;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

export async function recordStoryRunUsage(usage: StoryRunUsageWrite, db: Queryable = pool): Promise<void> {
  if (!Number.isSafeInteger(usage.callIndex) || usage.callIndex <= 0) {
    throw new Error("usage call index must be a positive integer");
  }
  const stage = requireText(usage.stage, "usage stage");
  const model = requireText(usage.model, "usage model");
  await db.query(
    `INSERT INTO story_run_usage
       (run_id, stage, call_index, model, status, error, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, wall_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (run_id, stage, call_index) DO UPDATE SET
       model = EXCLUDED.model,
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       input_tokens = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens,
       cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
       cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
       wall_ms = EXCLUDED.wall_ms`,
    [
      usage.runId,
      stage,
      usage.callIndex,
      model,
      usage.status,
      usage.status === "failed" ? requireText(usage.error ?? "", "usage error") : null,
      requireNonNegativeInteger(usage.inputTokens, "input tokens"),
      requireNonNegativeInteger(usage.outputTokens, "output tokens"),
      requireNonNegativeInteger(usage.cacheCreationInputTokens, "cache creation tokens"),
      requireNonNegativeInteger(usage.cacheReadInputTokens, "cache read tokens"),
      requireNonNegativeInteger(usage.wallMs, "usage wall time"),
    ],
  );
}

export async function listStoryRunUsage(runId: number, db: Queryable = pool): Promise<StoryRunUsageWrite[]> {
  const { rows } = await db.query<{
    run_id: string;
    stage: string;
    call_index: number;
    model: string;
    status: "succeeded" | "failed";
    error: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    wall_ms: number;
  }>("SELECT * FROM story_run_usage WHERE run_id = $1 ORDER BY stage, call_index", [runId]);
  return rows.map((row) => ({
    runId: toRunId(row.run_id),
    stage: row.stage,
    callIndex: row.call_index,
    model: row.model,
    status: row.status,
    error: row.error,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    wallMs: row.wall_ms,
  }));
}
