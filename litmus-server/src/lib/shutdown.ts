// Deterministic termination for every batch entrypoint (ingest, score,
// cluster, initSchema).
//
// Why this exists: a worker finishing its WORK is not the same as its PROCESS
// exiting. Node exits when the event loop has no remaining handles, and a
// library that leaves a pooled socket behind keeps the loop alive with no error
// and no log line. That is exactly what stalled the twice-daily edition: ingest
// logged "ingest done", then sat until GitHub killed the job at its 45-minute
// cap. Half of all scheduled runs died that way, and the ones that "passed"
// were idling 216-366 seconds at the same spot before the loop happened to
// drain. The cause was rss-parser polling through Node's GLOBAL http/https
// agents, whose keep-alive sockets are not unref'd (rssPoller.ts now uses its
// own non-keep-alive agents, which removes it at the source).
//
// This module is the backstop for the whole class, not a patch for that one
// library: any future dependency that leaks a handle gets bounded here instead
// of costing another 45-minute job. Three guarantees:
//
//   1. The database pool is closed.
//   2. Node's global agents are destroyed, so pooled sockets cannot pin the loop.
//   3. A watchdog force-exits if anything still holds the loop, and LOGS WHAT
//      IT WAS. The receipt matters: a silent hang and a clean exit look
//      identical from the outside, which is why this went unnoticed for weeks.
//
// The watchdog timer is unref'd on purpose. An unref'd timer does not by itself
// keep the process alive, so a healthy worker still exits the instant its work
// is done and never waits for the grace period; but if some other handle IS
// holding the loop, the timer still fires and cuts the hang short.

import http from "node:http";
import https from "node:https";
import { pool } from "../db/client.js";
import { logger } from "./logger.js";

// How long to let the loop drain on its own before forcing the issue. Long
// enough that a slow-but-real cleanup finishes normally, short enough that a
// leak costs seconds rather than the CI job's entire timeout budget.
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Close shared resources and guarantee the process terminates.
 *
 * Call this INSTEAD of a bare `await pool.end()` at the end of a worker, and
 * from its top-level catch. Safe to call more than once.
 */
export async function shutdown(exitCode = 0): Promise<void> {
  process.exitCode = exitCode;

  // 1. Database. A failure here must not stop the rest of the shutdown, or a
  //    transient pool error would reintroduce the hang this module prevents.
  try {
    await pool.end();
  } catch (err) {
    logger.warn("shutdown: pool.end failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Sockets parked in Node's global keep-alive agents. Destroying the agent
  //    tears down its idle sockets; without this they are counted as active
  //    handles and hold the loop open.
  try {
    http.globalAgent.destroy();
    https.globalAgent.destroy();
  } catch (err) {
    logger.warn("shutdown: agent destroy failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Watchdog. If the loop is clear, the process exits now and this never
  //    runs. If it is not, we exit anyway and say what was holding it.
  const watchdog = setTimeout(() => {
    logger.error("shutdown watchdog fired — forcing exit", {
      graceMs: SHUTDOWN_GRACE_MS,
      held: process.getActiveResourcesInfo(),
      exitCode,
    });
    process.exit(exitCode);
  }, SHUTDOWN_GRACE_MS);
  watchdog.unref();
}

/**
 * Standard top-level failure handler for a worker. Logs the crash, then shuts
 * down through the same path so a failing run cannot hang either — a crashed
 * worker that never exits burns the same 45 minutes as a stalled one.
 */
export function crashAndShutdown(label: string, err: unknown): void {
  logger.error(`${label} crashed`, {
    err: err instanceof Error ? err.stack : String(err),
  });
  void shutdown(1);
}
