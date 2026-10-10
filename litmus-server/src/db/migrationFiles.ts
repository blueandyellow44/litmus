// Pure migration-file logic: what is on disk, in what order, with which
// reverse. No database, no env — so it can be tested without a connection, and
// so a tool that only wants to LIST migrations does not open a pool to do it.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "..", "migrations");

export interface Migration {
  version: string;
  name: string;
  upPath: string;
  downPath: string | null;
  // Present only when this migration explicitly declares it has no automatic
  // reverse. Mutually exclusive with downPath — see loadMigrations.
  irreversibleNote: string | null;
}

// Cheap, stable content stamp. Its job is to catch an applied migration being
// edited afterwards, not to resist tampering.
export function checksum(sql: string): string {
  let h = 0;
  for (let i = 0; i < sql.length; i++) h = (Math.imul(31, h) + sql.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

// EXACTLY four digits, not "four or more". Sorting relies on every version
// being the same width — lexical string sort of equal-width numeric strings
// IS correct numeric order — and that only holds forever if a fifth digit can
// never appear. "\d{4,}" let 10000 sort lexically BEFORE 9999 ('1' < '9'),
// silently reversing history past the ten-thousandth migration. Locking the
// width to exactly four makes that case impossible to reach rather than
// something to get right in a comparator.
const VERSION_RE = /^\d{4}$/;

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    // Returning [] here read as "no migrations", so a typo in the path or an
    // unreadable directory looked exactly like a project that had none — and
    // migrate:up would cheerfully report nothing to do.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `Migrations directory does not exist: ${dir}. Create it, or pass the correct path.`,
      );
    }
    throw new Error(`Migrations directory is unreadable (${code ?? "unknown error"}): ${dir}`);
  }

  const ups = files.filter((f) => f.endsWith(".up.sql")).sort();
  const migrations = await Promise.all(
    ups.map(async (f) => {
      const base = f.slice(0, -".up.sql".length);
      const version = base.split("_")[0] ?? base;
      const downName = `${base}.down.sql`;
      const irreversibleName = `${base}.irreversible`;
      const hasDown = files.includes(downName);
      const hasIrreversible = files.includes(irreversibleName);

      if (hasDown && hasIrreversible) {
        throw new Error(
          `${base} has both ${downName} and ${irreversibleName}. A migration is either ` +
            "reversible (has a .down.sql) or explicitly irreversible (has a .irreversible " +
            "note) — not both, since that leaves it ambiguous which one down() should trust.",
        );
      }

      let irreversibleNote: string | null = null;
      if (hasIrreversible) {
        const raw = await readFile(join(dir, irreversibleName), "utf-8");
        irreversibleNote = raw.trim();
        if (irreversibleNote === "") {
          throw new Error(
            `${irreversibleName} is empty. An irreversible migration must explain WHY it has ` +
              "no automatic reverse and what manual recovery requires — the file exists to be " +
              "read during an incident, not merely to satisfy a presence check.",
          );
        }
      }

      return {
        version,
        name: base,
        upPath: join(dir, f),
        downPath: hasDown ? join(dir, downName) : null,
        irreversibleNote,
      };
    }),
  );

  const malformed = migrations.filter((m) => !VERSION_RE.test(m.version));
  if (malformed.length > 0) {
    throw new Error(
      `Migration filenames must start with an exactly four-digit, zero-padded version ` +
        `(0001_name.up.sql). Malformed: ${malformed.map((m) => m.name).join(", ")}`,
    );
  }

  // Two files claiming one version means the ledger cannot say which ran, and
  // whichever sorted second would be skipped forever as "already applied".
  const byVersion = new Map<string, string[]>();
  for (const m of migrations) {
    byVersion.set(m.version, [...(byVersion.get(m.version) ?? []), m.name]);
  }
  const duplicates = [...byVersion.entries()].filter(([, names]) => names.length > 1);
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate migration versions: ${duplicates
        .map(([v, names]) => `${v} (${names.join(" and ")})`)
        .join("; ")}`,
    );
  }

  return migrations;
}
