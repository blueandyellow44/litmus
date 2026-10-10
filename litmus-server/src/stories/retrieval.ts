import type { Lean, ExtractionStatus } from "../types.js";
import { pool } from "../db/client.js";
import type { Queryable } from "../db/repos/storiesRepo.js";

export interface StoryArticle {
  id: number;
  title: string;
  url: string;
  outletKey: string;
  outletName: string;
  sourceLean: Lean;
  publishedAt: Date | null;
  fetchedAt: Date;
  extractionStatus: ExtractionStatus;
  wordCount: number;
  syndicatedOfArticleId: number | null;
  articleSummary: string | null;
  // The P/H scorer's relational-context field: names the specific event or
  // statement this article explicitly reports itself as reacting to, or null.
  // Internal to the ledger's assignment/sweep prompts - never shown to readers.
  reactingTo: string | null;
  section: string | null;
}

export interface StoryCard {
  id: string;
  headline: string;
  eventStatement: string;
  section: string | null;
  firstSeenAt: Date;
  updatedAt: Date;
  memberHeadlines: string[];
  memberArticleIds: number[];
  outletKeys: string[];
}

interface ArticleRow {
  id: number;
  title: string;
  url: string;
  outlet_key: string;
  outlet_name: string;
  source_lean: Lean;
  published_at: Date | null;
  fetched_at: Date;
  extraction_status: ExtractionStatus;
  word_count: number;
  syndicated_of_article_id: number | null;
  article_summary?: string | null;
  reacting_to?: string | null;
  section?: string | null;
}

function rowToArticle(row: ArticleRow): StoryArticle {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    outletKey: row.outlet_key,
    outletName: row.outlet_name,
    sourceLean: row.source_lean,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    extractionStatus: row.extraction_status,
    wordCount: row.word_count,
    syndicatedOfArticleId: row.syndicated_of_article_id,
    articleSummary: row.article_summary ?? null,
    reactingTo: row.reacting_to ?? null,
    section: row.section ?? null,
  };
}

const OUTLET_KEY_SQL = `COALESCE(
  src.outlet_key,
  NULLIF(btrim(lower(regexp_replace(split_part(src.name, ' — ', 1), '[^A-Za-z0-9]+', '-', 'g')), '-'), ''),
  'source-' || src.id::text
)`;

// Membership runs before scoring. There is deliberately no fetched-at filter,
// word floor, extraction-status predicate, or inner scores join here.
export async function listUnassignedStoryArticles(days: number, db: Queryable = pool): Promise<StoryArticle[]> {
  if (!Number.isInteger(days) || days <= 0) throw new Error("story article window must be a positive integer");
  const { rows } = await db.query<ArticleRow>(
    `SELECT a.id, a.title, a.url,
            ${OUTLET_KEY_SQL} AS outlet_key,
            src.name AS outlet_name, src.lean AS source_lean,
            a.published_at, a.fetched_at, a.extraction_status, a.word_count,
            a.syndicated_of_article_id
       FROM articles a
       JOIN sources src ON src.id = a.source_id
      WHERE a.published_at >= NOW() - make_interval(days => $1)
        AND NOT EXISTS (
          SELECT 1 FROM story_members sm
          JOIN stories st ON st.id = sm.story_id
          WHERE sm.article_id = a.id AND st.status <> 'merged'
        )
        AND NOT EXISTS (
          SELECT 1 FROM story_article_states sas
          WHERE sas.article_id = a.id AND sas.state IN ('flag', 'not_news')
        )
      -- Newest first (2026-09-27): oldest-first left the day's own news
      -- ungrouped behind yesterday's leftovers (398 eligible, 200 taken).
      ORDER BY a.published_at DESC NULLS LAST, a.id DESC`,
    [days],
  );
  if (rows.length === 0) return [];

  // Eligibility is decided above without a scores join: headline-only and
  // unscored rows must still enter the ledger. Signals from a score, when one
  // happens to exist, are hydrated only after that inclusive set is fixed.
  const { rows: signals } = await db.query<{ article_id: number; article_summary: string; reacting_to: string | null; section: string | null }>(
    `SELECT article_id, article_summary, reacting_to, section FROM scores WHERE article_id = ANY($1::int[])`,
    [rows.map((row) => row.id)],
  );
  const byId = new Map(signals.map((signal) => [signal.article_id, signal]));
  return rows.map((row) => rowToArticle({ ...row, ...byId.get(row.id) }));
}

interface StoryCardRow {
  id: string;
  headline: string;
  event_statement: string;
  section: string | null;
  first_seen_at: Date;
  updated_at: Date;
  member_headlines: string[];
  member_article_ids: number[];
  outlet_keys: string[];
}

function rowToCard(row: StoryCardRow): StoryCard {
  return {
    id: row.id,
    headline: row.headline,
    eventStatement: row.event_statement,
    section: row.section,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
    memberHeadlines: row.member_headlines ?? [],
    memberArticleIds: row.member_article_ids ?? [],
    outletKeys: row.outlet_keys ?? [],
  };
}

export async function listOpenStoryCards(days: number, db: Queryable = pool): Promise<StoryCard[]> {
  if (!Number.isInteger(days) || days <= 0) throw new Error("open story window must be a positive integer");
  if (!Number.isInteger(days) || days <= 0) throw new Error("open story window must be a positive integer");
  const { rows } = await db.query<StoryCardRow>(
    `SELECT st.id, st.headline, st.event_statement, st.section, st.first_seen_at, st.updated_at,
            COALESCE(array_agg(a.title ORDER BY sm.added_at, a.id)
              FILTER (WHERE a.id IS NOT NULL), '{}') AS member_headlines,
            COALESCE(array_agg(a.id ORDER BY sm.added_at, a.id)
              FILTER (WHERE a.id IS NOT NULL), '{}') AS member_article_ids,
            COALESCE(array_agg(DISTINCT ${OUTLET_KEY_SQL})
              FILTER (WHERE src.id IS NOT NULL), '{}') AS outlet_keys
       FROM stories st
       LEFT JOIN story_members sm ON sm.story_id = st.id AND sm.role = 'primary'
       LEFT JOIN articles a ON a.id = sm.article_id
       LEFT JOIN sources src ON src.id = a.source_id
      WHERE st.status <> 'merged'
        AND st.updated_at >= NOW() - make_interval(days => $1)
      GROUP BY st.id
      ORDER BY st.updated_at DESC, st.id`,
    [days],
  );
  return rows.map(rowToCard);
}

const PROPER_NOUN = /\b(?:[A-Z]{2,}|[A-Z][a-z'’-]+)(?:[ \t]+(?:[A-Z]{2,}|[A-Z][a-z'’-]+))*\b/g;
const GENERIC = new Set(["The", "This", "That", "After", "Before", "United States", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);

export function properNouns(text: string): string[] {
  const found = new Map<string, string>();
  for (const match of text.match(PROPER_NOUN) ?? []) {
    const parts = match.trim().split(/[ \t]+/);
    while (parts.length > 1 && GENERIC.has(parts[0]!)) parts.shift();
    const value = parts.join(" ");
    if (value === "" || GENERIC.has(value)) continue;
    const key = value.toLowerCase();
    if (!found.has(key)) found.set(key, value);
  }
  return [...found.values()];
}

export function lexicalCandidateScore(article: StoryArticle, story: StoryCard, fullTextRank = 0): number {
  const articleText = `${article.title} ${article.articleSummary ?? ""}`;
  const storyText = `${story.headline} ${story.eventStatement} ${story.memberHeadlines.join(" ")}`.toLowerCase();
  const shared = properNouns(articleText).filter((noun) => {
    const escaped = noun.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(storyText);
  }).length;
  return fullTextRank + shared * 0.35;
}

export function fullTextCandidateQuery(article: Pick<StoryArticle, "title" | "articleSummary">): string {
  const source = `${article.title} ${article.articleSummary ?? ""}`;
  const named = properNouns(source).flatMap((name) => name.toLowerCase().split(/[^a-z0-9]+/));
  const lexical = source.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4);
  const terms = [...new Set([...named, ...lexical].filter((term) => term.length >= 2))].slice(0, 20);
  // websearch_to_tsquery treats ordinary whitespace as AND. Story retrieval
  // needs recall, so explicit OR keeps one uncommon shared term eligible and
  // the lexical/proper-noun reranker does the precision work afterwards.
  return terms.length > 0 ? terms.join(" OR ") : article.title;
}

// Postgres supplies the full-text rank over the event statement plus member
// headlines. Shared proper nouns are added in code because they are names, not
// English stems, and therefore carry a different signal.
export async function retrieveCandidateStories(
  article: StoryArticle,
  limit: number,
  days: number,
  db: Queryable = pool,
): Promise<StoryCard[]> {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("candidate story limit must be a positive integer");
  if (!Number.isInteger(days) || days <= 0) throw new Error("candidate story window must be a positive integer");
  const { rows } = await db.query<StoryCardRow & { text_rank: number }>(
    `WITH story_docs AS (
       SELECT st.id, st.headline, st.event_statement, st.section, st.first_seen_at, st.updated_at,
              COALESCE(array_agg(a.title ORDER BY sm.added_at, a.id)
                FILTER (WHERE a.id IS NOT NULL), '{}') AS member_headlines,
              COALESCE(array_agg(a.id ORDER BY sm.added_at, a.id)
                FILTER (WHERE a.id IS NOT NULL), '{}') AS member_article_ids,
              COALESCE(array_agg(DISTINCT ${OUTLET_KEY_SQL})
                FILTER (WHERE src.id IS NOT NULL), '{}') AS outlet_keys,
              to_tsvector('english', st.event_statement || ' ' || st.headline || ' ' ||
                COALESCE(string_agg(a.title, ' '), '')) AS document
         FROM stories st
         LEFT JOIN story_members sm ON sm.story_id = st.id AND sm.role = 'primary'
         LEFT JOIN articles a ON a.id = sm.article_id
         LEFT JOIN sources src ON src.id = a.source_id
        WHERE st.status <> 'merged' AND st.updated_at >= NOW() - make_interval(days => $2)
        GROUP BY st.id
     ), target AS (
       SELECT websearch_to_tsquery('english', $1) AS query
     )
     SELECT story_docs.*, ts_rank_cd(document, target.query) AS text_rank
       FROM story_docs, target
      ORDER BY text_rank DESC, updated_at DESC, id`,
    [fullTextCandidateQuery(article), days],
  );
  return rows
    .map((row) => ({ card: rowToCard(row), score: lexicalCandidateScore(article, rowToCard(row), row.text_rank) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.card.updatedAt.getTime() - a.card.updatedAt.getTime())
    .slice(0, limit)
    .map((entry) => entry.card);
}

export async function findPrimaryStoryForArticle(articleId: number, db: Queryable = pool): Promise<string | null> {
  const { rows } = await db.query<{ story_id: string }>(
    `SELECT sm.story_id
       FROM story_members sm
       JOIN stories st ON st.id = sm.story_id
      WHERE sm.article_id = $1 AND sm.role = 'primary' AND st.status <> 'merged'
      ORDER BY sm.added_at LIMIT 1`,
    [articleId],
  );
  return rows[0]?.story_id ?? null;
}

// No model call is needed when ingest already proved a wire copy, or when two
// sister feeds stored the exact same publisher URL during the migration
// window. The original/older row decides the stable story id.
export async function findDeterministicStoryForArticle(
  articleId: number,
  db: Queryable = pool,
): Promise<string | null> {
  const { rows } = await db.query<{ story_id: string }>(
    `WITH target AS (
       SELECT a.id, a.url, a.syndicated_of_article_id,
              ${OUTLET_KEY_SQL} AS outlet_key
       FROM articles a
       JOIN sources src ON src.id = a.source_id
       WHERE a.id = $1
     ), possible_originals AS (
       SELECT candidate.id,
              CASE WHEN candidate.id = target.syndicated_of_article_id THEN 0 ELSE 1 END AS priority
       FROM target
       JOIN articles candidate ON
         candidate.id = target.syndicated_of_article_id
         OR (candidate.id <> target.id AND candidate.url = target.url)
       JOIN sources src ON src.id = candidate.source_id
       WHERE candidate.id = target.syndicated_of_article_id
          OR ${OUTLET_KEY_SQL} = target.outlet_key
     )
     SELECT sm.story_id
     FROM possible_originals original
     JOIN story_members sm ON sm.article_id = original.id AND sm.role = 'primary'
     JOIN stories st ON st.id = sm.story_id AND st.status <> 'merged'
     ORDER BY original.priority, original.id, sm.added_at
     LIMIT 1`,
    [articleId],
  );
  return rows[0]?.story_id ?? null;
}
