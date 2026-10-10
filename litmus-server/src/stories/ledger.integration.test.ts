import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { stopTestDatabase } from "../db/testDatabase.js";
import type { StoryArticle } from "./retrieval.js";

// applySweepAttachment against a real database: the bug this file exists to
// pin down only reproduces through the SQL guards in storiesRepo (a merged
// story refuses new members and refuses to be a merge target), which a mock
// pool would just let through silently.

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
const SCHEMA_PATH = path.join(here, "..", "db", "schema.sql");

let pg: EmbeddedPostgres;
let dataDir: string;
let migrationsDir: string;
let migrate: typeof import("../db/migrate.js");
let pool: (typeof import("../db/client.js"))["pool"];
let repo: typeof import("../db/repos/storiesRepo.js");
let ledger: typeof import("./ledger.js");

let sourceId: number;
let nextArticle = 0;

async function insertArticleRow(): Promise<number> {
  nextArticle += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO articles (source_id, url, title, extraction_status, content_hash)
     VALUES ($1, $2, $3, 'full', $4)
     RETURNING id`,
    [sourceId, `https://example.test/a/${nextArticle}`, `Article ${nextArticle}`, `hash-${nextArticle}`],
  );
  return rows[0]!.id;
}

function storyArticle(id: number): StoryArticle {
  return {
    id,
    title: `Article ${id}`,
    url: `https://example.test/a/${id}`,
    outletKey: "example",
    outletName: "Example",
    sourceLean: "center",
    publishedAt: new Date(),
    fetchedAt: new Date(),
    extractionStatus: "full",
    wordCount: 500,
    syndicatedOfArticleId: null,
    articleSummary: null,
    reactingTo: null,
    section: null,
  };
}

async function singletonStory(articleId: number, headline: string, firstSeenAt?: Date) {
  const story = await repo.insertStory({ headline, eventStatement: `${headline}.`, section: "politics", firstSeenAt });
  await repo.addStoryMember({
    storyId: story.id,
    articleId,
    role: "primary",
    kind: "full",
    syndicatedOfArticleId: null,
    confidence: "high",
    reason: "seeded singleton",
    addedRunId: null,
  });
  return story;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "litmus-ledger-pg-"));
  migrationsDir = path.join(here, "..", "..", "migrations");

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
  migrate = await import("../db/migrate.js");
  ({ pool } = await import("../db/client.js"));
  repo = await import("../db/repos/storiesRepo.js");
  ledger = await import("./ledger.js");

  await pool.query(await readFile(SCHEMA_PATH, "utf-8"));
  await migrate.up(migrationsDir);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sources (name, rss_url, lean, type, paywall_status, reliability, enabled)
     VALUES ('Example', 'https://example.test/rss', 'center', 'digital-native', 'free', 3, TRUE)
     RETURNING id`,
  );
  sourceId = rows[0]!.id;
}, 180_000);

afterAll(async () => {
  // Waits for the pool's connections to close before the fast shutdown
  // (testDatabase.ts; the 2026-10-09 edition failed on this race).
  await stopTestDatabase({ pool, pg, databaseUrl: process.env.DATABASE_URL });
  await rm(dataDir, { recursive: true, force: true });
});

describe("applySweepAttachment against a story a same-run decision already merged away", () => {
  it("resolves the merge chain instead of throwing and killing the run", async () => {
    const run = await repo.startStoryRun();

    // Survivor story with an existing member, plus the two singleton stories
    // that a whole-run sweep pass will fold into it in sequence.
    const survivorSeedArticle = await insertArticleRow();
    const survivor = await singletonStory(survivorSeedArticle, "Senate passes the stopgap funding bill");

    const art1 = await insertArticleRow();
    const storyA = await singletonStory(art1, "Congress nears a funding deal");

    const art2 = await insertArticleRow();
    const storyC = await singletonStory(art2, "Lawmakers signal a shutdown may be averted");

    // Decision 1: article1 actually belongs on the survivor story. This empties
    // and merges storyA away mid-run.
    await ledger.applySweepAttachment(run.id, storyArticle(art1), [survivor.id], "secondary", "same event", storyA.id);

    const mergedA = await repo.getStory(storyA.id);
    expect(mergedA?.status).toBe("merged");
    expect(mergedA?.mergedInto).toBe(survivor.id);

    // Decision 2: article2 was told (from the pre-merge openCards snapshot)
    // that it belongs with storyA — which decision 1 already merged into the
    // survivor. Before the fix this threw and crashed the whole run.
    const resultStoryIds = await ledger.applySweepAttachment(
      run.id,
      storyArticle(art2),
      [storyA.id],
      "secondary",
      "same event",
      storyC.id,
    );

    expect(resultStoryIds).toContain(survivor.id);

    const survivorMembers = await repo.listStoryMembers(survivor.id);
    expect(survivorMembers.map((m) => m.articleId).sort()).toEqual(
      [art1, art2, survivorSeedArticle].sort(),
    );

    const mergedC = await repo.getStory(storyC.id);
    expect(mergedC?.status).toBe("merged");
    expect(mergedC?.mergedInto).toBe(survivor.id);
  });

  it("detects a merge cycle instead of looping forever", async () => {
    const artX = await insertArticleRow();
    const storyX = await singletonStory(artX, "Story X of a two-node merge cycle");
    const artY = await insertArticleRow();
    const storyY = await singletonStory(artY, "Story Y of a two-node merge cycle");

    // setStoryStatus's own guard (target must not already be merged) can never
    // produce this: force a two-node cycle directly, an invalid state a real
    // merge chain could never reach, to exercise resolveLiveStoryId's guard.
    await pool.query("UPDATE stories SET status = 'merged', merged_into = $2 WHERE id = $1", [storyX.id, storyY.id]);
    await pool.query("UPDATE stories SET status = 'merged', merged_into = $2 WHERE id = $1", [storyY.id, storyX.id]);

    const other = await insertArticleRow();
    const otherStory = await singletonStory(other, "Another story");

    await expect(
      ledger.applySweepAttachment(999, storyArticle(other), [storyX.id], "secondary", "same event", otherStory.id),
    ).rejects.toThrow(/cycle/);
  });
});

describe("mergeReviewedPair: parallel reviews applied one at a time (2026-09-22)", () => {
  it("folds a chain of approved pairs into one story without touching a merged story", async () => {
    const run = await repo.startStoryRun();
    // Explicit, distinct first-seen times. Left to NOW(), three inserts can land
    // in the same millisecond once the timestamp reaches JavaScript as a Date,
    // and the tie then goes to the lower random story id, so "A survives" held
    // only most of the time (the intermittent failure at this assertion,
    // 2026-10-07). The invariant under test is unchanged: earliest seen wins.
    const t0 = Date.parse("2026-10-01T12:00:00Z");
    const a = await singletonStory(await insertArticleRow(), "Chain story A", new Date(t0));
    const b = await singletonStory(await insertArticleRow(), "Chain story B", new Date(t0 + 60_000));
    const c = await singletonStory(await insertArticleRow(), "Chain story C", new Date(t0 + 120_000));

    // Three "yes" reviews made against the same snapshot: A-B, B-C, A-C.
    const first = await ledger.mergeReviewedPair(run.id, a.id, b.id, "same event");
    const second = await ledger.mergeReviewedPair(run.id, b.id, c.id, "same event");
    const third = await ledger.mergeReviewedPair(run.id, a.id, c.id, "same event");

    expect(first.merged).toBe(true);
    expect(second.merged).toBe(true);
    // A and C already share a survivor by the third pair.
    expect(third).toEqual({ merged: false, survivorId: first.survivorId });

    const live = [a, b, c].map((story) => story.id);
    const records = await Promise.all(live.map((id) => repo.getStory(id)));
    const survivors = records.filter((record) => record?.status !== "merged");
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.id).toBe(a.id); // earliest seen wins
    expect((await repo.listStoryMembers(a.id)).length).toBe(3);
  });

  it("breaks a first-seen tie by story id, whichever side of the pair it is on", async () => {
    const run = await repo.startStoryRun();
    const seen = new Date("2026-10-01T12:00:00Z");
    const x = await singletonStory(await insertArticleRow(), "Tie story X", seen);
    const y = await singletonStory(await insertArticleRow(), "Tie story Y", seen);
    const lower = x.id < y.id ? x : y;
    const higher = lower === x ? y : x;

    // Pass the higher id first, so a "left side wins" shortcut would fail.
    const result = await ledger.mergeReviewedPair(run.id, higher.id, lower.id, "same event");

    expect(result).toEqual({ merged: true, survivorId: lower.id });
    expect((await repo.getStory(higher.id))?.mergedInto).toBe(lower.id);
  });
});

