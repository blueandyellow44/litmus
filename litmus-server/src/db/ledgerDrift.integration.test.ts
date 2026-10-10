import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { stopTestDatabase } from "./testDatabase.js";

// The ledger records what ran. It is only meaningful while the files that ran
// are still on disk, unchanged, under the same names. When they are not, the
// tool cannot describe the schema it is looking at — and the worst thing it can
// do then is act confidently.
//
// The specific bug these pin: `down` walked the ON-DISK list and took the last
// entry the ledger knew about. Delete or rename the newest applied migration
// and it would silently reverse the one BEFORE it, undoing a change nobody
// asked about while leaving the newest applied in place.

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

let pg: EmbeddedPostgres;
let dataDir: string;
let migDir: string;
let migrate: typeof import("./migrate.js");
let pool: (typeof import("./client.js"))["pool"];

const UP_A = "CREATE TABLE drift_a (id INT PRIMARY KEY);";
const UP_B = "CREATE TABLE drift_b (id INT PRIMARY KEY);";

async function writeBoth() {
  await writeFile(path.join(migDir, "0001_alpha.up.sql"), UP_A);
  await writeFile(path.join(migDir, "0001_alpha.down.sql"), "DROP TABLE drift_a;");
  await writeFile(path.join(migDir, "0002_beta.up.sql"), UP_B);
  await writeFile(path.join(migDir, "0002_beta.down.sql"), "DROP TABLE drift_b;");
}

async function resetDir() {
  await rm(migDir, { recursive: true, force: true });
  await mkdir(migDir, { recursive: true });
  await writeBoth();
}

// One embedded database and one `pool`/`migrate` module pair for the WHOLE
// file, set up here at file scope rather than inside any one describe.
// db/client.ts creates its pool once at first import and caches that module
// instance under ESM's module cache — a second describe that spun up its own
// embedded postgres and re-imported "./client.js" got back the exact same
// (already `.end()`ed) pool object, not a fresh one.
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "litmus-drift-pg-"));
  migDir = await mkdtemp(path.join(tmpdir(), "litmus-drift-sql-"));
  await writeBoth();

  const port = await freePort();
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "litmus",
    password: "litmus",
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("litmus");

  process.env.DATABASE_URL = `postgres://litmus:litmus@127.0.0.1:${port}/litmus`;
  process.env.LITMUS_ISOLATED = "1";
  migrate = await import("./migrate.js");
  ({ pool } = await import("./client.js"));
}, 120_000);

afterAll(async () => {
  // Waits for the pool's connections to close before the fast shutdown
  // (testDatabase.ts; the 2026-10-09 edition failed on this race).
  await stopTestDatabase({ pool, pg, databaseUrl: process.env.DATABASE_URL });
  await rm(dataDir, { recursive: true, force: true });
  await rm(migDir, { recursive: true, force: true });
});

describe("ledger and disk must agree before anything acts", () => {
  // Every case starts from both migrations applied and both files present.
  beforeEach(async () => {
    await pool.query("DROP TABLE IF EXISTS schema_migrations, drift_a, drift_b");
    await resetDir();
    await migrate.up(migDir);
    const led = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(led.rows.map((r) => r.version)).toEqual(["0001", "0002"]);
  });

  it("REFUSES all three commands when an applied migration is missing from disk", async () => {
    await rm(path.join(migDir, "0002_beta.up.sql"));
    await rm(path.join(migDir, "0002_beta.down.sql"));

    await expect(migrate.status(migDir)).rejects.toThrow(/no file with that version is on disk/);
    await expect(migrate.up(migDir)).rejects.toThrow(/disagree about history/);
    await expect(migrate.down(migDir)).rejects.toThrow(/disagree about history/);
  });

  it("does NOT reverse an older migration when the newest applied is missing", async () => {
    await rm(path.join(migDir, "0002_beta.up.sql"));
    await rm(path.join(migDir, "0002_beta.down.sql"));

    await expect(migrate.down(migDir)).rejects.toThrow();

    // The older migration must be untouched: its table still exists and its
    // ledger row still stands. This is the assertion the old code failed.
    const a = await pool.query("SELECT to_regclass('public.drift_a') AS t");
    expect(a.rows[0].t).toBe("drift_a");
    const led = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(led.rows.map((r) => r.version)).toEqual(["0001", "0002"]);
  });

  it("REFUSES when an applied migration was renamed", async () => {
    await rename(path.join(migDir, "0002_beta.up.sql"), path.join(migDir, "0002_renamed.up.sql"));
    await rename(path.join(migDir, "0002_beta.down.sql"), path.join(migDir, "0002_renamed.down.sql"));

    await expect(migrate.status(migDir)).rejects.toThrow(/recorded as "0002_beta".*"0002_renamed"/s);
    await expect(migrate.down(migDir)).rejects.toThrow(/disagree about history/);
  });

  it("REFUSES when an applied migration was edited after the fact", async () => {
    await writeFile(path.join(migDir, "0002_beta.up.sql"), `${UP_B}\n-- edited after applying`);

    await expect(migrate.status(migDir)).rejects.toThrow(/edited after it was applied/);
    await expect(migrate.up(migDir)).rejects.toThrow(/disagree about history/);
    await expect(migrate.down(migDir)).rejects.toThrow(/disagree about history/);
  });

  it("status stays read-only even while refusing", async () => {
    await pool.query("DROP TABLE IF EXISTS schema_migrations");
    await rm(path.join(migDir, "0002_beta.up.sql"));
    // With no ledger there is no drift to find, and nothing may be created.
    await migrate.status(migDir);
    const t = await pool.query("SELECT to_regclass('public.schema_migrations') AS t");
    expect(t.rows[0].t).toBeNull();
  });

  it("reverses the newest applied migration when disk and ledger agree", async () => {
    await migrate.down(migDir);
    const b = await pool.query("SELECT to_regclass('public.drift_b') AS t");
    expect(b.rows[0].t).toBeNull();
    const a = await pool.query("SELECT to_regclass('public.drift_a') AS t");
    expect(a.rows[0].t).toBe("drift_a");
    const led = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(led.rows.map((r) => r.version)).toEqual(["0001"]);
  });
});

// The prefix invariant catches history changed by hand rather than through
// this tool: up() only ever applies in order, so under normal operation the
// applied set can only ever BE a prefix of what is on disk. A ledger row
// inserted or deleted directly against the database breaks that — a gap that
// none of the per-row checks above would ever catch, since 0002's own row is
// perfectly consistent with its own file.
describe("the applied ledger must be an exact, ordered prefix of disk", () => {
  it("REFUSES status/up/down when disk has 0001+0002 but only 0002 is recorded applied", async () => {
    await pool.query("DROP TABLE IF EXISTS schema_migrations, drift_a, drift_b");
    await resetDir();
    await migrate.up(migDir);
    // Simulate a hand-edited ledger: delete the 0001 row while leaving 0002's,
    // which is exactly the gap the per-row checks cannot see — 0002's row
    // still names the right file with the right checksum.
    await pool.query("DELETE FROM schema_migrations WHERE version = '0001'");

    await expect(migrate.status(migDir)).rejects.toThrow(/not an exact, ordered prefix/);
    await expect(migrate.up(migDir)).rejects.toThrow(/not an exact, ordered prefix/);
    await expect(migrate.down(migDir)).rejects.toThrow(/not an exact, ordered prefix/);

    // None of the three may have changed anything while refusing.
    const led = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(led.rows.map((r) => r.version)).toEqual(["0002"]);
    const b = await pool.query("SELECT to_regclass('public.drift_b') AS t");
    expect(b.rows[0].t).toBe("drift_b");
  });
});
