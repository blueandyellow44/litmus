// One-off repair: give back the articles one ledger run flagged by mistake.
//
// Ledger run 10 (GitHub run 36261391937, 2026-09-26) flagged 149 of 200
// articles, 141 of them because the sweep rejected its own model's answers
// (fixed in sweep.ts). A flag removes an article from the ledger's queue for
// good, so the repair deletes that run's flag rows. Every deleted row is
// copied into story_events_log first ('restore_flag', with the old row in
// detail), so the repair is itself recoverable. Restore on Max's word,
// 2026-09-26.
//
//   npm run restore-flags -- --run=10 --expect=149            (dry run)
//   npm run restore-flags -- --run=10 --expect=149 --apply    (writes)
//
// Refuses to write unless the row count matches --expect exactly.

import { pool } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { shutdown, crashAndShutdown } from "../lib/shutdown.js";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function wholeNumber(name: string): number {
  const raw = arg(name);
  if (raw === null || !/^\d+$/.test(raw)) throw new Error(`--${name} must be a whole number`);
  return Number(raw);
}

async function main(): Promise<void> {
  const runId = wholeNumber("run");
  const expect = wholeNumber("expect");
  const apply = process.argv.includes("--apply");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ article_id: number; reason: string; updated_at: Date }>(
      `SELECT article_id, reason, updated_at FROM story_article_states
        WHERE run_id = $1 AND state = 'flag' ORDER BY article_id FOR UPDATE`,
      [runId],
    );
    const byReason: Record<string, number> = {};
    for (const row of rows) byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
    logger.info("restore flags: found", { runId, flagged: rows.length, expect, apply, byReason });

    if (rows.length !== expect) {
      await client.query("ROLLBACK");
      throw new Error(`refusing: run ${runId} has ${rows.length} flag rows, expected ${expect}`);
    }
    if (!apply) {
      await client.query("ROLLBACK");
      logger.info("restore flags: dry run, nothing written", { articleIds: rows.map((r) => r.article_id) });
      return;
    }

    for (const row of rows) {
      await client.query(
        `INSERT INTO story_events_log (run_id, article_id, story_id, action, reason, detail)
         VALUES ($1, $2, NULL, 'restore_flag', $3, $4::jsonb)`,
        [
          runId,
          row.article_id,
          "Flag removed: the sweep defect fixed 2026-09-26 flagged it by mistake.",
          JSON.stringify({ previousState: "flag", previousReason: row.reason, previousUpdatedAt: row.updated_at }),
        ],
      );
    }
    const deleted = await client.query(
      `DELETE FROM story_article_states WHERE run_id = $1 AND state = 'flag'`,
      [runId],
    );
    if (deleted.rowCount !== expect) throw new Error(`deleted ${deleted.rowCount}, expected ${expect}; rolling back`);
    await client.query("COMMIT");
    logger.info("restore flags: done", { runId, restored: deleted.rowCount });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main()
  .then(() => shutdown())
  .catch((error) => crashAndShutdown("restore flags", error));
