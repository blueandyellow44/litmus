import { Router, type Request, type Response } from "express";
import { listClustersWithStats, listClusterArticles } from "../db/repos/clustersRepo.js";
import { logger } from "../lib/logger.js";

export const clustersRouter = Router();

// GET /api/clusters
// Today's story clusters with article count, P/H range, lean distribution.
clustersRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const clusters = await listClustersWithStats();
    res.json({ clusters });
  } catch (err) {
    logger.error("GET /clusters failed", { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /api/clusters/:id/articles
// All articles in a single cluster — the detail/expand view.
clustersRouter.get("/:id/articles", async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  try {
    const articles = await listClusterArticles(id);
    if (articles.length === 0) {
      res.status(404).json({ error: "cluster_not_found" });
      return;
    }
    res.json({
      clusterId: id,
      articles: articles.map((a) => ({
        id: a.id,
        sourceId: a.source_id,
        sourceName: a.source_name,
        sourceLean: a.source_lean,
        url: a.url,
        title: a.title,
        author: a.author,
        publishedAt: a.published_at?.toISOString() ?? null,
        wordCount: a.word_count,
        extractionStatus: a.extraction_status,
        paywallFlag: a.paywall_flag,
        fetchedAt: a.fetched_at.toISOString(),
        score: a.score_composite !== null ? {
          composite: a.score_composite,
          label: a.score_label,
        } : null,
      })),
    });
  } catch (err) {
    logger.error("GET /clusters/:id/articles failed", { id, err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "internal_error" });
  }
});
