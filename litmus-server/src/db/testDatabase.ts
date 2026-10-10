// Teardown for the integration tests' embedded Postgres.
//
// pool.end() resolves before its connections have closed: pg-pool drops each
// client from its list and calls client.end() without waiting for it
// (pg-pool 3.13, _pulseQueue/_remove). The tests then stopped Postgres with a
// fast shutdown, and a backend that had not yet read its client's Terminate
// message was killed instead, sending 57P01 "terminating connection due to
// administrator command" to a client the pool no longer listened to. That
// error went unhandled and failed the 2026-10-09 3:45 AM edition run after
// every ledger test had passed. So teardown now waits until the database has
// no client connections left before stopping it.

import pg from "pg";
import type EmbeddedPostgres from "embedded-postgres";

const POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 15_000;

// Resolves once no client backend is connected to the URL's database. The
// probe connects to the "postgres" maintenance database so it does not count
// itself. Throws, naming the backends, if any are still connected at timeout:
// a connection that never closes is a leak worth failing on.
export async function waitForNoClients(databaseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const target = new URL(databaseUrl);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  const probeUrl = new URL(databaseUrl);
  probeUrl.pathname = "/postgres";
  const probe = new pg.Client({ connectionString: probeUrl.toString() });
  await probe.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await probe.query<{ pid: number; state: string | null }>(
        "SELECT pid, state FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend'",
        [dbName],
      );
      if (rows.length === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`still connected to ${dbName} after ${timeoutMs}ms: ${rows.map((r) => `pid ${r.pid} (${r.state ?? "unknown"})`).join(", ")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await probe.end();
  }
}

// End the pool, wait for its connections to be gone, then stop Postgres.
export async function stopTestDatabase(opts: { pool?: pg.Pool; pg?: EmbeddedPostgres; databaseUrl?: string }): Promise<void> {
  await opts.pool?.end();
  if (opts.pg && opts.databaseUrl) await waitForNoClients(opts.databaseUrl);
  await opts.pg?.stop();
}
