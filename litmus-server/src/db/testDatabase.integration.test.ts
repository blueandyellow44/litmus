import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";
import { stopTestDatabase, waitForNoClients } from "./testDatabase.js";

// The 2026-10-09 3:45 AM edition failed after every ledger test passed: a
// fast shutdown killed a connection pool.end() had not finished closing, and
// the 57P01 that followed went unhandled. Pausing one backend with SIGSTOP
// holds that window open, so the race happens every time, not one run in many.

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function startDb(): Promise<{ db: EmbeddedPostgres; dir: string; url: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "litmus-teardown-pg-"));
  const port = await freePort();
  const db = new EmbeddedPostgres({ databaseDir: dir, user: "litmus", password: "litmus", port, persistent: false, onLog: () => {}, onError: () => {} });
  await db.initialise();
  await db.start();
  await db.createDatabase("litmus");
  return { db, dir, url: `postgres://litmus:litmus@127.0.0.1:${port}/litmus` };
}

const PAUSE_MS = 1_000;
const SETTLE_MS = 1_500;

describe("stopTestDatabase", () => {
  it("waits for a slow-closing connection, so the shutdown raises no error", async () => {
    const { db, dir, url } = await startDb();
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onError);
    try {
      const pool = new pg.Pool({ connectionString: url });
      const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = rows[0]!.pid;
      process.kill(pid, "SIGSTOP");
      const resume = setTimeout(() => process.kill(pid, "SIGCONT"), PAUSE_MS);
      await stopTestDatabase({ pool, pg: db, databaseUrl: url });
      clearTimeout(resume);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onError);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails loudly, naming the backend, when a connection never closes", async () => {
    const { db, dir, url } = await startDb();
    const leaked = new pg.Client({ connectionString: url });
    await leaked.connect();
    try {
      await expect(waitForNoClients(url, 200)).rejects.toThrow(/still connected to litmus after 200ms: pid \d+/);
    } finally {
      await leaked.end();
      await waitForNoClients(url);
      await db.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
