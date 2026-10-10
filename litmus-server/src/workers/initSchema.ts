// Apply the schema via the pg pool (no psql binary needed) so the daily funnel
// can run in any CI/host. Idempotent: safe on every run. Use: npm run db:init:node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "../db/client.js";
import { shutdown, crashAndShutdown } from "../lib/shutdown.js";
import { logger } from "../lib/logger.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "db", "schema.sql");

async function main(): Promise<void> {
  const sql = await readFile(schemaPath, "utf-8");
  await pool.query(sql);
  logger.info("schema applied");
  await shutdown();
}

main().catch((err) => crashAndShutdown("schema init", err));
