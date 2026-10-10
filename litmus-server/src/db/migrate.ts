// Migration runner. See migrations/README.md for the rules it enforces.
//
// schema.sql builds a database from nothing and cannot alter one that exists;
// everything that changes an existing database goes through here, in order,
// transactionally, recorded in a ledger.

import { readFile } from "node:fs/promises";
import { pool } from "./client.js";
import { loadMigrations, checksum, type Migration } from "./migrationFiles.js";
import { isLocalDsn } from "../lib/isolation.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

const LEDGER_CREATE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT NOT NULL
  )`;

// Additive columns, added on an existing table via IDEMPOTENT ALTER TABLEs —
// this is what makes an OLD-FORMAT ledger (rows written before these existed)
// compatible rather than a migration blocker in its own right. A row from
// before this upgrade reads back with down_checksum NULL and irreversible
// FALSE, which ledgerDrift treats as "predates tracking, skip the reverse-
// artifact check for this one row" rather than as corruption — retroactively
// verifying a checksum that was never recorded is not possible, and treating
// its absence as an error would fail every existing deployment's ledger the
// first time this code ran.
const LEDGER_ADD_DOWN_CHECKSUM = `
  ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS down_checksum TEXT`;
const LEDGER_ADD_IRREVERSIBLE = `
  ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS irreversible BOOLEAN NOT NULL DEFAULT FALSE`;

interface AppliedRecord {
  name: string;
  checksum: string;
  // null = untracked (old-format row) when irreversible is also false;
  // null = genuinely irreversible when irreversible is true. The two only
  // become distinguishable because irreversible defaults to false on
  // backfill, which is historically accurate — every row old enough to
  // predate this column was applied back when up() already required a
  // .down.sql for everything.
  downChecksum: string | null;
  irreversible: boolean;
}
type Applied = Map<string, AppliedRecord>;

async function ledgerColumnExists(column: string): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = $1
     ) AS present`,
    [column],
  );
  return rows[0]?.present ?? false;
}

// Read the ledger WITHOUT creating or altering it — pure introspection via
// information_schema, never DDL. `migrate:status` against a database it is
// not authorized to write was still issuing CREATE TABLE IF NOT EXISTS, so
// merely asking what had been applied left a table behind; the same principle
// extends to the two ADD COLUMN statements below, which only ever run from
// appliedForWrite.
async function appliedReadOnly(): Promise<Applied> {
  const { rows: exists } = await pool.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  if (!exists[0]?.present) return new Map();

  const hasDownChecksum = await ledgerColumnExists("down_checksum");
  const hasIrreversible = await ledgerColumnExists("irreversible");

  const cols = ["version", "name", "checksum"];
  if (hasDownChecksum) cols.push("down_checksum");
  if (hasIrreversible) cols.push("irreversible");

  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT ${cols.join(", ")} FROM schema_migrations ORDER BY version`,
  );
  return new Map(
    rows.map((r) => [
      r.version as string,
      {
        name: r.name as string,
        checksum: r.checksum as string,
        downChecksum: hasDownChecksum ? ((r.down_checksum as string | null) ?? null) : null,
        irreversible: hasIrreversible ? Boolean(r.irreversible) : false,
      },
    ]),
  );
}

// Create-then-read, for the paths that are about to write anyway. The caller
// must have passed assertWritableTarget before reaching this. Upgrading the
// ledger's shape happens here, on the already-privileged write path — never
// on the read-only one.
async function appliedForWrite(): Promise<Applied> {
  await pool.query(LEDGER_CREATE);
  await pool.query(LEDGER_ADD_DOWN_CHECKSUM);
  await pool.query(LEDGER_ADD_IRREVERSIBLE);
  return appliedReadOnly();
}

function assertWritableTarget(action: string): void {
  if (isLocalDsn(env.DATABASE_URL)) return;
  if ((process.env.ALLOW_PROD_MIGRATE ?? "").trim() === "1") {
    logger.warn(`${action} against a REMOTE database, permitted by ALLOW_PROD_MIGRATE=1`);
    return;
  }
  throw new Error(
    `${action} targets a non-local database. Take a backup, rehearse the migration, ` +
      "then re-run with ALLOW_PROD_MIGRATE=1.",
  );
}

// Every way the ledger and the directory can disagree about history.
//
// The database's record of what ran is only meaningful if the files that ran
// are still there, unchanged, under the same names, with the same reverse. If
// they are not, the tool does not know what state the schema is in — and a
// tool that does not know must not act, least of all reverse something.
//
// This is shared by status, up and down so all three agree on what drift is.
// Three commands with three opinions about it would be its own kind of drift.
export async function ledgerDrift(all: Migration[], done: Applied): Promise<string[]> {
  const onDisk = new Map(all.map((m) => [m.version, m]));
  const problems: string[] = [];

  for (const [version, rec] of [...done.entries()].sort()) {
    const m = onDisk.get(version);
    if (!m) {
      problems.push(
        `${rec.name} (version ${version}) is recorded as applied but no file with that ` +
          "version is on disk. It was deleted or renamed; the schema contains a change " +
          "this repository can no longer describe or reverse.",
      );
      continue;
    }
    if (m.name !== rec.name) {
      problems.push(
        `version ${version} is recorded as "${rec.name}" but the file on disk is ` +
          `"${m.name}". Renaming an applied migration breaks the ledger's only link to it.`,
      );
      continue;
    }
    const current = checksum(await readFile(m.upPath, "utf-8"));
    if (current !== rec.checksum) {
      problems.push(
        `${m.name} was edited after it was applied (checksum ${rec.checksum} -> ${current}). ` +
          "Write a new migration instead of changing an applied one.",
      );
    }

    // Reverse-artifact integrity. Skipped entirely for a row whose reverse was
    // never tracked (old-format ledger, downChecksum null AND irreversible
    // false) — that is a documented gap, not a finding.
    if (rec.downChecksum !== null) {
      if (rec.irreversible) {
        problems.push(
          `${m.name}'s ledger row carries both a down_checksum and irreversible=true, which ` +
            "cannot both be true of the same applied migration — the ledger itself is inconsistent.",
        );
      } else if (m.irreversibleNote) {
        problems.push(
          `${m.name} was reversible when it was applied but is now marked irreversible on disk ` +
            "(a .irreversible file was added after the fact). Reversibility must not change once " +
            "a migration has run — write a new migration instead.",
        );
      } else if (!m.downPath) {
        problems.push(`${m.name}'s .down.sql was deleted after it was applied.`);
      } else {
        const currentDown = checksum(await readFile(m.downPath, "utf-8"));
        if (currentDown !== rec.downChecksum) {
          problems.push(
            `${m.name}'s .down.sql was modified after it was applied ` +
              `(checksum ${rec.downChecksum} -> ${currentDown}).`,
          );
        }
      }
    } else if (rec.irreversible) {
      if (!m.irreversibleNote) {
        problems.push(
          `${m.name} was applied as irreversible but no longer carries a .irreversible note on ` +
            "disk (it was removed, or replaced with a .down.sql without a new migration).",
        );
      }
    }
  }

  // PREFIX invariant: the applied set, sorted, must equal exactly the first N
  // on-disk migrations, no gaps. up() only ever applies in order and refuses
  // when drift already exists, so under normal operation through this tool
  // the ledger can only be a prefix — this catches history that was changed
  // some OTHER way (a ledger row inserted or deleted by hand).
  const sortedOnDiskVersions = [...all].map((m) => m.version).sort();
  const sortedAppliedVersions = [...done.keys()].sort();
  const expectedPrefix = sortedOnDiskVersions.slice(0, sortedAppliedVersions.length);
  const isPrefix = expectedPrefix.every((v, i) => v === sortedAppliedVersions[i]);
  if (!isPrefix) {
    problems.push(
      `the applied ledger (${sortedAppliedVersions.join(", ") || "none"}) is not an exact, ` +
        `ordered prefix of the migrations on disk (${sortedOnDiskVersions.join(", ") || "none"}). ` +
        "A ledger row for an earlier version is missing, or migrations were applied out of order.",
    );
  }

  return problems;
}

function refuseOnDrift(command: string, problems: string[]): void {
  if (problems.length === 0) return;
  for (const p of problems) logger.error(`LEDGER DRIFT  ${p}`);
  // The reasons go INTO the error, not only into the log. An error that says
  // "3 problems, listed above" is useless to anything that catches it, and the
  // rehearsal and the tests both catch it.
  throw new Error(
    `${command} refuses to run: the ledger and the migrations directory disagree about ` +
      `history (${problems.length} problem(s)). Reconcile them first.\n  - ` +
      problems.join("\n  - "),
  );
}

export async function status(dir?: string): Promise<void> {
  const [all, done] = await Promise.all([loadMigrations(dir), appliedReadOnly()]);

  for (const m of all) {
    const rec = done.get(m.version);
    if (!rec) {
      logger.info(`PENDING  ${m.name}`);
      continue;
    }
    logger.info(`applied  ${m.name}${m.irreversibleNote ? " (irreversible)" : ""}`);
  }
  const pending = all.filter((m) => !done.has(m.version));
  logger.info("migration status", {
    onDisk: all.length,
    applied: done.size,
    pending: pending.length,
  });

  // Reporting drift and then exiting 0 is how drift survives: a status command
  // that prints a problem and succeeds gets read as "fine". This throws, which
  // migrateCron turns into a non-zero exit, while still having written nothing
  // — refuseOnDrift is reached only after every query above, all of them reads.
  refuseOnDrift("migrate:status", await ledgerDrift(all, done));

  if (all.length === 0) logger.info("no migrations on disk");
}

export async function up(dir?: string): Promise<void> {
  // Authorization comes FIRST, before any query that can leave a trace. The
  // ledger read used to create schema_migrations, so an unauthorized
  // `migrate:up` against production still altered it before printing its
  // refusal — a refusal that had already written to the thing it was refusing
  // to touch.
  assertWritableTarget("migrate:up");

  const all = await loadMigrations(dir);
  const done = await appliedForWrite();
  const pending = all.filter((m) => !done.has(m.version));

  // Applying the next migration on top of a history the tool cannot account
  // for compounds the problem rather than revealing it.
  refuseOnDrift("migrate:up", await ledgerDrift(all, done));

  if (pending.length === 0) {
    logger.info("nothing to apply");
    return;
  }

  // Every pending migration must declare how it can be undone: a working
  // .down.sql, or an explicit, non-empty .irreversible note. Finding out
  // during an incident that a change has no reverse — and no explanation of
  // why — is finding out too late.
  const undeclared = pending.filter((m) => !m.downPath && !m.irreversibleNote);
  if (undeclared.length > 0) {
    throw new Error(
      `These migrations declare no reverse: ${undeclared.map((m) => m.name).join(", ")}. ` +
        "Write a .down.sql, or add a NNNN_name.irreversible file explaining why there is no " +
        "automatic reverse and what manual recovery requires.",
    );
  }

  logger.info("plan", { apply: pending.map((m) => m.name) });

  for (const m of pending) {
    const sql = await readFile(m.upPath, "utf-8");
    const isIrreversible = m.irreversibleNote !== null;
    const downChecksumValue = isIrreversible
      ? null
      : checksum(await readFile(m.downPath!, "utf-8"));

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version, name, checksum, down_checksum, irreversible) " +
          "VALUES ($1, $2, $3, $4, $5)",
        [m.version, m.name, checksum(sql), downChecksumValue, isIrreversible],
      );
      await client.query("COMMIT");
      logger.info(`applied ${m.name}${isIrreversible ? " (irreversible)" : ""}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error(`FAILED ${m.name} — rolled back, ledger unchanged`, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      client.release();
    }
  }

  // A final check verifies the WHOLE run, not just each statement's own
  // success: the ledger after every insert must be exactly the on-disk set up
  // to and including the last migration just applied. Each INSERT succeeding
  // individually is not the same guarantee as the aggregate ending up right.
  const after = await appliedReadOnly();
  const expected = all.filter((m) => done.has(m.version) || pending.some((p) => p.version === m.version));
  const expectedVersions = expected.map((m) => m.version).sort();
  const actualVersions = [...after.keys()].sort();
  if (JSON.stringify(expectedVersions) !== JSON.stringify(actualVersions)) {
    throw new Error(
      `migrate:up applied without error, but the ledger afterward (${actualVersions.join(", ")}) ` +
        `does not match what should now be applied (${expectedVersions.join(", ")}). Investigate ` +
        "before running anything else.",
    );
  }
}

export async function down(dir?: string): Promise<void> {
  assertWritableTarget("migrate:down");

  const all = await loadMigrations(dir);
  const done = await appliedReadOnly();

  // Drift is checked before anything is chosen, because the most dangerous
  // version of this command is the one that quietly reverses the WRONG
  // migration. An earlier implementation walked the on-disk list and took the
  // last one the ledger knew about, so if the newest applied migration had
  // been deleted or renamed, down would silently reverse the one before it —
  // undoing a change nobody asked about while leaving the newest applied.
  refuseOnDrift("migrate:down", await ledgerDrift(all, done));

  // Choose from the LEDGER, which is the record of what actually ran, and then
  // require the file. Choosing from disk is what allowed the wrong pick.
  const newestApplied = [...done.keys()].sort().at(-1);
  if (!newestApplied) {
    logger.info("nothing to reverse");
    return;
  }
  const last = all.find((m) => m.version === newestApplied);
  if (!last) {
    // ledgerDrift has already thrown for this, so reaching here means the two
    // disagree about what "missing" means. Refuse rather than guess.
    throw new Error(
      `the newest applied migration (version ${newestApplied}) is not on disk; refusing to reverse anything else`,
    );
  }

  // An irreversible migration is refused HERE, before any query runs and
  // before the ledger row is touched. Running a comment-only "reverse" would
  // have succeeded as a no-op SQL statement and then deleted the ledger row —
  // claiming the schema was rolled back when nothing about it had changed,
  // which is worse than refusing: the tool would believe a state that is not
  // true.
  if (last.irreversibleNote) {
    throw new Error(
      `${last.name} is marked irreversible and cannot be reversed automatically. The ledger row ` +
        `is left exactly as it was.\n\n${last.irreversibleNote}`,
    );
  }
  if (!last.downPath) {
    throw new Error(`${last.name} has no .down.sql; it cannot be reversed automatically`);
  }

  const sql = await readFile(last.downPath, "utf-8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [last.version]);
    await client.query("COMMIT");
    logger.info(`reversed ${last.name}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
