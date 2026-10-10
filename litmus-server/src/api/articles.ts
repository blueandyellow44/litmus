import { Router, type Request, type Response } from "express";
import {
  decodeFeedCursor,
  getArticleDetail,
  listArticleSummariesPage,
} from "../db/repos/articlesRepo.js";
import { logger } from "../lib/logger.js";
import type { ApiError } from "./types.js";

export const articlesRouter = Router();

// GET /api/articles?limit=50&cursor=...
//
// One page of the scored feed, newest first, plus the TOTAL behind it and a
// cursor for the next page. The total is what lets All Stories say "showing 50
// of 152" instead of implying 50 is all there is — which is what it did, with
// no pagination at all, while the rest of a scored edition sat unreachable.
//
// `articles` is kept at the top level so an older client reading
// `{ articles }` still works.
articlesRouter.get("/", async (req: Request, res: Response) => {
  const limit = parseLimit(req.query.limit, 50, 200);
  // An unrecognisable cursor restarts the feed rather than erroring. It is a
  // navigation token in a URL, so a truncated or hand-edited one is a normal
  // event, not a server fault.
  const cursor = decodeFeedCursor(req.query.cursor);
  try {
    const page = await listArticleSummariesPage(limit, cursor);
    res.json(page);
  } catch (err) {
    logger.error("GET /articles failed", { err: errStr(err) });
    res.status(500).json(toErr("internal_error"));
  }
});

// GET /api/articles/:id
// Full article + score + translation (if generated). The frontend ArticleDetail
// page calls this. Translation is null until POST /api/translations/:id is called.
articlesRouter.get("/:id", async (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json(toErr("invalid_id"));
    return;
  }

  try {
    const article = await getArticleDetail(id);
    if (!article) {
      res.status(404).json(toErr("not_found"));
      return;
    }
    res.json(article);
  } catch (err) {
    logger.error("GET /articles/:id failed", { id, err: errStr(err) });
    res.status(500).json(toErr("internal_error"));
  }
});

function parseLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== "string") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function toErr(code: string, detail?: string): ApiError {
  return detail ? { error: code, detail } : { error: code };
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
