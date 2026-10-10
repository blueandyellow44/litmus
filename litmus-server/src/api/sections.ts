import { Router, type Request, type Response } from "express";
import { SECTIONS, type PHMarker } from "../scoring/calibration.js";
import {
  getTrendingClusterPerSection,
  listClusterArticlesFull,
  listSectionArticles,
  countScoredArticlesPerSection,
  type SectionArticleRow,
} from "../db/repos/clustersRepo.js";
import { buildExcerptWindow } from "../lib/paragraphs.js";
import { logger } from "../lib/logger.js";
import type {
  ArticleExcerptDTO,
  SectionArticleDTO,
  SectionPageDTO,
  SectionSummaryDTO,
  TrendingClusterDTO,
} from "./types.js";
import type { TrendingCluster } from "../db/repos/clustersRepo.js";

export const sectionsRouter = Router();

function toTrendingDTO(t: TrendingCluster): TrendingClusterDTO {
  return { clusterId: t.id, topic: t.topic, summary: t.summary, articleCount: t.articleCount, phSpread: t.phSpread, topProminence: t.topProminence };
}

// Excerpts go through the single shared builder in lib/paragraphs.ts so the
// flat feed and section pages can never drift apart.
function buildExcerpt(rawText: string, excerptIndices: number[], markers: PHMarker[]): ArticleExcerptDTO | null {
  return buildExcerptWindow(rawText, excerptIndices, markers);
}

function toSectionArticleDTO(r: SectionArticleRow): SectionArticleDTO {
  return {
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    sourceLean: r.source_lean,
    url: r.url,
    title: r.title,
    author: r.author,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    politicalLean: r.score_political_lean,
    composite: r.score_composite,
    label: r.score_label,
    articleSummary: r.score_article_summary ?? "",
    rationale: r.score_rationale,
    excerpt: buildExcerpt(r.raw_text, r.score_excerpt_indices ?? [], r.score_markers ?? []),
  };
}

// GET /api/sections
// One entry per section in canonical front-page order, each with its trending
// cluster (the section's most-covered story) or null when coverage is thin.
sectionsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const [trending, counts] = await Promise.all([
      getTrendingClusterPerSection(),
      countScoredArticlesPerSection(),
    ]);
    const bySection = new Map(trending.map((t) => [t.section, t]));
    const sections: SectionSummaryDTO[] = SECTIONS.map((name) => {
      const t = bySection.get(name);
      return {
        slug: name.toLowerCase(),
        name,
        trending: t ? toTrendingDTO(t) : null,
        articleCount: counts.get(name) ?? 0,
      };
    });
    res.json({ sections });
  } catch (err) {
    logger.error("GET /sections failed", { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /api/sections/:slug
// One section's page: trending cluster + its scored articles with excerpts.
sectionsRouter.get("/:slug", async (req: Request, res: Response) => {
  const slug = (req.params.slug ?? "").toLowerCase();
  const section = SECTIONS.find((s) => s.toLowerCase() === slug);
  if (!section) {
    res.status(404).json({ error: "unknown_section" });
    return;
  }

  try {
    const [trendingAll, sectionRows] = await Promise.all([
      getTrendingClusterPerSection(),
      // The whole desk: every scored article in this section, newest first. The
      // page leads with the trending story's spread and then lists the rest from
      // here, so a section with real coverage is never blank just because its
      // stories did not cluster into one multi-outlet event.
      listSectionArticles(section),
    ]);
    const trending = trendingAll.find((t) => t.section === section);
    // The lead story's coverage: the Map and the calmest-vs-hottest spread plot
    // the trending cluster's articles (how each source covered THAT one story).
    // No trending story -> no lead spread, but the section list below still runs.
    const rows = trending ? await listClusterArticlesFull(trending.id) : [];
    const body: SectionPageDTO = {
      section,
      trending: trending ? toTrendingDTO(trending) : null,
      articles: rows.map(toSectionArticleDTO),
      sectionArticles: sectionRows.map(toSectionArticleDTO),
    };
    res.json(body);
  } catch (err) {
    logger.error("GET /sections/:slug failed", { slug, err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "internal_error" });
  }
});
