// Litmus API server entrypoint. Run with: npm run dev (watch) or npm start.
//
// Routes:
//   GET  /api/health                 — liveness
//   GET  /api/articles?limit=N       — newest articles + scores
//   GET  /api/articles/:id           — full article + score + translation
//   GET  /api/sources                — all sources
//   GET  /api/clusters               — stub until Phase 8
//   GET  /api/sections               — section index + trending clusters
//   GET  /api/sections/:slug         — one section's page
//   GET  /api/stories                — the Story Ledger's open stories (story-first front page)
//   POST /api/translations/:id       — stub until Phase 6
//
// CORS is wide open in dev. Tighten before deploying.

import express from "express";
import cors from "cors";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { pool } from "./db/client.js";
import { articlesRouter } from "./api/articles.js";
import { sourcesRouter } from "./api/sources.js";
import { clustersRouter } from "./api/clusters.js";
import { sectionsRouter } from "./api/sections.js";
import { storiesRouter } from "./api/stories.js";
import { translationsRouter } from "./api/translations.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  // Cheap DB ping so the health check covers the whole stack, not just Node.
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    logger.error("health db ping failed", { err: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ ok: false, error: "db_unreachable" });
  }
});

app.use("/api/articles",     articlesRouter);
app.use("/api/sources",      sourcesRouter);
app.use("/api/clusters",     clustersRouter);
app.use("/api/sections",     sectionsRouter);
app.use("/api/stories",      storiesRouter);
app.use("/api/translations", translationsRouter);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

const server = app.listen(env.PORT, () => {
  logger.info("server listening", { port: env.PORT });
});

// Graceful shutdown so the dev `tsx watch` reload doesn't leak DB connections.
async function shutdown(signal: string): Promise<void> {
  logger.info("shutdown", { signal });
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));
