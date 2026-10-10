// Rehearse pending migrations against a scratch database before they go
// anywhere near production.
//
//   node scripts/migrate-rehearse.mjs                              # schema.sql shape, real migrations/
//   node scripts/migrate-rehearse.mjs prod-dump.sql                # production-shaped data
//   node scripts/migrate-rehearse.mjs prod-dump.sql --migrations-dir=/path/to/fixture
//
// A dump argument is the honest rehearsal: migrations that pass on an empty
// schema can still fail on real data (a NOT NULL backfill with existing NULLs,
// a UNIQUE index over existing duplicates). Take the dump with pg_dump, or a
// Neon branch, and pass the file.
//
// --migrations-dir exists for scripts/migrate-rehearse-test.mjs, which drives
// this exact script end to end against a fixture directory rather than the
// real one. Production rehearsals never pass it and get the real
// litmus-server/migrations.
//
// The rehearsal proves BOTH directions, and it proves them on the right set.
// It reads the ledger before and after applying, reverses exactly the
// versions THIS run added, newest first, and then re-applies. A migration
// whose .down.sql has never run is a rollback plan nobody has tested; a
// rehearsal that reversed migrations the dump already contained would be
// rehearsing a rollback of production history nobody asked for.

import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "litmus-server");
const REAL_MIGRATIONS_DIR = path.join(SERVER, "migrations");
const serverRequire = createRequire(path.join(SERVER, "package.json"));
const EmbeddedPostgres = serverRequire("embedded-postgres").default;

// --- argument parsing --------------------------------------------------
// Positional: an optional dump path. Flag: --migrations-dir=PATH. Order does
// not matter; the dump is whichever non-flag argument is present.
const rawArgs = process.argv.slice(2);
let dumpArg = null;
let migrationsDirArg = null;
for (const a of rawArgs) {
  if (a.startsWith("--migrations-dir=")) migrationsDirArg = a.slice("--migrations-dir=".length);
  else if (!a.startsWith("--")) dumpArg = a;
}

// Resolved against the ORIGINAL cwd, before anything runs with cwd=SERVER. A
// relative dump path would otherwise be looked up inside litmus-server and
// reported as missing, or worse, silently resolve to a different file.
const dump = dumpArg ? path.resolve(process.cwd(), dumpArg) : null;
if (dump && !existsSync(dump)) {
  console.error(`dump not found: ${dumpArg} (resolved to ${dump})`);
  process.exit(1);
}
const migrationsDir = migrationsDirArg
  ? path.resolve(process.cwd(), migrationsDirArg)
  : REAL_MIGRATIONS_DIR;
if (!existsSync(migrationsDir)) {
  console.error(`migrations directory not found: ${migrationsDir}`);
  process.exit(1);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A free port claimed a moment ago can still lose a race to another process —
// "truthful" here means the rehearsal does not let that present as a generic,
// unexplained postgres crash. One retry on a fresh port before giving up.
async function startOnFreePort(build) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const port = await freePort();
    const pg = build(port);
    try {
      await pg.initialise();
      await pg.start();
      return { pg, port };
    } catch (err) {
      const msg = err?.message ?? String(err);
      const collided = /EADDRINUSE|already in use|bind/i.test(msg);
      await pg.stop().catch(() => {});
      if (collided && attempt < 2) {
        console.log(`  port ${port} was claimed by something else between probe and start; retrying with a new port`);
        continue;
      }
      throw new Error(
        collided
          ? `port ${port} was unavailable on both attempts: ${msg}`
          : `embedded postgres failed to start on port ${port}: ${msg}`,
      );
    }
  }
  throw new Error("unreachable"); // satisfies control-flow analysis; the loop always returns or throws
}

function run(cmd, args, { migrationsDir: mdir } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: SERVER,
      env: {
        ...process.env,
        DATABASE_URL: dsn,
        LITMUS_ISOLATED: "1",
        // Set explicitly, never left to whatever the calling shell happened to
        // export. An inherited LITMUS_MIGRATIONS_DIR from a previous test run
        // or a stray export would otherwise silently redirect this rehearsal
        // at the wrong directory.
        LITMUS_MIGRATIONS_DIR: mdir ?? migrationsDir,
      },
      stdio: "inherit",
    });
    // A spawn failure (bad binary, ENOENT) fires 'error', not 'close', and
    // without this handler it crashes the whole rehearsal with an unhandled
    // exception instead of a clear "this command could not even start".
    child.on("error", (err) => {
      console.error(`failed to start ${cmd} ${args.join(" ")}: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code));
  });
}

// Discovery must be able to FAIL. Returning 0 on an unreadable directory would
// mean "no migrations", so a typo in a path would make the rehearsal pass by
// rehearsing nothing.
async function migrationsOnDisk() {
  let files;
  try {
    files = await readdir(migrationsDir);
  } catch (err) {
    throw new Error(`cannot read ${migrationsDir}: ${err.code ?? err.message}`);
  }
  return files.filter((f) => f.endsWith(".up.sql")).length;
}

// The ledger is the only honest record of what this rehearsal added. Counting
// .up.sql files conflates "on disk" with "applied by this run", which is wrong
// the moment a dump arrives carrying its own applied history.
async function appliedVersions(client) {
  const { rows } = await client.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  if (!rows[0].present) return [];
  const r = await client.query("SELECT version FROM schema_migrations ORDER BY version");
  return r.rows.map((x) => x.version);
}

const dataDir = await mkdtemp(path.join(tmpdir(), "litmus-rehearse-"));
let dsn = "";
let pg = null;
let code = 1;

try {
  ({ pg } = await startOnFreePort((p) => {
    dsn = `postgres://litmus:litmus@127.0.0.1:${p}/litmus`;
    return new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "litmus",
      password: "litmus",
      port: p,
      persistent: false,
    });
  }));
  await pg.createDatabase("litmus");
  console.log(`rehearsal database ready (${dataDir})`);
  console.log(`migrations directory: ${migrationsDir}\n`);

  if (dump) {
    console.log(`restoring ${dump} ...`);
    // Through the `pg` driver, not a shelled-out psql: embedded-postgres ships
    // only server binaries (postgres, pg_ctl, initdb), no client tools, so a
    // dependency on psql/pg_dump being separately installed made this path
    // untestable and possibly unusable wherever that is not already on PATH.
    // A bonus, not just a workaround: Postgres's simple-query protocol stops
    // at the first error in a multi-statement string sent this way, which is
    // the ON_ERROR_STOP=1 behaviour this comment used to ask psql for — a
    // restore that fails halfway must not look like a success and proceed
    // against a half-populated database.
    const sql = await readFile(dump, "utf-8");
    const { Client } = serverRequire("pg");
    const restoreClient = new Client({ connectionString: dsn });
    await restoreClient.connect();
    try {
      await restoreClient.query(sql);
    } finally {
      await restoreClient.end();
    }
  } else {
    console.log("no dump given — rehearsing against a bare schema.sql database");
    console.log("(a real rehearsal uses production-shaped data; see the header)\n");
    const init = await run("npm", ["run", "db:init:node"]);
    if (init !== 0) throw new Error(`schema init failed with exit ${init}`);
  }

  const onDisk = await migrationsOnDisk();
  const { Client } = serverRequire("pg");
  const client = new Client({ connectionString: dsn });
  await client.connect();
  const before = await appliedVersions(client);
  console.log(
    `\n${onDisk} migration file(s) on disk; ${before.length} already applied in the baseline` +
      (before.length ? ` (${before.join(", ")})` : ""),
  );

  if (onDisk === 0) {
    console.log("nothing to rehearse");
    code = 0;
  } else {
    console.log("\n--- status before ---");
    await run("npm", ["run", "migrate:status"]);

    console.log("\n--- applying ---");
    code = await run("npm", ["run", "migrate:up"]);

    if (code === 0) {
      const after = await appliedVersions(client);
      const added = after.filter((v) => !before.includes(v));
      console.log(
        `\n--- this rehearsal added ${added.length} migration(s): ${added.join(", ") || "none"} ---`,
      );

      console.log("\n--- status after ---");
      await run("npm", ["run", "migrate:status"]);

      // Reverse exactly what this run added, newest first. The baseline the
      // dump arrived with is production history and is not ours to roll back.
      if (added.length === 0) {
        console.log("nothing was added, so nothing to reverse");
      } else {
        console.log(`\n--- reversing ${added.length} added migration(s), newest first ---`);
        for (let i = 0; i < added.length && code === 0; i++) {
          code = await run("npm", ["run", "migrate:down"]);
          if (code !== 0) console.log(`\nreverse ${i + 1} of ${added.length} FAILED`);
        }

        if (code === 0) {
          const remaining = await appliedVersions(client);
          const baselineIntact = before.every((v) => remaining.includes(v));
          const addedGone = added.every((v) => !remaining.includes(v));
          if (!baselineIntact) {
            console.log(
              `\nREVERSAL WENT TOO FAR: baseline ${before.join(", ")} is no longer fully applied ` +
                `(now ${remaining.join(", ") || "none"})`,
            );
            code = 1;
          } else if (!addedGone) {
            console.log(`\nREVERSAL INCOMPLETE: still applied ${remaining.join(", ")}`);
            code = 1;
          }
        }

        if (code === 0) {
          console.log("\n--- re-applying ---");
          code = await run("npm", ["run", "migrate:up"]);
        }
      }
    }
  }
  await client.end().catch(() => {});
} catch (err) {
  console.error(`rehearsal error: ${err.message}`);
  code = 1;
} finally {
  await pg?.stop().catch(() => {});
  await rm(dataDir, { recursive: true, force: true });
}

console.log(
  code === 0
    ? "\nREHEARSAL PASSED: every migration this run added was applied, reversed, and re-applied; the baseline was left alone.\n"
    : "\nREHEARSAL FAILED — do not apply to production.\n",
);
process.exit(code);
