import { pool } from "../client.js";
import type { ClusterProposal } from "../../clustering/topicClusterer.js";
import type { PHMarker } from "../../scoring/calibration.js";
import type { DimensionRationale } from "../../scoring/phScorer.js";
import type { Lean } from "../../types.js";

export interface ClusterRow {
  id: number;
  topic: string;
  summary: string;
  section: string | null;
  created_at: Date;
  updated_at: Date;
}

// A cluster proposal with its derived newspaper section (majority vote over
// member articles' scores.section — computed by the cluster cron).
export interface SectionedClusterProposal extends ClusterProposal {
  section: string | null;
}

// Full replace: delete all existing clusters and insert the new set in a
// single transaction. Clustering runs every 30m and produces a complete
// snapshot of today's story landscape — incremental merge would be more
// complex with no obvious benefit at this article volume.
export async function replaceAllClusters(proposals: SectionedClusterProposal[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM cluster_articles");
    await client.query("DELETE FROM clusters");

    for (const p of proposals) {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO clusters (topic, summary, section) VALUES ($1, $2, $3) RETURNING id`,
        [p.topic, p.summary, p.section],
      );
      const clusterId = rows[0]!.id;
      for (const articleId of p.articleIds) {
        await client.query(
          `INSERT INTO cluster_articles (cluster_id, article_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [clusterId, articleId],
        );
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────
// API read queries
// ─────────────────────────────────────────────────────────────────────

export interface ClusterWithStats {
  id: number;
  topic: string;
  summary: string;
  articleCount: number;
  phMin: number | null;
  phMax: number | null;
  phAvg: number | null;
  // How many of this story's outlets sit at each lean. It describes the SPREAD
  // of coverage and is displayed as such; it does not choose which tellings the
  // spread features. That pair contrasts P/H temperature and lean plays no part
  // in selecting it (Decision 2; docs/decisions/002-featured-pair-axis.md).
  leanCounts: Record<string, number>; // e.g. { "left": 2, "center": 3, "right": 1 }
  updatedAt: string; // ISO
}

interface ClusterStatsRow {
  id: number;
  topic: string;
  summary: string;
  updated_at: Date;
  article_count: string; // pg COUNT returns bigint → string
  ph_min: number | null;
  ph_max: number | null;
  ph_avg: number | null;
}

interface LeanCountRow {
  cluster_id: number;
  lean: string;
  cnt: string;
}

export async function listClustersWithStats(): Promise<ClusterWithStats[]> {
  // Two queries: cluster-level stats, then lean distribution. Cheaper than
  // one big query with lateral joins + array_agg for this volume.
  const { rows: stats } = await pool.query<ClusterStatsRow>(`
    SELECT
      c.id, c.topic, c.summary, c.updated_at,
      COUNT(ca.article_id)    AS article_count,
      MIN(s.composite)        AS ph_min,
      MAX(s.composite)        AS ph_max,
      ROUND(AVG(s.composite)::numeric, 1) AS ph_avg
    FROM clusters c
    JOIN cluster_articles ca ON ca.cluster_id = c.id
    LEFT JOIN scores s       ON s.article_id  = ca.article_id
    GROUP BY c.id
    ORDER BY COUNT(ca.article_id) DESC, c.id
  `);

  if (stats.length === 0) return [];

  const { rows: leans } = await pool.query<LeanCountRow>(`
    SELECT
      ca.cluster_id,
      src.lean,
      COUNT(*) AS cnt
    FROM cluster_articles ca
    JOIN articles a  ON a.id  = ca.article_id
    JOIN sources src ON src.id = a.source_id
    GROUP BY ca.cluster_id, src.lean
  `);

  const leanMap = new Map<number, Record<string, number>>();
  for (const r of leans) {
    const map = leanMap.get(r.cluster_id) ?? {};
    map[r.lean] = Number(r.cnt);
    leanMap.set(r.cluster_id, map);
  }

  return stats.map((r) => ({
    id: Number(r.id),
    topic: r.topic,
    summary: r.summary,
    articleCount: Number(r.article_count),
    phMin: r.ph_min,
    phMax: r.ph_max,
    phAvg: r.ph_avg !== null ? Number(r.ph_avg) : null,
    leanCounts: leanMap.get(r.id) ?? {},
    updatedAt: r.updated_at.toISOString(),
  }));
}

// Articles belonging to one cluster, with scores joined.
export interface ClusterArticleRow {
  id: number;
  source_id: number;
  source_name: string;
  source_lean: string;
  url: string;
  title: string;
  author: string | null;
  published_at: Date | null;
  word_count: number;
  extraction_status: string;
  paywall_flag: boolean;
  fetched_at: Date;
  score_composite: number | null;
  score_label: string | null;
}

export async function listClusterArticles(clusterId: number): Promise<ClusterArticleRow[]> {
  const { rows } = await pool.query<ClusterArticleRow>(`
    SELECT
      a.id, a.source_id, src.name AS source_name, src.lean AS source_lean,
      a.url, a.title, a.author, a.published_at,
      a.word_count, a.extraction_status, a.paywall_flag, a.fetched_at,
      s.composite AS score_composite, s.label AS score_label
    FROM cluster_articles ca
    JOIN articles a  ON a.id  = ca.article_id
    JOIN sources src ON src.id = a.source_id
    LEFT JOIN scores s ON s.article_id = a.id
    WHERE ca.cluster_id = $1
    ORDER BY a.published_at DESC NULLS LAST
  `, [clusterId]);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// Section queries (Phase 2 — /api/sections)
// ─────────────────────────────────────────────────────────────────────

// Sections of the given articles' scores, keyed by article id. Used by the
// cluster cron to derive each cluster's majority section.
export async function getArticleSections(articleIds: number[]): Promise<Map<number, string | null>> {
  if (articleIds.length === 0) return new Map();
  const { rows } = await pool.query<{ article_id: number; section: string | null }>(
    `SELECT article_id, section FROM scores WHERE article_id = ANY($1::int[])`,
    [articleIds],
  );
  return new Map(rows.map((r) => [r.article_id, r.section]));
}

export interface TrendingCluster {
  id: number;
  section: string;
  topic: string;
  summary: string;
  articleCount: number;
  // How far apart the calmest and hottest tellings of this story are. The
  // front page leads with the widest, because that gap IS the product.
  phSpread: number;
  // Highest editorial prominence among this story's outlets. The front page
  // requires a real desk on the story before it can carry the cover.
  topProminence: number;
}

// The "trending" cluster for each section: the sectioned cluster with the most
// member articles, tiebreak most recently updated. Sections with no sectioned
// clusters are simply absent from the result.
export async function getTrendingClusterPerSection(): Promise<TrendingCluster[]> {
  const { rows } = await pool.query<{
    id: number;
    section: string;
    topic: string;
    summary: string;
    article_count: string; // pg COUNT returns bigint → string
    ph_spread: number | null;
    top_prominence: number | null;
  }>(`
    SELECT DISTINCT ON (c.section)
      c.id, c.section, c.topic, c.summary,
      COUNT(ca.article_id) AS article_count,
      (MAX(s.composite) - MIN(s.composite)) AS ph_spread,
      MAX(src.prominence) AS top_prominence
    FROM clusters c
    JOIN cluster_articles ca ON ca.cluster_id = c.id
    JOIN scores s ON s.article_id = ca.article_id
    JOIN articles a ON a.id = ca.article_id
    JOIN sources src ON src.id = a.source_id
    WHERE c.section IS NOT NULL
    GROUP BY c.id
    -- No worthiness gate HERE on purpose. This query feeds every section page as
    -- well as the front page, and a section is entitled to show its best story
    -- even when that story would not carry a cover. Gating here emptied Politics
    -- and Sports outright. The cover bar is applied by the front page instead,
    -- using the counts this returns.
    -- TEMPERATURE SPREAD FIRST. It is not a ranking nicety, it is the product:
    -- this paper exists to show one event told calmly beside the same event told
    -- hot. A story where every outlet landed on 1.9 has nothing to show, and
    -- leading with it puts two Grounded articles side by side under "calmest"
    -- and "hottest" captions and stacks every dot on The Map at one point.
    --
    -- Prominence was briefly first here and that is exactly what produced that
    -- front page: a flat story from a big desk outranked a story with real
    -- range. Prominence now breaks ties among stories that already have
    -- something to show, which is the job it should have had all along.
    ORDER BY c.section,
             (MAX(s.composite) - MIN(s.composite)) DESC NULLS LAST,
             MAX(src.prominence) DESC NULLS LAST,
             (MAX(s.political_lean) - MIN(s.political_lean)) DESC NULLS LAST,
             COUNT(ca.article_id) DESC,
             c.updated_at DESC
  `);
  return rows.map((r) => ({
    id: Number(r.id),
    section: r.section,
    topic: r.topic,
    summary: r.summary,
    articleCount: Number(r.article_count),
    phSpread: r.ph_spread ?? 0,
    topProminence: r.top_prominence ?? 1,
  }));
}

// How many scored articles each section holds, keyed by canonical section name.
// Feeds the front-page digest so a section with real coverage but no multi-outlet
// cluster shows its story count instead of "No coverage yet". Sections with zero
// scored articles are simply absent from the map.
export async function countScoredArticlesPerSection(): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ section: string; cnt: string }>(
    `SELECT section, COUNT(*) AS cnt
       FROM scores
      WHERE section IS NOT NULL
      GROUP BY section`,
  );
  return new Map(rows.map((r) => [r.section, Number(r.cnt)]));
}

// Scored articles classified into one section, with everything the section
// page needs — including raw_text + markers + excerpt_indices so the API
// layer can build the word-window excerpt.
export interface SectionArticleRow {
  id: number;
  source_id: number;
  source_name: string;
  source_lean: Lean;
  url: string;
  title: string;
  author: string | null;
  published_at: Date | null;
  raw_text: string;
  score_composite: number | null;
  score_label: string | null;
  score_political_lean: number | null;
  score_article_summary: string | null;
  score_rationale: DimensionRationale | null;
  score_markers: PHMarker[] | null;
  score_excerpt_indices: number[] | null;
}

export async function listSectionArticles(section: string, limit = 50): Promise<SectionArticleRow[]> {
  const { rows } = await pool.query<SectionArticleRow>(`
    SELECT
      a.id, a.source_id, src.name AS source_name, src.lean AS source_lean,
      a.url, a.title, a.author, a.published_at, COALESCE(a.clean_text, a.raw_text) AS raw_text,
      s.composite       AS score_composite,
      s.label           AS score_label,
      s.political_lean  AS score_political_lean,
      s.article_summary AS score_article_summary,
      s.rationale_json  AS score_rationale,
      s.markers         AS score_markers,
      s.excerpt_indices AS score_excerpt_indices
    FROM scores s
    JOIN articles a  ON a.id  = s.article_id
    JOIN sources src ON src.id = a.source_id
    WHERE s.section = $1
    ORDER BY a.published_at DESC NULLS LAST
    LIMIT $2
  `, [section, limit]);
  return rows;
}

// The articles that make up ONE trending story — this is what the section page's
// Map and Coverage plot ("how every source covered THIS story"), NOT the whole
// section. Same row shape as listSectionArticles, filtered to a cluster.
export async function listClusterArticlesFull(clusterId: number): Promise<SectionArticleRow[]> {
  const { rows } = await pool.query<SectionArticleRow>(`
    SELECT
      a.id, a.source_id, src.name AS source_name, src.lean AS source_lean,
      a.url, a.title, a.author, a.published_at, COALESCE(a.clean_text, a.raw_text) AS raw_text,
      s.composite       AS score_composite,
      s.label           AS score_label,
      s.political_lean  AS score_political_lean,
      s.article_summary AS score_article_summary,
      s.rationale_json  AS score_rationale,
      s.markers         AS score_markers,
      s.excerpt_indices AS score_excerpt_indices
    FROM cluster_articles ca
    JOIN articles a  ON a.id  = ca.article_id
    JOIN sources src ON src.id = a.source_id
    LEFT JOIN scores s ON s.article_id = a.id
    WHERE ca.cluster_id = $1
    ORDER BY s.political_lean ASC NULLS LAST
  `, [clusterId]);
  return rows;
}
