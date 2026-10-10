import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { stopTestDatabase } from "./testDatabase.js";

// Contract test for the migration runner against a real database: apply,
// record, reverse, un-record. A migration tool that has only ever been run
// forward has an untested rollback, which is the same as no rollback.
//
// Port is deliberately not 5432 so this can never touch a dev instance, and
// DATABASE_URL is set before the modules are imported because db/client.ts
// reads it at import time.

// A free port, claimed at run time. A fixed one collides with anything else
// bound to it — including a previous run of this same suite that did not shut
// down cleanly — and the failure reads as a broken test rather than a busy port.
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

let DSN: string;

let pg: EmbeddedPostgres;
let dataDir: string;
let migDir: string;
let migrate: typeof import("./migrate.js");
let pool: typeof import("./client.js")["pool"];

// One embedded database and one `pool`/`migrate` module pair for the WHOLE
// file, set up here at file scope rather than inside any one describe.
// db/client.ts creates its pool once at first import and caches that module
// instance under ESM's module cache — a second `describe` that tried to spin
// up its own embedded postgres and re-import "./client.js" got back the exact
// same (already `.end()`ed) pool object, not a fresh one, which is why this
// lives above every describe instead of being duplicated inside each.
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "litmus-migtest-pg-"));
  migDir = await mkdtemp(path.join(tmpdir(), "litmus-migtest-sql-"));

  await writeFile(
    path.join(migDir, "0001_add_probe.up.sql"),
    "CREATE TABLE migration_probe (id INT PRIMARY KEY);",
  );
  await writeFile(path.join(migDir, "0001_add_probe.down.sql"), "DROP TABLE migration_probe;");
  // A migration that must fail, to prove a failure leaves no ledger row. It
  // carries a reverse because up() now refuses irreversible pending
  // migrations before it applies anything, and this test is about the
  // transaction, not about that guard.
  await writeFile(path.join(migDir, "0002_broken.up.sql"), "THIS IS NOT SQL;");
  await writeFile(path.join(migDir, "0002_broken.down.sql"), "SELECT 1;");

  const port = await freePort();
  DSN = `postgres://litmus:litmus@127.0.0.1:${port}/litmus`;
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

  process.env.DATABASE_URL = DSN;
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

describe("migration runner (contract)", () => {
  // Ordered first deliberately: it must run against a database where no
  // migration has been applied, and it proves a read command has no write
  // side effect. status() used to CREATE TABLE IF NOT EXISTS the ledger, so
  // looking before you leap left a table behind.
  it("status does NOT create the ledger table", async () => {
    const before = await pool.query("SELECT to_regclass('public.schema_migrations') AS t");
    expect(before.rows[0].t).toBeNull();

    await migrate.status(migDir);

    const after = await pool.query("SELECT to_regclass('public.schema_migrations') AS t");
    expect(after.rows[0].t).toBeNull();
  });

  it("applies a migration and records it in the ledger", async () => {
    await migrate.up(migDir).catch(() => {
      // 0002 is expected to fail; 0001 must still have applied.
    });
    const probe = await pool.query("SELECT to_regclass('public.migration_probe') AS t");
    expect(probe.rows[0].t).toBe("migration_probe");

    const led = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(led.rows.map((r) => r.version)).toEqual(["0001"]);
  });

  it("leaves no ledger row for a migration that failed", async () => {
    const led = await pool.query("SELECT version FROM schema_migrations WHERE version = '0002'");
    expect(led.rowCount).toBe(0);
  });

  it("REFUSES a pending migration that has no reverse, before applying anything", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-noreverse-"));
    await writeFile(path.join(d, "0009_no_way_back.up.sql"), "CREATE TABLE never_created (id INT);");

    // The ledger is global while the migrations directory is an argument, so
    // pointing up() at a DIFFERENT directory is itself drift: 0001 is applied
    // and is not in this one. That check is correct and fires first, so the
    // ledger is borrowed and PUT BACK — the following test reverses 0001 and
    // needs it still recorded.
    const saved = await pool.query(
      "SELECT version, name, checksum, down_checksum, irreversible FROM schema_migrations",
    );
    await pool.query("DELETE FROM schema_migrations");
    try {
      await expect(migrate.up(d)).rejects.toThrow(/declare no reverse.*0009_no_way_back/s);

      const probe = await pool.query("SELECT to_regclass('public.never_created') AS t");
      expect(probe.rows[0].t).toBeNull();
    } finally {
      for (const r of saved.rows) {
        await pool.query(
          "INSERT INTO schema_migrations (version, name, checksum, down_checksum, irreversible) VALUES ($1, $2, $3, $4, $5)",
          [r.version, r.name, r.checksum, r.down_checksum, r.irreversible],
        );
      }
      await rm(d, { recursive: true, force: true });
    }
  });

  it("reverses the last migration and un-records it", async () => {
    await migrate.down(migDir);
    const probe = await pool.query("SELECT to_regclass('public.migration_probe') AS t");
    expect(probe.rows[0].t).toBeNull();

    const led = await pool.query("SELECT version FROM schema_migrations");
    expect(led.rowCount).toBe(0);
  });
});

// An irreversible migration must apply cleanly and then refuse down() without
// touching the ledger row — the whole point of the marker is that "reverse"
// is not a safe operation to attempt, not even to try and fail loudly.
describe("irreversible migration lifecycle", () => {
  let d: string;

  beforeAll(async () => {
    // Reuses the shared pool/migrate set up at file scope above — do not spin
    // up a second embedded postgres or re-import "./client.js" here.
    d = await mkdtemp(path.join(tmpdir(), "litmus-irrev-lifecycle-"));
    await writeFile(path.join(d, "0001_purge.up.sql"), "CREATE TABLE irrev_probe (id INT);");
    await writeFile(
      path.join(d, "0001_purge.irreversible"),
      "This drops data with no backup taken in this test; recovery is out of scope here.",
    );
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS irrev_probe");
    await pool.query("DELETE FROM schema_migrations WHERE version = '0001' AND name = '0001_purge'");
    await rm(d, { recursive: true, force: true });
  });

  it("applies an irreversible migration and records irreversible=true", async () => {
    await migrate.up(d);
    const probe = await pool.query("SELECT to_regclass('public.irrev_probe') AS t");
    expect(probe.rows[0].t).toBe("irrev_probe");

    const led = await pool.query(
      "SELECT down_checksum, irreversible FROM schema_migrations WHERE version = '0001'",
    );
    expect(led.rows[0].down_checksum).toBeNull();
    expect(led.rows[0].irreversible).toBe(true);
  });

  it("REFUSES down() and leaves the ledger row exactly as it was", async () => {
    const before = await pool.query("SELECT * FROM schema_migrations WHERE version = '0001'");

    await expect(migrate.down(d)).rejects.toThrow(/marked irreversible and cannot be reversed/);

    const probe = await pool.query("SELECT to_regclass('public.irrev_probe') AS t");
    expect(probe.rows[0].t).toBe("irrev_probe");
    const after = await pool.query("SELECT * FROM schema_migrations WHERE version = '0001'");
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

// A ledger row written before down_checksum/irreversible existed must upgrade
// gracefully rather than reading as corruption — retroactively verifying a
// checksum that was never recorded is not possible, and treating its absence
// as an error would fail every existing deployment's ledger the first time
// this code ran against it.
describe("old-format ledger rows upgrade without false-positive drift", () => {
  let d: string;

  beforeAll(async () => {
    d = await mkdtemp(path.join(tmpdir(), "litmus-oldformat-"));
    await writeFile(path.join(d, "0001_legacy.up.sql"), "CREATE TABLE legacy_probe (id INT);");
    await writeFile(path.join(d, "0001_legacy.down.sql"), "DROP TABLE legacy_probe;");

    // Recreate the PRE-upgrade ledger shape by hand: only the three original
    // columns, then insert a row exactly as the old code would have, with no
    // down_checksum/irreversible columns to write to at all.
    await pool.query("DROP TABLE IF EXISTS schema_migrations, legacy_probe CASCADE");
    await pool.query(`
      CREATE TABLE schema_migrations (
        version    TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum   TEXT NOT NULL
      )`);
    await pool.query("CREATE TABLE legacy_probe (id INT)");
    const sql = await readFile(path.join(d, "0001_legacy.up.sql"), "utf-8");
    const { checksum: cs } = await import("./migrationFiles.js");
    await pool.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
      "0001",
      "0001_legacy",
      cs(sql),
    ]);
  });

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS legacy_probe");
    await pool.query("DELETE FROM schema_migrations WHERE version = '0001' AND name = '0001_legacy'");
    await rm(d, { recursive: true, force: true });
  });

  it("status reads the old-format row with no drift, purely via introspection", async () => {
    await migrate.status(d); // must not throw
    // Read-only: the ADD COLUMN upgrade only ever runs from the write path.
    const cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'schema_migrations'",
    );
    expect(cols.rows.map((r) => r.column_name)).not.toContain("down_checksum");
  });

  it("up() upgrades the ledger's shape and leaves the old row's checksum untouched", async () => {
    await migrate.up(d); // nothing pending; must not throw over the old row
    const led = await pool.query(
      "SELECT checksum, down_checksum, irreversible FROM schema_migrations WHERE version = '0001'",
    );
    expect(led.rows[0].down_checksum).toBeNull();
    expect(led.rows[0].irreversible).toBe(false);

    const { checksum: cs } = await import("./migrationFiles.js");
    const sql = await readFile(path.join(d, "0001_legacy.up.sql"), "utf-8");
    expect(led.rows[0].checksum).toBe(cs(sql));
  });
});
