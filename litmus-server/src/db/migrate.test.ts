import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMigrations } from "./migrationFiles.js";

// Ordering is the whole contract: migration 10 must not sort before migration 2,
// and a migration missing its reverse must be visible as such rather than
// silently treated as reversible.
describe("loadMigrations", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "litmus-mig-"));
    await writeFile(path.join(dir, "0001_first.up.sql"), "SELECT 1;");
    await writeFile(path.join(dir, "0001_first.down.sql"), "SELECT 1;");
    await writeFile(path.join(dir, "0002_second.up.sql"), "SELECT 1;");
    await writeFile(path.join(dir, "0010_tenth.up.sql"), "SELECT 1;");
    await writeFile(path.join(dir, "notes.md"), "not a migration");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("orders by zero-padded version, not lexical accident", async () => {
    const m = await loadMigrations(dir);
    expect(m.map((x) => x.version)).toEqual(["0001", "0002", "0010"]);
  });

  it("reports a missing down script instead of assuming one", async () => {
    const m = await loadMigrations(dir);
    expect(m.find((x) => x.version === "0001")?.downPath).toBeTruthy();
    expect(m.find((x) => x.version === "0002")?.downPath).toBeNull();
  });

  it("ignores non-migration files", async () => {
    const m = await loadMigrations(dir);
    expect(m).toHaveLength(3);
  });
});

// Every one of these used to return [] or pass silently, which meant a broken
// migrations directory was indistinguishable from an empty one — and migrate:up
// would report "nothing to apply" and exit 0 on a typo'd path.
describe("loadMigrations refuses states it cannot order", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "litmus-mig-bad-"));
  });

  afterAll(async () => {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("REFUSES a directory that does not exist rather than reporting no migrations", async () => {
    await expect(loadMigrations(path.join(dir, "nope"))).rejects.toThrow(/does not exist/);
  });

  it("REFUSES a malformed version", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-malformed-"));
    await writeFile(path.join(d, "add_thing.up.sql"), "SELECT 1;");
    await expect(loadMigrations(d)).rejects.toThrow(/exactly four-digit/);
    await rm(d, { recursive: true, force: true });
  });

  it("REFUSES a version shorter than four digits, which would sort wrong", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-short-"));
    await writeFile(path.join(d, "1_first.up.sql"), "SELECT 1;");
    await expect(loadMigrations(d)).rejects.toThrow(/exactly four-digit/);
    await rm(d, { recursive: true, force: true });
  });

  it("REFUSES two files claiming the same version", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-dupe-"));
    await writeFile(path.join(d, "0001_alpha.up.sql"), "SELECT 1;");
    await writeFile(path.join(d, "0001_beta.up.sql"), "SELECT 1;");
    await expect(loadMigrations(d)).rejects.toThrow(/Duplicate migration versions: 0001/);
    await rm(d, { recursive: true, force: true });
  });

  it("accepts an empty but readable directory as genuinely having no migrations", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-empty-"));
    expect(await loadMigrations(d)).toEqual([]);
    await rm(d, { recursive: true, force: true });
  });
});

// Sorting relies on every version being the same width — lexical string sort
// of equal-width numeric strings is correct numeric order, and "\d{4,}" broke
// that the moment a fifth digit could appear: "10000" sorts BEFORE "9999"
// lexically ('1' < '9'), silently reversing history past the ten-thousandth
// migration. The fix is enforcing the width rather than getting the
// comparator right, which is why these are the two edges that matter.
describe("version width is pinned at exactly four digits", () => {
  it("accepts the maximum four-digit version, 9999", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-9999-"));
    await writeFile(path.join(d, "9999_last.up.sql"), "SELECT 1;");
    const m = await loadMigrations(d);
    expect(m.map((x) => x.version)).toEqual(["9999"]);
    await rm(d, { recursive: true, force: true });
  });

  it("REFUSES a five-digit version, 10000, rather than sorting it wrong", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-10000-"));
    await writeFile(path.join(d, "10000_overflow.up.sql"), "SELECT 1;");
    await expect(loadMigrations(d)).rejects.toThrow(/exactly four-digit/);
    await rm(d, { recursive: true, force: true });
  });

  it("orders 9999 after every real four-digit version when both are present", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-order-"));
    await writeFile(path.join(d, "0001_first.up.sql"), "SELECT 1;");
    await writeFile(path.join(d, "9999_last.up.sql"), "SELECT 1;");
    const m = await loadMigrations(d);
    expect(m.map((x) => x.version)).toEqual(["0001", "9999"]);
    await rm(d, { recursive: true, force: true });
  });
});

// Irreversible migrations: an explicit marker, not the absence of a
// .down.sql, and refusing to be ambiguous with a real reverse.
describe("irreversible migrations", () => {
  it("loads an irreversible migration's note, trimmed", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-irrev-"));
    await writeFile(path.join(d, "0001_data_purge.up.sql"), "DELETE FROM x;");
    await writeFile(
      d + "/0001_data_purge.irreversible",
      "\n  Deleted rows cannot be recovered without a backup taken before this ran.  \n",
    );
    const m = await loadMigrations(d);
    expect(m[0]!.downPath).toBeNull();
    expect(m[0]!.irreversibleNote).toBe(
      "Deleted rows cannot be recovered without a backup taken before this ran.",
    );
    await rm(d, { recursive: true, force: true });
  });

  it("REFUSES an empty irreversible note — it must explain the recovery, not just exist", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-irrev-empty-"));
    await writeFile(path.join(d, "0001_x.up.sql"), "SELECT 1;");
    await writeFile(d + "/0001_x.irreversible", "   \n  ");
    await expect(loadMigrations(d)).rejects.toThrow(/is empty/);
    await rm(d, { recursive: true, force: true });
  });

  it("REFUSES a migration with BOTH a .down.sql and an .irreversible marker", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "litmus-mig-irrev-both-"));
    await writeFile(path.join(d, "0001_x.up.sql"), "SELECT 1;");
    await writeFile(path.join(d, "0001_x.down.sql"), "SELECT 1;");
    await writeFile(d + "/0001_x.irreversible", "explanation");
    await expect(loadMigrations(d)).rejects.toThrow(/has both/);
    await rm(d, { recursive: true, force: true });
  });
});
