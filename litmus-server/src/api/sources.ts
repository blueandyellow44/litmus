import { Router, type Request, type Response } from "express";
import { listAllSources } from "../db/repos/sourcesRepo.js";
import { logger } from "../lib/logger.js";
import type { SourceDTO, ApiError } from "./types.js";
import type { Source } from "../types.js";

export const sourcesRouter = Router();

// GET /api/sources
// All configured sources (enabled + disabled). Frontend SourceConfig page
// reads this and lets the user toggle which to ingest from.
sourcesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const sources = await listAllSources();
    res.json({ sources: sources.map(toDTO) });
  } catch (err) {
    logger.error("GET /sources failed", { err: errStr(err) });
    res.status(500).json(toErr("internal_error"));
  }
});

function toDTO(s: Source): SourceDTO {
  return {
    id: s.id,
    name: s.name,
    rssUrl: s.rssUrl,
    lean: s.lean,
    type: s.type,
    paywallStatus: s.paywallStatus,
    reliability: s.reliability,
    enabled: s.enabled,
  };
}

function toErr(code: string): ApiError {
  return { error: code };
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
