// POST /api/translations/:articleId
// Triggers an on-demand Sonnet translation (or returns cached). This is
// intentionally user-triggered, not part of ingest — translations are
// expensive and most users don't click into most articles.
//
// Off unless ENABLE_ON_DEMAND_TRANSLATION=1, and capped per day when on
// (translationGate.ts). The published paper is static and never calls this.

import { Router, type Request, type Response } from "express";
import { findArticleById, getArticleDetail } from "../db/repos/articlesRepo.js";
import { insertTranslation, existsForArticle } from "../db/repos/translationsRepo.js";
import { translateArticle, TooShortError } from "../translation/translator.js";
import { logger } from "../lib/logger.js";
import { env } from "../lib/env.js";
import { createTranslationGate } from "./translationGate.js";

const gate = createTranslationGate({
  enabled: env.ENABLE_ON_DEMAND_TRANSLATION,
  dailyCap: env.TRANSLATION_DAILY_CAP,
});

export const translationsRouter = Router();

translationsRouter.post("/:articleId", async (req: Request, res: Response) => {
  const off = gate.enabled();
  if (off) {
    res.status(off.status).json({ error: off.error });
    return;
  }

  const articleId = Number.parseInt(req.params.articleId ?? "", 10);
  if (!Number.isInteger(articleId) || articleId <= 0) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  try {
    // Fast path: if we already translated this article, return the cached
    // detail row directly. No Claude call.
    if (await existsForArticle(articleId)) {
      const cached = await getArticleDetail(articleId);
      if (cached?.translation) {
        res.json({ translation: cached.translation, cached: true });
        return;
      }
    }

    const article = await findArticleById(articleId);
    if (!article) {
      res.status(404).json({ error: "article_not_found" });
      return;
    }

    if (article.extractionStatus !== "full") {
      res.status(422).json({
        error: "partial_article",
        detail: "Translation requires a full article; this one was extracted as partial (likely paywalled).",
      });
      return;
    }

    const capped = gate.reserve();
    if (capped) {
      res.status(capped.status).json({ error: capped.error });
      return;
    }
    let result;
    try {
      result = await translateArticle(article);
    } catch (err) {
      // Refused before any model call, so the day's allowance is not spent.
      if (err instanceof TooShortError) gate.release();
      throw err;
    }
    await insertTranslation(articleId, result);

    // Re-read the detail so we return the DTO-shaped translation (ISO dates etc.)
    const refreshed = await getArticleDetail(articleId);
    res.json({ translation: refreshed?.translation ?? null, cached: false });
  } catch (err) {
    if (err instanceof TooShortError) {
      res.status(422).json({
        error: "too_short",
        detail: err.message,
      });
      return;
    }
    logger.error("POST /translations/:id failed", {
      articleId,
      err: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "internal_error" });
  }
});
