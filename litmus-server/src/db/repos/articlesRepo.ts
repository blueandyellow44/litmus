import { pool } from "../client.js";
import type { Article, NewArticle, Register } from "../../types.js";
import type { ArticleSummaryDTO, ArticleDetailDTO, ScoreDTO, TranslationDTO, ArticleExcerptDTO } from "../../api/types.js";
import type { Label, PHMarker } from "../../scoring/calibration.js";
import type { DimensionRationale } from "../../scoring/phScorer.js";
import { splitParagraphs, buildExcerptWindow } from "../../lib/paragraphs.js";
import { outletKeyFromName } from "../../ingestion/outletKey.js";
import type { ContentHashMatch, HeadlineUpgrade } from "../../ingestion/articleRow.js";

// Minimum body length for an article to be eligible for the paper. Ingest keeps
// stubs (a feed snippet from a page that blocked extraction) and, since S2,
// headline-only rows (no text at all) because they are a real signal that an
// outlet covered a story — but a 40-word stub has no body to excerpt, no prose
// to highlight, and cannot be translated. Publishing one beside a 750-word
// report makes the paper look broken. Nothing filtered on length before this,
// so stubs were eligible to be clustered and featured. They stay in the table
// as story members; they are not edition material as articles. They are never
// retried: the re-extraction worker was removed in 17afa2b.
// Matches MIN_FULL_WORDS in the extractor and the paywall "partial" cutoff.
const MIN_EDITION_WORDS = 200;

// Two windows, because "old" and "irrelevant" are not the same thing.
//
// Everything is fetched TODAY, so filtering the edition on fetched_at let a
// story published in June be printed as today's news: feeds like The Economist's
// weekly roundups serve months-old items, and 441 of 1,061 eligible articles
// were 2-7 days old with another 120 over a week old. Publication date is the
// only honest measure of whether something is current.
//
// But a straight cutoff is wrong too. A magazine analysis piece from last week
// that bears on a story running today belongs in the paper — that is how a real
// paper works, reporting beside longer-form context. So:
//
//   FRESH  — genuinely current news. Every printed story must contain at least
//            one of these, which is what makes the cluster a CURRENT story.
//   CONTEXT — older pieces still in play. They ride along only when they cluster
//            with fresh reporting; a cluster of nothing but context is dropped
//            in clusterCron. Also the hard floor on what is worth scoring at
//            all, so a January cartoon never costs a model call.
export const FRESH_WINDOW_HOURS = 48;
export const CONTEXT_WINDOW_DAYS = 14;

// How far back the scorer reaches for unscored articles. One day, matching the
// once-a-day edition, and deliberately narrower than CONTEXT_WINDOW_DAYS.
// Max, 2026-09-22: "do not worry about draining backlog. start fresh." Runs
// that failed (the usage-limit lockout, timeouts) leave unscored articles
// behind; with a 14-day reach every later run spent its 40-article budget
// catching up on those instead of scoring the day's news. Now they simply
// age out, the same reset the Story Ledger got (stories/lookbackLimit.ts).
export const SCORE_WINDOW_HOURS = 24;

interface ArticleRow {
  id: number;
  source_id: number;
  url: string;
  title: string;
  author: string | null;
  published_at: Date | null;
  raw_text: string;
  // Migration 0006: the story text after the furniture filter, or null when the
  // article was never filtered. Undefined on a database that predates 0006.
  clean_text?: string | null;
  word_count: number;
  extraction_status: Article["extractionStatus"];
  paywall_flag: boolean;
  content_hash: string;
  extracted_via: Article["extractedVia"];
  syndicated_of_article_id: number | null;
  fetched_at: Date;
}

function rowToArticle(r: ArticleRow): Article {
  return {
    id: r.id,
    sourceId: r.source_id,
    url: r.url,
    title: r.title,
    author: r.author,
    publishedAt: r.published_at,
    // Every reader sees the filtered story text when there is one; raw_text is
    // never modified (migration 0006), so the original is always recoverable.
    rawText: r.clean_text ?? r.raw_text,
    cleaned: r.clean_text != null,
    wordCount: r.word_count,
    extractionStatus: r.extraction_status,
    paywallFlag: r.paywall_flag,
    contentHash: r.content_hash,
    extractedVia: r.extracted_via,
    syndicatedOfArticleId: r.syndicated_of_article_id,
    fetchedAt: r.fetched_at,
    // Present only on queries that join sources (listUnscoredArticles).
    sourceRegister: (r as ArticleRow & { source_register?: Register | null }).source_register ?? null,
  };
}

// The stored article this hash matches, or null. Ingest uses it to tell a
// sister-feed duplicate (skipped) from a wire copy in another newsroom (stored
// as syndicated); see ingestion/articleRow.ts.
//
// outletSourceIds is every source id in the outlet being polled, from the
// loaded roster. A row belonging to that outlet is returned in preference to
// any other, and only then does the earliest-by-id rule apply. Without the
// preference the lookup answered a different question than ingest was asking:
// it returned the EARLIEST row for the hash, so once a third outlet had stored
// a wire piece first, every feed of a second outlet saw a cross-outlet match
// and inserted its own copy. AP stores the piece, NPR News copies it, NPR
// Politics still sees AP's row as the earliest and copies it again: one
// newsroom, two rows, two dots in a story matrix that is supposed to count
// newsrooms. The preference costs nothing when no in-outlet row exists, which
// is the common case.
//
// Earliest by id among the rest, because the first row stored under a hash is
// the one every later copy points at, and that root never moves. That makes
// the pointer mean "same text as", not "originated at": the root is whichever
// outlet the roster polled first, so when a downstream paper's feed is read
// before AP's, AP's own copy points at the paper. Ordering by published_at
// instead would let a later-ingested row with an earlier date become a second
// root for the same hash, which breaks the one-hop rule. A public "syndicated
// from X" label therefore needs a wire-outlet preference (sources.type) on top
// of this pointer before it is shown; the S3 handoff in the plan records that.
// Preferring an in-outlet row does not disturb the root: when one exists the
// item is skipped and no pointer is written at all.
//
// Bounded to CONTEXT_WINDOW_DAYS: a genuine wire copy lands within days of the
// original, and an unbounded lookup let a months-old row with the same hash
// silently skip a new item in its outlet, or mark a new item in another outlet
// as a copy of something no page can reach any more.
export async function findByContentHash(hash: string, outletSourceIds: number[]): Promise<ContentHashMatch | null> {
  const { rows } = await pool.query<{
    id: number;
    source_id: number;
    source_name: string;
    outlet_key: string | null;
    syndicated_of_article_id: number | null;
    same_outlet: boolean;
  }>(
    `SELECT a.id, s.id AS source_id, s.name AS source_name, s.outlet_key, a.syndicated_of_article_id,
            (a.source_id = ANY($3::int[])) AS same_outlet
       FROM articles a
       JOIN sources s ON s.id = a.source_id
      WHERE a.content_hash = $1
        AND COALESCE(a.published_at, a.fetched_at) >= NOW() - ($2 || ' days')::INTERVAL
      ORDER BY (a.source_id = ANY($3::int[])) DESC, a.id ASC
      LIMIT 1`,
    [hash, CONTEXT_WINDOW_DAYS, outletSourceIds],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    sameOutlet: r.same_outlet,
    // Same read-side rule as sourcesRepo's readOutletKey: outlet_key is
    // nullable through the 0001 rollback window, a stored row must never make
    // ingest die, so a missing key falls back to the name derivation and then
    // to a per-source synthetic key. The strict resolveOutletKey is for writes.
    outletKey: r.outlet_key ?? outletKeyFromName(r.source_name) ?? `source-${r.source_id}`,
    syndicatedOfArticleId: r.syndicated_of_article_id,
  };
}

// A row one of the outlet's feeds already holds for the same piece, matched
// by URL or by title on the same publication day, or null. Sister feeds
// usually share the URL; when they do not, a title on the same day is the same
// piece (the same rule hashForItem uses for a headline-only row). Ingest asks
// this before writing a headline-only row so an outlet whose sister feed
// already stored the body does not gain a hollow twin of it: the two hash
// differently (title + body against title + day), so the content-hash lookup
// cannot see the pair. The caller passes every source id in the outlet,
// resolved from the loaded sources, so the nullable outlet_key column is never
// consulted here.
//
// excludeArticleId keeps a stored row from matching itself when the retry path
// asks whether a SISTER feed has meanwhile covered the piece.
//
// The title branch carries a +/- one day published_at range on top of the
// same-UTC-day equality. The range is redundant as a rule and is there for the
// planner: lower(btrim(title)) has no index, and this query runs once per
// would-be headline-only item (26 in one observed night) over the whole
// articles table. The range predicate can be served by articles_published_at_idx
// before any row is lowercased. A day of slack, because the equality is on the
// UTC calendar day and the index is on the instant.
export async function findSameOutletPiece(
  sourceIds: number[],
  item: { url: string; title: string; publishedAt: Date | null },
  excludeArticleId: number | null = null,
): Promise<{ id: number; wordCount: number } | null> {
  if (sourceIds.length === 0) return null;
  const { rows } = await pool.query<{ id: number; word_count: number }>(
    `SELECT id, word_count
       FROM articles
      WHERE source_id = ANY($1::int[])
        AND ($5::int IS NULL OR id <> $5::int)
        AND (
          url = $2
          OR (
            $4::timestamptz IS NOT NULL
            AND published_at IS NOT NULL
            AND published_at >= $4::timestamptz - INTERVAL '1 day'
            AND published_at <= $4::timestamptz + INTERVAL '1 day'
            AND lower(btrim(title)) = lower(btrim($3))
            AND (published_at AT TIME ZONE 'UTC')::date = ($4::timestamptz AT TIME ZONE 'UTC')::date
          )
        )
      ORDER BY word_count DESC, id ASC
      LIMIT 1`,
    [sourceIds, item.url, item.title, item.publishedAt, excludeArticleId],
  );
  return rows[0] ? { id: rows[0].id, wordCount: rows[0].word_count } : null;
}

// What ingest needs to know about a (source_id, url) it has seen before: enough
// to decide whether the stored row is a finished article (skip the extractor)
// or a headline-only row still inside the window, worth one more try at the
// body. See ingestion/articleRow.ts shouldRetryExtraction.
export interface StoredArticleLookup {
  id: number;
  extractionStatus: Article["extractionStatus"];
  wordCount: number;
  publishedAt: Date | null;
  fetchedAt: Date;
}

export async function findStoredBySourceUrl(sourceId: number, url: string): Promise<StoredArticleLookup | null> {
  const { rows } = await pool.query<{
    id: number;
    extraction_status: Article["extractionStatus"];
    word_count: number;
    published_at: Date | null;
    fetched_at: Date;
  }>(
    `SELECT id, extraction_status, word_count, published_at, fetched_at
       FROM articles WHERE source_id = $1 AND url = $2`,
    [sourceId, url],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    extractionStatus: r.extraction_status,
    wordCount: r.word_count,
    publishedAt: r.published_at,
    fetchedAt: r.fetched_at,
  };
}

// Upgrade a headline-only row to a body (ingestion/articleRow.ts
// HeadlineUpgrade), in ONE statement so the status leaves 'failed' as the text
// lands and articles_headline_only_has_no_body holds throughout. Guarded on the row still being
// headline-only, so two runs racing on the same row cannot both write it and a
// row that already has a body is never overwritten; null means the guard held
// and nothing changed. fetched_at moves to now because the body was fetched
// now, and the scoring queue and edition windows read that column.
export async function upgradeHeadlineOnlyArticle(id: number, u: HeadlineUpgrade): Promise<Article | null> {
  if (u.wordCount <= 0 || u.extractionStatus === "failed") {
    throw new Error(`upgradeHeadlineOnlyArticle(${id}): an upgrade must carry a body`);
  }
  const { rows } = await pool.query<ArticleRow>(
    `UPDATE articles
        SET raw_text = $2,
            word_count = $3,
            extraction_status = $4,
            extracted_via = $5,
            paywall_flag = $6,
            content_hash = $7,
            syndicated_of_article_id = $8,
            fetched_at = NOW(),
            clean_text = NULL,
            furniture = NULL
      WHERE id = $1
        AND extraction_status = 'failed'
      RETURNING *`,
    [id, u.rawText, u.wordCount, u.extractionStatus, u.extractedVia, u.paywallFlag, u.contentHash, u.syndicatedOfArticleId],
  );
  return rows[0] ? rowToArticle(rows[0]) : null;
}

// A thin row (some text, under the 200-word floor) gains a real body from a
// later run (2026-09-26). Only a longer body of at least `minWords` replaces
// it, and any story membership recorded as headline-only for it becomes a full
// membership in the same transaction, so the story shows and scores it.
export async function upgradeThinArticle(id: number, u: HeadlineUpgrade, minWords: number): Promise<Article | null> {
  if (u.wordCount < minWords || u.extractionStatus === "failed") {
    throw new Error(`upgradeThinArticle(${id}): an upgrade must carry at least ${minWords} words`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ArticleRow>(
      `UPDATE articles
          SET raw_text = $2,
              word_count = $3,
              extraction_status = $4,
              extracted_via = $5,
              paywall_flag = $6,
              content_hash = $7,
              syndicated_of_article_id = $8,
              fetched_at = NOW(),
              clean_text = NULL,
              furniture = NULL
        WHERE id = $1
          AND extraction_status <> 'failed'
          AND word_count < $9
          AND word_count < $3
        RETURNING *`,
      [id, u.rawText, u.wordCount, u.extractionStatus, u.extractedVia, u.paywallFlag, u.contentHash, u.syndicatedOfArticleId, minWords],
    );
    if (rows[0] && u.syndicatedOfArticleId === null) {
      await client.query(
        `UPDATE story_members SET kind = 'full' WHERE article_id = $1 AND kind = 'headline_only'`,
        [id],
      );
    }
    await client.query("COMMIT");
    return rows[0] ? rowToArticle(rows[0]) : null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Remove a headline-only row that a sister feed of the same outlet has since
// covered with a body, so the outlet is one row for one piece.
//
// The fresh path enforces that by refusing to WRITE the hollow row
// (findSameOutletPiece). A row written before its sister feed caught up can
// only be cleaned up afterwards, and leaving it is the same defect the write
// guard exists to prevent: the outlet appears twice in a story, once hollow.
//
// Guarded on the row still being headline-only, so this can never remove a
// body. Returns whether a row went. A hollow row is never a syndication root
// (a headline-only row is never marked syndicated, and its title-plus-day hash
// cannot match another outlet's title-plus-body hash), so nothing points here.
export async function deleteHeadlineOnlyArticle(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM articles
      WHERE id = $1
        AND extraction_status = 'failed'
        AND word_count = 0`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function insertArticle(a: NewArticle): Promise<Article | null> {
  const { rows } = await pool.query<ArticleRow>(
    `INSERT INTO articles
       (source_id, url, title, author, published_at, raw_text, word_count,
        extraction_status, paywall_flag, content_hash, extracted_via,
        syndicated_of_article_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (source_id, url) DO NOTHING
     RETURNING *`,
    [
      a.sourceId,
      a.url,
      a.title,
      a.author,
      a.publishedAt,
      a.rawText,
      a.wordCount,
      a.extractionStatus,
      a.paywallFlag,
      a.contentHash,
      a.extractedVia,
      a.syndicatedOfArticleId,
    ],
  );
  return rows[0] ? rowToArticle(rows[0]) : null;
}

export async function listRecentArticles(limit = 50): Promise<Article[]> {
  const { rows } = await pool.query<ArticleRow>(
    "SELECT * FROM articles ORDER BY fetched_at DESC LIMIT $1",
    [limit],
  );
  return rows.map(rowToArticle);
}

export async function findArticleById(id: number): Promise<Article | null> {
  const { rows } = await pool.query<ArticleRow>(
    "SELECT * FROM articles WHERE id = $1",
    [id],
  );
  return rows[0] ? rowToArticle(rows[0]) : null;
}

// Recent scored articles with source metadata — used by the cluster cron
// to feed headlines + snippets into the clustering prompt.
export interface ArticleForClustering {
  id: number;
  title: string;
  sourceName: string;
  sourceLean: string;
  snippet: string;
  // Published inside FRESH_WINDOW_HOURS — i.e. this is current reporting rather
  // than older context. clusterCron requires at least one fresh member before a
  // cluster may run as a story.
  isFresh: boolean;
}

export async function listRecentScoredArticles(hoursBack = 24, limit = 200): Promise<ArticleForClustering[]> {
  const { rows } = await pool.query<{
    id: number;
    title: string;
    source_name: string;
    source_lean: string;
    raw_text: string;
    article_summary: string | null;
    is_fresh: boolean;
  }>(
    `SELECT a.id, a.title, src.name AS source_name, src.lean AS source_lean, COALESCE(a.clean_text, a.raw_text) AS raw_text,
            s.article_summary,
            (COALESCE(a.published_at, a.fetched_at) >= NOW() - ($5 || ' hours')::INTERVAL) AS is_fresh
     FROM articles a
     JOIN sources src ON src.id = a.source_id
     JOIN scores s    ON s.article_id = a.id
     WHERE a.fetched_at >= NOW() - ($1 || ' hours')::INTERVAL
       AND a.word_count >= $3
       -- Publication date, not fetch date. Everything here was fetched today,
       -- so fetched_at alone would let a months-old feed item run as news.
       -- Undated items fall back to fetch date rather than being dropped.
       AND COALESCE(a.published_at, a.fetched_at) >= NOW() - ($4 || ' days')::INTERVAL
     ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
     LIMIT $2`,
    [hoursBack, limit, MIN_EDITION_WORDS, CONTEXT_WINDOW_DAYS, FRESH_WINDOW_HOURS],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    sourceName: r.source_name,
    sourceLean: r.source_lean,
    // What the clusterer matches on. This was raw_text.slice(0, 200) — roughly
    // a dateline and half a sentence, and usually boilerplate. Two outlets
    // covering the same event open completely differently, so the model could
    // not tell they were the same story: of 150 scored articles only 30 landed
    // in any cluster, the largest story had 5 sources and most had 2.
    //
    // The scorer already writes a neutral two-to-three sentence summary of every
    // article (scores.article_summary), which is the best topic signal in the
    // database and was being thrown away here. Prefer it, and fall back to a
    // longer slice of the body when it is missing.
    snippet: r.article_summary?.trim() || r.raw_text.slice(0, 600),
    isFresh: r.is_fresh,
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// API view queries — return DTOs joined with sources/scores/translations.
// Kept in this file because they read from `articles` and the JOIN columns
// don't justify a separate read-model module yet.
// ──────────────────────────────────────────────────────────────────────────

interface ArticleViewRow {
  // article cols
  id: number;
  source_id: number;
  url: string;
  title: string;
  author: string | null;
  published_at: Date | null;
  raw_text: string;
  word_count: number;
  extraction_status: ExtractionStatus;
  paywall_flag: boolean;
  fetched_at: Date;
  // source cols
  source_name: string;
  source_lean: import("../../types.js").Lean;
  // score cols (nullable — LEFT JOIN)
  score_headline: number | null;
  score_language: number | null;
  score_sourcing: number | null;
  score_fallacies: number | null;
  score_structure: number | null;
  score_composite: number | null;
  score_label: Label | null;
  score_rationale: DimensionRationale | null;
  score_markers: PHMarker[] | null;
  score_excerpt_indices: number[] | null;
  score_political_lean: number | null;
  score_article_summary: string | null;
  score_section: string | null;
  score_model: string | null;
  score_at: Date | null;
}

type ExtractionStatus = Article["extractionStatus"];

const SUMMARY_SELECT = `
  a.id,
  a.source_id,
  a.url,
  a.title,
  a.author,
  a.published_at,
  COALESCE(a.clean_text, a.raw_text) AS raw_text,
  a.word_count,
  a.extraction_status,
  a.paywall_flag,
  a.fetched_at,
  s.name AS source_name,
  s.lean AS source_lean,
  sc.headline   AS score_headline,
  sc.language   AS score_language,
  sc.sourcing   AS score_sourcing,
  sc.fallacies  AS score_fallacies,
  sc.structure  AS score_structure,
  sc.composite  AS score_composite,
  sc.label      AS score_label,
  sc.rationale_json AS score_rationale,
  sc.markers        AS score_markers,
  sc.excerpt_indices AS score_excerpt_indices,
  sc.political_lean  AS score_political_lean,
  sc.article_summary AS score_article_summary,
  sc.section         AS score_section,
  sc.model_used AS score_model,
  sc.scored_at  AS score_at
`;

function rowToScoreDTO(r: ArticleViewRow): ScoreDTO | null {
  if (r.score_composite === null || r.score_label === null) return null;
  return {
    headline:  r.score_headline!,
    language:  r.score_language!,
    sourcing:  r.score_sourcing!,
    fallacies: r.score_fallacies!,
    structure: r.score_structure!,
    composite: r.score_composite,
    label:     r.score_label,
    rationale: r.score_rationale!,
    markers:   r.score_markers ?? [],
    excerptIndices: r.score_excerpt_indices ?? [],
    // Null-safe for rows scored before Phase 2 added these columns.
    politicalLean:  r.score_political_lean,
    articleSummary: r.score_article_summary ?? "",
    section:        r.score_section,
    modelUsed: r.score_model!,
    scoredAt:  r.score_at!.toISOString(),
  };
}

// Thin wrapper over the shared excerpt builder in lib/paragraphs.ts — the flat
// feed and section pages must produce identical excerpts for the same article.
function buildExcerpt(rawText: string, score: ScoreDTO | null): ArticleExcerptDTO | null {
  if (!score) return null;
  return buildExcerptWindow(rawText, score.excerptIndices, score.markers);
}

function rowToSummaryDTO(r: ArticleViewRow): ArticleSummaryDTO {
  const score = rowToScoreDTO(r);
  return {
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    sourceLean: r.source_lean,
    url: r.url,
    title: r.title,
    author: r.author,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    wordCount: r.word_count,
    extractionStatus: r.extraction_status,
    paywallFlag: r.paywall_flag,
    fetchedAt: r.fetched_at.toISOString(),
    score,
    excerpt: buildExcerpt(r.raw_text, score),
  };
}

// ── The paged feed ─────────────────────────────────────────────────────────

// One page of the eligible feed, plus the total behind it.
export interface ArticlePage {
  articles: ArticleSummaryDTO[];
  // Every article eligible for this edition, not just this page. The feed says
  // "showing X of Y" and Y has to be a real number, not the page size.
  total: number;
  // Opaque cursor for the next page, or null at the end.
  nextCursor: string | null;
}

// The cursor is the sort key of the last row on the page.
//
// Keyset, not OFFSET. The feed orders by publication date, which is NOT a total
// order — dozens of articles share a timestamp to the second — so OFFSET
// paging returns rows in an order the database is free to vary between queries,
// and a reader clicking "Load more" sees some articles twice and never sees
// others. Adding `id` as the final sort term makes the order total, and paging
// on (published, id) is then exact: every row appears once.
interface FeedCursor {
  sortAt: string; // ISO, from COALESCE(published_at, fetched_at)
  id: number;
}

export function encodeFeedCursor(c: FeedCursor): string {
  return Buffer.from(`${c.sortAt}|${c.id}`, "utf8").toString("base64url");
}

// Returns null for anything that is not a cursor this function produced. A
// malformed cursor must restart the feed from the top, never throw a 500 and
// never silently drop the WHERE clause and re-serve page one as page nine.
export function decodeFeedCursor(raw: unknown): FeedCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.lastIndexOf("|");
  if (sep <= 0) return null;
  const sortAt = decoded.slice(0, sep);
  const id = Number(decoded.slice(sep + 1));
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isFinite(Date.parse(sortAt))) return null;
  return { sortAt, id };
}

// The eligibility rule, written once. Both the page query and the count query
// must apply exactly the same filter or "showing 50 of 152" is a lie about a
// set the reader cannot actually reach.
const FEED_ELIGIBILITY = `
  a.word_count >= $ELIGIBLE_WORDS
  AND COALESCE(a.published_at, a.fetched_at) >= NOW() - ($ELIGIBLE_DAYS || ' days')::INTERVAL
`;

// How many scored, in-window articles the edition holds.
export async function countArticleSummaries(): Promise<number> {
  const { rows } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
       FROM articles a
       JOIN sources s  ON s.id = a.source_id
       JOIN scores sc  ON sc.article_id = a.id
      WHERE ${FEED_ELIGIBILITY.replace("$ELIGIBLE_WORDS", "$1").replace("$ELIGIBLE_DAYS", "$2")}`,
    [MIN_EDITION_WORDS, CONTEXT_WINDOW_DAYS],
  );
  return Number(rows[0]?.cnt ?? 0);
}

// One page, newest first, with a cursor for the next.
export async function listArticleSummariesPage(
  limit = 50,
  cursor: FeedCursor | null = null,
): Promise<ArticlePage> {
  const where = FEED_ELIGIBILITY.replace("$ELIGIBLE_WORDS", "$2").replace("$ELIGIBLE_DAYS", "$3");
  const params: unknown[] = [limit + 1, MIN_EDITION_WORDS, CONTEXT_WINDOW_DAYS];
  // Strictly after the cursor row in the (sortAt DESC, id DESC) order. The row
  // comparison is what makes this exact at a timestamp tie.
  const keyset = cursor
    ? `AND (COALESCE(a.published_at, a.fetched_at), a.id) < ($4::timestamptz, $5::int)`
    : "";
  if (cursor) params.push(cursor.sortAt, cursor.id);

  const [{ rows }, total] = await Promise.all([
    pool.query<ArticleViewRow>(
      `SELECT ${SUMMARY_SELECT}
         FROM articles a
         JOIN sources s  ON s.id = a.source_id
         JOIN scores sc  ON sc.article_id = a.id
        WHERE ${where}
          ${keyset}
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
        LIMIT $1`,
      params,
    ),
    countArticleSummaries(),
  ]);

  // One row over the limit tells us whether another page exists without a
  // second round trip and without guessing from `rows.length === limit`, which
  // is wrong exactly when the last page is full.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    articles: page.map(rowToSummaryDTO),
    total,
    nextCursor:
      hasMore && last
        ? encodeFeedCursor({
            sortAt: (last.published_at ?? last.fetched_at).toISOString(),
            id: last.id,
          })
        : null,
  };
}

// The unpaged listArticleSummaries() that used to live here is gone.
//
// It ran the same query without the `a.id` tiebreak, which is precisely the
// defect keyset paging exists to fix: ORDER BY publication date alone is not a
// total order, so two calls could return the same rows in different orders.
// Keeping it as a second entry point meant two feed queries with two different
// ordering rules, and the one nobody was looking at was the wrong one. Callers
// use listArticleSummariesPage.
//
// The INNER JOIN on scores is preserved there and is load-bearing: an unscored
// article has no P/H rating and no markers, so it renders as a plain grey
// excerpt. This was once a LEFT JOIN ordered by fetch date while scoring selects
// by publication date, and a freshly built edition carried 203 articles of which
// only 67 were scored — the other 136 rendered blank.

interface ArticleDetailRow extends ArticleViewRow {
  translation_text: string | null;
  translation_removed: string[] | null;
  translation_model: string | null;
  translation_at: Date | null;
}

export async function getArticleDetail(id: number): Promise<ArticleDetailDTO | null> {
  const { rows } = await pool.query<ArticleDetailRow>(
    `SELECT ${SUMMARY_SELECT},
       t.translated_text       AS translation_text,
       t.removed_fallacies_json AS translation_removed,
       t.model_used            AS translation_model,
       t.generated_at          AS translation_at
     FROM articles a
     JOIN sources s  ON s.id = a.source_id
     LEFT JOIN scores sc       ON sc.article_id = a.id
     LEFT JOIN translations t  ON t.article_id  = a.id
     WHERE a.id = $1
       -- A headline-only row (S2) is a record that an outlet covered a story,
       -- not a page. It has no body, no score and therefore no excerpt, so
       -- serving it would be a blank article. It stays a story member and is
       -- not addressable here; the API turns this null into a 404.
       AND a.extraction_status <> 'failed'`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  const translation: TranslationDTO | null =
    row.translation_text === null
      ? null
      : {
          translatedText: row.translation_text,
          removedFallacies: row.translation_removed ?? [],
          modelUsed: row.translation_model!,
          generatedAt: row.translation_at!.toISOString(),
        };

  return {
    ...rowToSummaryDTO(row),
    rawText: row.raw_text,
    translation,
  };
}

// The story-first S4 assessment stage's read path: member titles, summaries
// and capped excerpts for a set of article ids, and nothing else — the same
// SUMMARY_SELECT/rowToSummaryDTO every other summary view uses, so rawText
// reaches this function's SQL result row (needed to build the excerpt) but
// never reaches its return type. A headline-only or unscored member still
// returns a row here (title, outlet, no score, no excerpt); it is the
// assessment writer's job to describe those honestly, not this query's job to
// drop them. Order is not guaranteed; callers that care join by id.
export async function getArticleSummariesByIds(ids: readonly number[]): Promise<ArticleSummaryDTO[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<ArticleViewRow>(
    `SELECT ${SUMMARY_SELECT}
       FROM articles a
       JOIN sources s ON s.id = a.source_id
       LEFT JOIN scores sc ON sc.article_id = a.id
      WHERE a.id = ANY($1::int[])`,
    [ids as number[]],
  );
  return rows.map(rowToSummaryDTO);
}

// Articles from the last SCORE_WINDOW_HOURS that have no row in `scores` yet.
// Older unscored articles are never picked up: they age out, they are not a
// queue to drain.
// Unscored primary members of multi-outlet stories, most-covered story first
// (2026-09-26). The edition's 40-article scoring pass runs before grouping,
// so most members of a well-covered story were never scored and its front-page
// item read "1 scored so far". The ledger calls this after grouping, with the
// same text rules as listUnscoredArticles.
export async function listUnscoredStoryMembers(days: number, limit: number): Promise<Article[]> {
  const { rows } = await pool.query<ArticleRow>(
    `WITH covered AS (
       SELECT sm.story_id, COUNT(DISTINCT a2.source_id) AS outlets
       FROM story_members sm
       JOIN stories st ON st.id = sm.story_id
       JOIN articles a2 ON a2.id = sm.article_id
       WHERE st.status <> 'merged'
         AND st.updated_at >= NOW() - make_interval(days => $1)
         AND sm.role = 'primary'
       GROUP BY sm.story_id
       HAVING COUNT(DISTINCT a2.source_id) >= 2
     )
     SELECT a.*, src.register AS source_register
     FROM story_members sm
     JOIN covered c ON c.story_id = sm.story_id
     JOIN articles a ON a.id = sm.article_id
     JOIN sources src ON src.id = a.source_id
     LEFT JOIN scores s ON s.article_id = a.id
     WHERE s.article_id IS NULL
       AND sm.role = 'primary'
       AND a.word_count >= $2
       AND a.extraction_status <> 'failed'
       AND a.syndicated_of_article_id IS NULL
     ORDER BY c.outlets DESC, sm.story_id, a.id
     LIMIT $3`,
    [days, MIN_EDITION_WORDS, limit],
  );
  return rows.map(rowToArticle);
}

export async function listUnscoredArticles(limit = 50): Promise<Article[]> {
  const { rows } = await pool.query<ArticleRow>(
    // ROUND-ROBIN ACROSS OUTLETS, not newest-first.
    //
    // Straight recency ordering handed the whole budget to whichever outlets
    // happened to stamp the latest timestamps, and the result was a paper that
    // looked editorially skewed while the corpus underneath was balanced.
    // Measured: ingest held 456 articles from right and center-right outlets
    // against 425 from left and center-left, yet scoring took 37 of New York
    // Post's 37 eligible articles while giving Fox News 1 of 25, Daily Wire 1 of
    // 46, and The Federalist and National Review none at all. Every one of those
    // passed the word and freshness filters; they simply lost a clock race.
    //
    // Ranking within each source and taking rank 1 from every outlet before any
    // outlet's rank 2 spends the budget on breadth instead. It is also what the
    // product needs: a story can only be shown from two sides if both sides were
    // scored, so diversity at this step is what makes the comparison possible.
    `SELECT * FROM (
       SELECT a.*, src.register AS source_register,
              ROW_NUMBER() OVER (
                PARTITION BY a.source_id
                ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
              ) AS source_rank
       FROM articles a
       JOIN sources src ON src.id = a.source_id
       LEFT JOIN scores s ON s.article_id = a.id
       WHERE s.article_id IS NULL
         AND a.word_count >= $2
         -- Headline-only rows have no text to score; the word floor already
         -- excludes them, and this names the rule rather than relying on it.
         AND a.extraction_status <> 'failed'
         -- A wire copy is the original's text under another masthead. Scoring
         -- it would pay twice for one telling; the story layer reads the
         -- original's score through the syndicated_of pointer.
         AND a.syndicated_of_article_id IS NULL
         AND COALESCE(a.published_at, a.fetched_at) >= NOW() - make_interval(hours => $3)
     ) ranked
     ORDER BY source_rank, COALESCE(published_at, fetched_at) DESC
     LIMIT $1`,
    [limit, MIN_EDITION_WORDS, SCORE_WINDOW_HOURS],
  );
  return rows.map(rowToArticle);
}

// Store the furniture filter's result (migration 0006). raw_text is untouched.
// Called only immediately before an article is scored, so every stored score
// was computed on the text its excerpt is later built from.
export async function setCleanText(id: number, cleanText: string, furniture: unknown): Promise<void> {
  await pool.query(`UPDATE articles SET clean_text = $2, furniture = $3 WHERE id = $1`, [id, cleanText, JSON.stringify(furniture)]);
}

// Articles by id, shaped exactly as the scoring queue shapes them (with the
// source's register pin), for re-scoring a known set without the queue's
// freshness and word-count filters.
export async function listArticlesByIds(ids: readonly number[]): Promise<Article[]> {
  const { rows } = await pool.query<ArticleRow>(
    `SELECT a.*, src.register AS source_register FROM articles a JOIN sources src ON src.id = a.source_id WHERE a.id = ANY($1)`,
    [ids],
  );
  return rows.map(rowToArticle);
}
