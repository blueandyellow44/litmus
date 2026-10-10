import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { stopTestDatabase } from "../testDatabase.js";
import { membershipHash } from "../../stories/identity.js";
import { outletKeyFromName } from "../../ingestion/outletKey.js";

// The Story Ledger against a real database: the migration applies to a
// schema.sql-shaped database, the repo's invariants are the database's
// invariants, and the whole thing reverses. Constraints that only exist in SQL
// (one primary story per article, the merge pointer, the cascades) cannot be
// tested any other way, and a migration whose .down.sql has never run is a
// rollback plan nobody has tested.
//
// Port is deliberately not 5432 so this can never touch a dev instance, and
// DATABASE_URL is set before the modules are imported because db/client.ts
// reads it at import time.

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

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, "..", "schema.sql");
const SEED_PATH = path.join(here, "..", "..", "..", "sources", "seed.json");

let pg: EmbeddedPostgres;
let dataDir: string;
let migrationsDir: string;
let migrate: typeof import("../migrate.js");
let pool: (typeof import("../client.js"))["pool"];
let repo: typeof import("./storiesRepo.js");
let sourcesRepo: typeof import("./sourcesRepo.js");

interface SeedSource {
  name: string;
  rssUrl: string;
  lean: string;
  type: string;
  paywallStatus: string;
  reliability: number;
  prominence?: number;
  outletKey?: string;
}
let seedSources: SeedSource[];

// The pre-migration writer, kept verbatim: it names no outlet_key. Two-phase
// (migrations/README.md rule 2) means this must still work after the migration,
// which is why outlet_key is nullable.
async function insertSourceTheOldWay(s: SeedSource): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sources (name, rss_url, lean, type, paywall_status, reliability, enabled, prominence)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, COALESCE($7, 1.0))
     RETURNING id`,
    [s.name, s.rssUrl, s.lean, s.type, s.paywallStatus, s.reliability, s.prominence ?? null],
  );
  return rows[0]!.id;
}

let sourceId: number;
let nextArticle = 0;

async function insertArticle(): Promise<number> {
  nextArticle += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO articles (source_id, url, title, extraction_status, content_hash)
     VALUES ($1, $2, $3, 'full', $4)
     RETURNING id`,
    [sourceId, `https://example.test/a/${nextArticle}`, `Article ${nextArticle}`, `hash-${nextArticle}`],
  );
  return rows[0]!.id;
}

async function newStory(headline = "Senate passes the stopgap funding bill") {
  return repo.insertStory({ headline, eventStatement: `${headline}, on Friday.`, section: "politics" });
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "litmus-stories-pg-"));
  migrationsDir = path.join(here, "..", "..", "..", "migrations");

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
  migrate = await import("../migrate.js");
  ({ pool } = await import("../client.js"));
  repo = await import("./storiesRepo.js");
  sourcesRepo = await import("./sourcesRepo.js");

  await pool.query(await readFile(SCHEMA_PATH, "utf-8"));
  seedSources = (JSON.parse(await readFile(SEED_PATH, "utf-8")) as { sources: SeedSource[] }).sources;

  // Every roster source, written the pre-migration way, so the backfill has
  // real names to work on.
  for (const s of seedSources) await insertSourceTheOldWay(s);

  await migrate.up(migrationsDir);

  const { rows } = await pool.query<{ id: number }>("SELECT id FROM sources ORDER BY id LIMIT 1");
  sourceId = rows[0]!.id;
}, 180_000);

afterAll(async () => {
  // Waits for the pool's connections to close before the fast shutdown
  // (testDatabase.ts; the 2026-10-09 edition failed on this race).
  await stopTestDatabase({ pool, pg, databaseUrl: process.env.DATABASE_URL });
  await rm(dataDir, { recursive: true, force: true });
});

describe("0001_story_ledger on a schema.sql database", () => {
  it("backfills outlet_key exactly as outletKeyFromName does, for every roster name", async () => {
    const { rows } = await pool.query<{ name: string; outlet_key: string | null }>(
      "SELECT name, outlet_key FROM sources ORDER BY id",
    );
    const disagreements = rows.filter((r) => r.outlet_key !== outletKeyFromName(r.name));
    expect(disagreements.map((r) => r.name)).toEqual([]);
    expect(rows.length).toBe(seedSources.length);
  });

  it("leaves the pre-migration seeder working, with no key rather than a wrong one", async () => {
    const id = await insertSourceTheOldWay({
      name: "Old Writer Gazette",
      rssUrl: "https://example.test/old-writer.xml",
      lean: "center",
      type: "digital-native",
      paywallStatus: "free",
      reliability: 3,
    });
    const { rows } = await pool.query<{ outlet_key: string | null }>(
      "SELECT outlet_key FROM sources WHERE id = $1",
      [id],
    );
    expect(rows[0]!.outlet_key).toBeNull();
    await pool.query("DELETE FROM sources WHERE id = $1", [id]);
  });

  it("stores the seed's explicit key through upsertSource, and reads it back", async () => {
    const bbcWorld = seedSources.find((s) => s.name === "BBC News — World")!;
    const bbcSport = seedSources.find((s) => s.name === "BBC Sport")!;
    const world = await sourcesRepo.upsertSource(bbcWorld as never);
    const sport = await sourcesRepo.upsertSource(bbcSport as never);
    expect(world.outletKey).toBe(bbcWorld.outletKey);
    expect(sport.outletKey).toBe(world.outletKey);
  });

  it("reads a keyless, underivable source instead of failing the whole roster", async () => {
    // The window where outlet_key can be NULL is the two-phase rollback window
    // the nullable column exists for. One unusable row there must not empty
    // listAllSources for every caller.
    const id = await insertSourceTheOldWay({
      name: "———",
      rssUrl: "https://example.test/no-derivable-key.xml",
      lean: "center",
      type: "digital-native",
      paywallStatus: "free",
      reliability: 3,
    });
    const all = await sourcesRepo.listAllSources();
    expect(all.length).toBeGreaterThanOrEqual(seedSources.length);
    expect(all.find((x) => x.id === id)!.outletKey).toBe(`source-${id}`);
    await pool.query("DELETE FROM sources WHERE id = $1", [id]);
  });

  it("REFUSES an outlet key the code would accept nowhere else", async () => {
    await expect(
      pool.query("UPDATE sources SET outlet_key = 'New York Times' WHERE id = $1", [sourceId]),
    ).rejects.toThrow(/sources_outlet_key_format/);
  });
});

describe("runs", () => {
  it("starts open and finishes once, with its counts and usage", async () => {
    const run = await repo.startStoryRun();
    expect(run.finishedAt).toBeNull();
    expect(run.sweepComplete).toBe(false);

    const done = await repo.finishStoryRun(run.id, {
      counts: { offered: 12, attached: 9, new: 3 },
      usage: { inputTokens: 1200, calls: 2 },
      sweepComplete: true,
    });
    expect(done.finishedAt).not.toBeNull();
    expect(done.counts).toEqual({ offered: 12, attached: 9, new: 3 });
    expect(done.usage).toEqual({ inputTokens: 1200, calls: 2 });
    expect(done.sweepComplete).toBe(true);

    // Finishing twice would overwrite the record of what the run did.
    await expect(
      repo.finishStoryRun(run.id, { counts: {}, usage: {}, sweepComplete: false }),
    ).rejects.toThrow(/already finished/);
  });

  it("REFUSES a sweep claimed complete on a run that never finished", async () => {
    const run = await repo.startStoryRun();
    await expect(
      pool.query("UPDATE story_runs SET sweep_complete = TRUE WHERE id = $1", [run.id]),
    ).rejects.toThrow(/story_runs_sweep_needs_finish/);
  });
});

describe("stories", () => {
  it("mints a readable slug and reads back by id and slug", async () => {
    const story = await newStory("Senate passes the stopgap funding bill");
    expect(story.id).toMatch(/^st_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(story.slug).toMatch(/^senate-passes-the-stopgap-funding-bill-[a-z0-9]{6}$/);
    expect(await repo.getStory(story.id)).toEqual(story);
    expect(await repo.getStoryBySlug(story.slug)).toEqual(story);
    expect(await repo.getStory("st_00000000000000000000000000")).toBeNull();
  });

  it("gives two stories with the same headline different addresses", async () => {
    const a = await newStory("Same headline, different day");
    const b = await newStory("Same headline, different day");
    expect(a.id).not.toBe(b.id);
    expect(a.slug).not.toBe(b.slug);
  });

  it("REFUSES an empty headline or event statement before the database has to", async () => {
    await expect(
      repo.insertStory({ headline: "   ", eventStatement: "x", section: null }),
    ).rejects.toThrow(/headline must not be empty/);
    await expect(
      repo.insertStory({ headline: "x", eventStatement: "", section: null }),
    ).rejects.toThrow(/event statement must not be empty/);
  });

  it("records an assessment with the membership it was written for", async () => {
    const story = await newStory("Assessment target");
    const articleId = await insertArticle();
    await repo.addStoryMember({
      storyId: story.id,
      articleId,
      role: "primary",
      kind: "full",
      syndicatedOfArticleId: null,
      confidence: "high",
      reason: "same event",
      addedRunId: null,
    });
    const hash = (await repo.currentMembershipHash(story.id))!;
    expect(hash).toBe(membershipHash([{ articleId, role: "primary", kind: "full" }]));

    const generatedAt = new Date("2026-09-13T18:45:00.000Z");
    const assessed = await repo.setStoryAssessment(story.id, {
      text: "The Senate passed the bill.",
      model: "claude-sonnet-5",
      generatedAt,
      membershipHash: hash,
      touchesPolitics: true,
    });
    expect(assessed.assessment).toEqual({
      text: "The Senate passed the bill.",
      model: "claude-sonnet-5",
      generatedAt,
    });
    expect(assessed.membershipHash).toBe(hash);

    // A new member makes the stored assessment stale, which is the whole point
    // of storing the hash.
    const second = await insertArticle();
    await repo.addStoryMember({
      storyId: story.id,
      articleId: second,
      role: "primary",
      kind: "headline_only",
      syndicatedOfArticleId: null,
      confidence: "medium",
      reason: "same event, headline only",
      addedRunId: null,
    });
    expect(await repo.currentMembershipHash(story.id)).not.toBe(assessed.membershipHash);
  });

  it("REFUSES a half-written assessment at the database level", async () => {
    const story = await newStory("Half assessment");
    await expect(
      pool.query("UPDATE stories SET assessment_text = 'orphan' WHERE id = $1", [story.id]),
    ).rejects.toThrow(/stories_assessment_complete/);
  });

  it("merges into a live story, and refuses every malformed merge", async () => {
    const survivor = await newStory("Survivor story");
    const absorbed = await newStory("Absorbed story");
    const merged = await repo.setStoryStatus(absorbed.id, "merged", survivor.id);
    expect(merged.status).toBe("merged");
    expect(merged.mergedInto).toBe(survivor.id);

    // The absorbed row is kept, so its id still resolves.
    expect(await repo.getStory(absorbed.id)).not.toBeNull();

    const third = await newStory("Third story");
    await expect(repo.setStoryStatus(third.id, "merged", absorbed.id)).rejects.toThrow(/itself merged/);
    await expect(repo.setStoryStatus(absorbed.id, "dormant")).rejects.toThrow(/already merged/);
    await expect(repo.setStoryStatus(third.id, "merged", null)).rejects.toThrow(/needs the id/);
    await expect(repo.setStoryStatus(third.id, "merged", third.id)).rejects.toThrow(/cannot merge into itself/);
    await expect(repo.setStoryStatus(third.id, "dormant", survivor.id)).rejects.toThrow(/only point at another story/);
  });

  it("keeps a redirect ONE hop when its target is later merged onward", async () => {
    // A -> B is legal while B is open, and B -> C is legal too, so refusing to
    // merge into an already-merged story is not on its own enough: without the
    // re-point, A would be left redirecting to a story that has itself been
    // emptied and redirected.
    const a = await newStory("Chain head");
    const b = await newStory("Chain middle");
    const c = await newStory("Chain survivor");

    await repo.setStoryStatus(a.id, "merged", b.id);
    await repo.setStoryStatus(b.id, "merged", c.id);

    const afterA = (await repo.getStory(a.id))!;
    const afterB = (await repo.getStory(b.id))!;
    expect(afterA.mergedInto).toBe(c.id);
    expect(afterB.mergedInto).toBe(c.id);

    // Every redirect lands on a story that is not itself merged.
    const target = (await repo.getStory(afterA.mergedInto!))!;
    expect(target.status).not.toBe("merged");

    // And a third hop moves both of them again.
    const d = await newStory("Chain survivor after another merge");
    await repo.setStoryStatus(c.id, "merged", d.id);
    expect((await repo.getStory(a.id))!.mergedInto).toBe(d.id);
    expect((await repo.getStory(b.id))!.mergedInto).toBe(d.id);
    expect((await repo.getStory(c.id))!.mergedInto).toBe(d.id);
  });

  it("names a story whose assessment outlived every one of its members", async () => {
    const story = await newStory("Assessment outliving its members");
    const articleId = await insertArticle();
    await repo.addStoryMember({
      storyId: story.id,
      articleId,
      role: "primary",
      kind: "full",
      syndicatedOfArticleId: null,
      confidence: "high",
      reason: "same event",
      addedRunId: null,
    });
    await repo.setStoryAssessment(story.id, {
      text: "Something happened.",
      model: "claude-sonnet-5",
      generatedAt: new Date("2026-09-13T18:45:00.000Z"),
      membershipHash: (await repo.currentMembershipHash(story.id))!,
      touchesPolitics: true,
    });
    expect((await repo.listAssessedStoriesWithoutMembers()).map((x) => x.id)).not.toContain(story.id);

    // story_members cascades on article deletion; the assessment does not.
    await pool.query("DELETE FROM articles WHERE id = $1", [articleId]);
    expect(await repo.currentMembershipHash(story.id)).toBeNull();
    expect((await repo.getStory(story.id))!.assessment).not.toBeNull();

    // A null live hash can never DISAGREE with the stored one, so staleness by
    // comparison cannot see this. The detector can.
    expect((await repo.listAssessedStoriesWithoutMembers()).map((x) => x.id)).toContain(story.id);

    await pool.query("DELETE FROM stories WHERE id = $1", [story.id]);
  });

  it("lists stories a run can still attach to, newest first, without merged ones", async () => {
    const survivorHeadline = "Listed story";
    const story = await newStory(survivorHeadline);
    const gone = await newStory("Merged out of the list");
    await repo.setStoryStatus(gone.id, "merged", story.id);

    const live = await repo.listStoriesUpdatedSince(new Date(Date.now() - 60_000));
    expect(live.map((s) => s.id)).toContain(story.id);
    expect(live.map((s) => s.id)).not.toContain(gone.id);
    const timestamps = live.map((s) => s.updatedAt.getTime());
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);

    expect(await repo.listStoriesUpdatedSince(new Date(Date.now() + 60_000))).toEqual([]);
  });
});

// Postgres keeps updated_at to the microsecond; a JS Date truncates to the
// millisecond, so two writes inside the same millisecond read back identical
// and the comparison below fails for a reason that has nothing to do with the
// behaviour under test. Read the raw microseconds instead of sleeping between
// the writes: deterministic, and it still proves the column moved.
async function storyUpdatedAtMicros(storyId: string): Promise<bigint> {
  const { rows } = await pool.query<{ us: string }>(
    "SELECT (EXTRACT(EPOCH FROM updated_at) * 1000000)::bigint::text AS us FROM stories WHERE id = $1",
    [storyId],
  );
  return BigInt(rows[0]!.us);
}

describe("members", () => {
  it("moves updated_at when a member is ADDED, not when one is re-affirmed", async () => {
    const story = await newStory("Dormancy clock");
    const atInsert = await storyUpdatedAtMicros(story.id);
    const articleId = await insertArticle();
    const first = await repo.addStoryMember({
      storyId: story.id,
      articleId,
      role: "primary",
      kind: "full",
      syndicatedOfArticleId: null,
      confidence: "high",
      reason: "same actors, same act",
      addedRunId: null,
    });
    expect(first.inserted).toBe(true);
    const afterInsert = await storyUpdatedAtMicros(story.id);
    expect(afterInsert > atInsert).toBe(true);

    const again = await repo.addStoryMember({
      storyId: story.id,
      articleId,
      role: "secondary",
      kind: "full",
      syndicatedOfArticleId: null,
      confidence: "medium",
      reason: "roundup, not a telling",
      addedRunId: null,
    });
    expect(again.inserted).toBe(false);
    expect(again.member.role).toBe("secondary");
    expect(again.member.addedAt.getTime()).toBe(first.member.addedAt.getTime());
    expect(await storyUpdatedAtMicros(story.id)).toBe(afterInsert);
  });

  it("lets a roundup be secondary in several stories but primary in only one", async () => {
    const a = await newStory("Roundup story A");
    const b = await newStory("Roundup story B");
    const roundup = await insertArticle();

    for (const story of [a, b]) {
      await repo.addStoryMember({
        storyId: story.id,
        articleId: roundup,
        role: "secondary",
        kind: "full",
        syndicatedOfArticleId: null,
        confidence: "medium",
        reason: "roundup covering both",
        addedRunId: null,
      });
    }
    expect((await repo.listStoryMembers(a.id)).length).toBe(1);
    expect((await repo.listStoryMembers(b.id)).length).toBe(1);

    await repo.addStoryMember({
      storyId: a.id,
      articleId: roundup,
      role: "primary",
      kind: "full",
      syndicatedOfArticleId: null,
      confidence: "high",
      reason: "promoted to the telling",
      addedRunId: null,
    });
    await expect(
      repo.addStoryMember({
        storyId: b.id,
        articleId: roundup,
        role: "primary",
        kind: "full",
        syndicatedOfArticleId: null,
        confidence: "high",
        reason: "would be a second telling",
        addedRunId: null,
      }),
    ).rejects.toThrow(/story_members_one_primary_story/);
  });

  it("keeps the syndication pointer honest, in code and in the database", async () => {
    const story = await newStory("Wire copy");
    const original = await insertArticle();
    const copy = await insertArticle();

    await expect(
      repo.addStoryMember({
        storyId: story.id,
        articleId: copy,
        role: "secondary",
        kind: "syndicated",
        syndicatedOfArticleId: null,
        confidence: "high",
        reason: "no original named",
        addedRunId: null,
      }),
    ).rejects.toThrow(/names no original/);
    await expect(
      repo.addStoryMember({
        storyId: story.id,
        articleId: copy,
        role: "secondary",
        kind: "full",
        syndicatedOfArticleId: original,
        confidence: "high",
        reason: "pointer without the kind",
        addedRunId: null,
      }),
    ).rejects.toThrow(/not marked syndicated/);
    await expect(
      repo.addStoryMember({
        storyId: story.id,
        articleId: copy,
        role: "secondary",
        kind: "syndicated",
        syndicatedOfArticleId: copy,
        confidence: "high",
        reason: "copy of itself",
        addedRunId: null,
      }),
    ).rejects.toThrow(/syndicated copy of itself/);

    const written = await repo.addStoryMember({
      storyId: story.id,
      articleId: copy,
      role: "secondary",
      kind: "syndicated",
      syndicatedOfArticleId: original,
      confidence: "high",
      reason: "identical body to the wire original",
      addedRunId: null,
    });
    expect(written.member.syndicatedOfArticleId).toBe(original);

    // Pruning the original must not remove the copy's membership; it loses only
    // the pointer, which the published contract already allows to be null.
    await pool.query("DELETE FROM articles WHERE id = $1", [original]);
    const members = await repo.listStoryMembers(story.id);
    expect(members.map((m) => m.articleId)).toEqual([copy]);
    expect(members[0]!.syndicatedOfArticleId).toBeNull();
  });

  it("REFUSES a member of a merged story, naming where to attach instead", async () => {
    const survivor = await newStory("Merge survivor");
    const absorbed = await newStory("Merge absorbed");
    await repo.setStoryStatus(absorbed.id, "merged", survivor.id);
    await expect(
      repo.addStoryMember({
        storyId: absorbed.id,
        articleId: await insertArticle(),
        role: "primary",
        kind: "full",
        syndicatedOfArticleId: null,
        confidence: "high",
        reason: "late arrival",
        addedRunId: null,
      }),
    ).rejects.toThrow(/merged into/);
  });

  it("evicts a member, and a deleted article takes its membership with it", async () => {
    const story = await newStory("Eviction");
    const evicted = await insertArticle();
    const deleted = await insertArticle();
    for (const articleId of [evicted, deleted]) {
      await repo.addStoryMember({
        storyId: story.id,
        articleId,
        role: "primary",
        kind: "full",
        syndicatedOfArticleId: null,
        confidence: "low",
        reason: "attached, pending review",
        addedRunId: null,
      });
    }
    expect(await repo.removeStoryMember(story.id, evicted)).toBe(true);
    expect(await repo.removeStoryMember(story.id, evicted)).toBe(false);

    await pool.query("DELETE FROM articles WHERE id = $1", [deleted]);
    expect(await repo.listStoryMembers(story.id)).toEqual([]);
    expect(await repo.currentMembershipHash(story.id)).toBeNull();
  });

  it("records which run added a member, and survives that run's deletion", async () => {
    const run = await repo.startStoryRun();
    const story = await newStory("Run attribution");
    const articleId = await insertArticle();
    const { member } = await repo.addStoryMember({
      storyId: story.id,
      articleId,
      role: "primary",
      kind: "full",
      syndicatedOfArticleId: null,
      confidence: "high",
      reason: "assignment batch 3",
      addedRunId: run.id,
    });
    expect(member.addedRunId).toBe(run.id);

    await pool.query("DELETE FROM story_runs WHERE id = $1", [run.id]);
    const after = await repo.listStoryMembers(story.id);
    expect(after[0]!.addedRunId).toBeNull();
  });
});

describe("the sweep record", () => {
  it("is idempotent per shard and answers whether every article was fully checked", async () => {
    const run = await repo.startStoryRun();
    const swept = await insertArticle();
    const partial = await insertArticle();
    const missing = await insertArticle();

    await repo.recordArticleSweep({ runId: run.id, articleId: swept, shard: 0, storiesChecked: 100 });
    await repo.recordArticleSweep({ runId: run.id, articleId: swept, shard: 1, storiesChecked: 50 });
    // A retried shard overwrites its own row instead of double-counting.
    await repo.recordArticleSweep({ runId: run.id, articleId: swept, shard: 1, storiesChecked: 80 });
    await repo.recordArticleSweep({ runId: run.id, articleId: partial, shard: 0, storiesChecked: 100 });

    const { rows } = await pool.query<{ total: string }>(
      "SELECT SUM(stories_checked)::text AS total FROM article_sweeps WHERE run_id = $1 AND article_id = $2",
      [run.id, swept],
    );
    expect(rows[0]!.total).toBe("180");

    expect(await repo.listIncompletelySweptArticleIds(run.id, [swept, partial, missing], 180)).toEqual(
      [partial, missing].sort((a, b) => a - b),
    );
    expect(await repo.listIncompletelySweptArticleIds(run.id, [swept], 180)).toEqual([]);
    expect(await repo.listIncompletelySweptArticleIds(run.id, [], 180)).toEqual([]);
    // Another run's sweeps prove nothing about this one.
    const other = await repo.startStoryRun();
    expect(await repo.listIncompletelySweptArticleIds(other.id, [swept], 1)).toEqual([swept]);
  });

  it("REFUSES a negative count or shard", async () => {
    const run = await repo.startStoryRun();
    const articleId = await insertArticle();
    await expect(
      repo.recordArticleSweep({ runId: run.id, articleId, shard: -1, storiesChecked: 1 }),
    ).rejects.toThrow(/shard/);
    await expect(
      repo.recordArticleSweep({ runId: run.id, articleId, shard: 0, storiesChecked: -1 }),
    ).rejects.toThrow(/stories checked/);
    await expect(repo.listIncompletelySweptArticleIds(run.id, [articleId], -1)).rejects.toThrow(/required/);
  });
});

describe("durable story-run evidence", () => {
  it("persists and clears terminal article states", async () => {
    const run = await repo.startStoryRun();
    const articleId = await insertArticle();
    const first = await repo.setStoryArticleState(articleId, "flag", "Ambiguous event.", run.id);
    expect(first).toMatchObject({ articleId, state: "flag", reason: "Ambiguous event.", runId: run.id });

    const replaced = await repo.setStoryArticleState(articleId, "not_news", "Navigation item.", run.id);
    expect(replaced).toMatchObject({ state: "not_news", reason: "Navigation item." });
    expect(await repo.getStoryArticleState(articleId)).toMatchObject({ state: "not_news" });
    expect(await repo.clearStoryArticleState(articleId)).toBe(true);
    expect(await repo.clearStoryArticleState(articleId)).toBe(false);
    expect(await repo.getStoryArticleState(articleId)).toBeNull();
  });

  it("records decisions, detailed sweep evidence, and every model call", async () => {
    const run = await repo.startStoryRun();
    const articleId = await insertArticle();
    const story = await newStory("Evidence target");

    const eventId = await repo.appendStoryEvent({
      runId: run.id,
      articleId,
      storyId: story.id,
      action: "sweep_exclude",
      reason: "Different act and occasion.",
      detail: { shard: 0 },
    });
    expect(eventId).toBeGreaterThan(0);

    await repo.recordStorySweepCheck({
      runId: run.id,
      articleId,
      storyId: story.id,
      outcome: "excluded",
      reason: "Different act and occasion.",
    });
    // A retried verdict replaces the same pair instead of manufacturing a
    // second check.
    await repo.recordStorySweepCheck({
      runId: run.id,
      articleId,
      storyId: story.id,
      outcome: "uncertain",
      reason: "Source headline lacks an occasion.",
    });
    expect(await repo.listStorySweepChecks(run.id, story.id)).toEqual([
      expect.objectContaining({ articleId, storyId: story.id, outcome: "uncertain" }),
    ]);

    await repo.recordStoryRunUsage({
      runId: run.id,
      stage: "assignment",
      callIndex: 1,
      model: "claude-sonnet-5",
      status: "succeeded",
      error: null,
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 30,
      wallMs: 250,
    });
    expect(await repo.listStoryRunUsage(run.id)).toEqual([
      {
        runId: run.id,
        stage: "assignment",
        callIndex: 1,
        model: "claude-sonnet-5",
        status: "succeeded",
        error: null,
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 30,
        wallMs: 250,
      },
    ]);
  });

  it("REFUSES empty reasons and impossible usage counts", async () => {
    const run = await repo.startStoryRun();
    const articleId = await insertArticle();
    await expect(repo.setStoryArticleState(articleId, "flag", " ", run.id)).rejects.toThrow(/must not be empty/);
    await expect(
      repo.recordStoryRunUsage({
        runId: run.id,
        stage: "assignment",
        callIndex: 1,
        model: "claude-sonnet-5",
        status: "succeeded",
        error: null,
        inputTokens: -1,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        wallMs: 0,
      }),
    ).rejects.toThrow(/non-negative/);
  });
});

// Last, because it takes the schema away and puts it back.
describe("the migration reverses", () => {
  it("drops the ledger and the column, then re-applies", async () => {
    // down() reverses exactly the last applied migration, so unwinding the
    // whole directory takes one call per migration. Written as a loop rather
    // than a fixed count so a new migration does not silently leave this test
    // asserting against a half-reversed schema.
    const applied = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
    for (let i = 0; i < (applied.rowCount ?? 0); i += 1) {
      await migrate.down(migrationsDir);
    }

    const gone = await pool.query<{ t: string | null }>(
      `SELECT to_regclass('public.stories') AS t, to_regclass('public.story_members') AS m,
              to_regclass('public.story_runs') AS r, to_regclass('public.article_sweeps') AS s`,
    );
    expect(Object.values(gone.rows[0]!)).toEqual([null, null, null, null]);

    const column = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sources' AND column_name = 'outlet_key'
       ) AS present`,
    );
    expect(column.rows[0]!.present).toBe(false);

    const ledger = await pool.query("SELECT version FROM schema_migrations");
    expect(ledger.rowCount).toBe(0);

    await migrate.up(migrationsDir);
    const back = await pool.query<{ t: string | null }>("SELECT to_regclass('public.stories') AS t");
    expect(back.rows[0]!.t).toBe("stories");
    const story = await newStory("Alive after a round trip");
    expect(await repo.getStory(story.id)).not.toBeNull();
  }, 60_000);
});
