import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { stopTestDatabase } from "../testDatabase.js";
import { planArticleRow, hashForItem, headlineUpgradeFromPlan, shouldRetryExtraction } from "../../ingestion/articleRow.js";
import { detectPaywall } from "../../ingestion/paywallDetector.js";
import type { ExtractedContent } from "../../ingestion/extractor.js";
import type { NewSource, Source } from "../../types.js";

// S2 against a real database: 0002_article_syndication applies on top of 0001,
// headline-only and syndicated rows round-trip through the repo, the
// constraints that hold the legal posture are the DATABASE's constraints, the
// scoring queue leaves both new kinds alone, and the migration reverses.
//
// Same harness as storiesRepo.integration.test.ts: a free port that is never
// 5432, DATABASE_URL set before the modules that read it at import are loaded.

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
let repo: typeof import("./articlesRepo.js");
let sourcesRepo: typeof import("./sourcesRepo.js");

// Two sister feeds of one outlet, and one feed of another outlet.
let nytPolitics: Source;
let nytUs: Source;
let bbcWorld: Source;

const BODY = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
const FULL: ExtractedContent = { text: BODY, wordCount: 300, via: "publisher" };
const EMPTY: ExtractedContent = { text: "", wordCount: 0, via: "feed" };

let nextUrl = 0;
function item(title: string, publishedAt = new Date()) {
  nextUrl += 1;
  return { url: `https://example.test/a/${nextUrl}`, title, author: null, publishedAt };
}

// Every source id sharing a source's outlet, the way runIngest.outletSourceIds
// reads it off the loaded roster. The hash lookup needs these to tell a sister
// feed from another newsroom.
function siblingsOf(source: Source): number[] {
  return [nytPolitics, nytUs, bbcWorld].filter((s) => s.outletKey === source.outletKey).map((s) => s.id);
}

// Run one feed item through the same decision ingest uses, against the live
// table, and return what happened.
async function ingestOne(source: Source, title: string, extracted: ExtractedContent) {
  return ingestItem(source, item(title), extracted);
}

// Same, with an explicit publication time: headline-only rows hash against the
// publication day, so a test about recurring headlines has to control it.
async function ingestOneDated(source: Source, title: string, extracted: ExtractedContent, publishedAt: Date) {
  return ingestItem(source, { ...item(title), publishedAt }, extracted);
}

async function ingestItem(
  source: Source,
  it: { url: string; title: string; author: string | null; publishedAt: Date | null },
  extracted: ExtractedContent,
) {
  const hash = hashForItem(it, extracted);
  const siblings = siblingsOf(source);
  const headlineOnly = extracted.wordCount === 0;
  const plan = planArticleRow({
    source,
    item: it,
    extracted,
    verdict: detectPaywall(extracted.wordCount, source),
    hash,
    existing: await repo.findByContentHash(hash, siblings),
    sameOutletPiece: headlineOnly ? await repo.findSameOutletPiece(siblings, it) : null,
  });
  if (plan.action !== "insert") return { plan, article: null };
  return { plan, article: await repo.insertArticle(plan.row) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "litmus-articles-pg-"));
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
  repo = await import("./articlesRepo.js");
  sourcesRepo = await import("./sourcesRepo.js");

  await pool.query(await readFile(SCHEMA_PATH, "utf-8"));
  await migrate.up(migrationsDir);

  const seed = (JSON.parse(await readFile(SEED_PATH, "utf-8")) as { sources: NewSource[] }).sources;
  const byName = (name: string) => {
    const s = seed.find((x) => x.name === name);
    if (!s) throw new Error(`seed.json no longer lists "${name}"; pick another sister-feed pair`);
    return s;
  };
  nytPolitics = await sourcesRepo.upsertSource(byName("New York Times — Politics"));
  nytUs = await sourcesRepo.upsertSource(byName("New York Times — US"));
  bbcWorld = await sourcesRepo.upsertSource(byName("BBC News — World"));
  expect(nytPolitics.outletKey).toBe(nytUs.outletKey);
  expect(bbcWorld.outletKey).not.toBe(nytUs.outletKey);
}, 180_000);

afterAll(async () => {
  // Waits for the pool's connections to close before the fast shutdown
  // (testDatabase.ts; the 2026-10-09 edition failed on this race).
  await stopTestDatabase({ pool, pg, databaseUrl: process.env.DATABASE_URL });
  await rm(dataDir, { recursive: true, force: true });
});

describe("headline-only rows", () => {
  it("stores a zero-word extraction with a headline and link and nothing else", async () => {
    const { plan, article } = await ingestOne(nytPolitics, "Senate passes the stopgap funding bill", EMPTY);
    expect(plan.action === "insert" && plan.kind).toBe("headline_only");
    expect(article).not.toBeNull();
    const back = await repo.findArticleById(article!.id);
    expect(back).toMatchObject({
      title: "Senate passes the stopgap funding bill",
      rawText: "",
      wordCount: 0,
      extractionStatus: "failed",
      extractedVia: null,
      syndicatedOfArticleId: null,
      paywallFlag: true, // NYT is metered; the row says why it was not read
    });
  });

  it("cannot be given a body later without changing its status (database constraint)", async () => {
    const { article } = await ingestOne(nytPolitics, "Court blocks the tariff order", EMPTY);
    await expect(
      pool.query("UPDATE articles SET raw_text = $2 WHERE id = $1", [article!.id, "some text"]),
    ).rejects.toThrow(/articles_headline_only_has_no_body/);
    await expect(
      pool.query("UPDATE articles SET word_count = 12 WHERE id = $1", [article!.id]),
    ).rejects.toThrow(/articles_headline_only_has_no_body/);
  });

  it("refuses a 'failed' insert that carries text", async () => {
    await expect(
      repo.insertArticle({
        sourceId: nytPolitics.id,
        url: "https://example.test/bad/failed-with-text",
        title: "Should not land",
        author: null,
        publishedAt: new Date(),
        rawText: "a body",
        wordCount: 2,
        extractionStatus: "failed",
        paywallFlag: false,
        contentHash: "hash-failed-with-text",
        extractedVia: "feed",
        syndicatedOfArticleId: null,
      }),
    ).rejects.toThrow(/articles_headline_only_has_no_body/);
  });

  it("is not addressable as an article page: no blank page to reach", async () => {
    const { article } = await ingestOne(nytUs, "Not a page, only a record", EMPTY);
    expect(await repo.getArticleDetail(article!.id)).toBeNull();
    // The row is still there for the story layer to read.
    expect(await repo.findArticleById(article!.id)).not.toBeNull();
  });

  it("never enters the scoring queue", async () => {
    const { article } = await ingestOne(bbcWorld, "Headline only, fresh, unscored", EMPTY);
    const queued = await repo.listUnscoredArticles(500);
    expect(queued.map((a) => a.id)).not.toContain(article!.id);
  });
});

describe("content-hash matches", () => {
  it("skips the same text on a sister feed of the same outlet", async () => {
    const first = await ingestOne(nytPolitics, "Fed holds rates steady", FULL);
    expect(first.plan.action === "insert" && first.plan.kind).toBe("full");
    const sister = await ingestOne(nytUs, "Fed holds rates steady", FULL);
    expect(sister.plan).toEqual({ action: "skip-same-outlet-copy", originalId: first.article!.id });
    expect(sister.article).toBeNull();
  });

  it("stores the same text from another outlet as a syndicated copy of the original", async () => {
    const original = await ingestOne(nytPolitics, "Wildfire closes the interstate", FULL);
    const copy = await ingestOne(bbcWorld, "Wildfire closes the interstate", FULL);
    expect(copy.plan.action === "insert" && copy.plan.kind).toBe("syndicated");
    expect(copy.article).not.toBeNull();
    const back = await repo.findArticleById(copy.article!.id);
    expect(back!.syndicatedOfArticleId).toBe(original.article!.id);
    expect(back!.rawText).toBe(BODY);
    expect(back!.extractionStatus).toBe("full");
  });

  it("leaves a recurring headline from one outlet as two rows on two days", async () => {
    // Same outlet, same headline, different days: the second is real coverage,
    // not a sister-feed duplicate, so it must not be skipped.
    const monday = await ingestOneDated(nytPolitics, "Morning Briefing", EMPTY, new Date("2026-09-14T10:00:00Z"));
    const tuesday = await ingestOneDated(nytPolitics, "Morning Briefing", EMPTY, new Date("2026-09-15T10:00:00Z"));
    expect(monday.plan.action === "insert" && monday.plan.kind).toBe("headline_only");
    expect(tuesday.plan.action === "insert" && tuesday.plan.kind).toBe("headline_only");
    expect(tuesday.article!.id).not.toBe(monday.article!.id);

    // The same item on a sister feed of that outlet, minutes later, still collapses.
    const sister = await ingestOneDated(nytUs, "Morning Briefing", EMPTY, new Date("2026-09-15T10:06:00Z"));
    expect(sister.plan).toEqual({ action: "skip-same-outlet-copy", originalId: tuesday.article!.id });
  });

  it("findByContentHash names the row, its outlet, whether it is ours, and null when nothing matches", async () => {
    const original = await ingestOne(nytUs, "Court hears the redistricting case", FULL);
    const copy = await ingestOne(bbcWorld, "Court hears the redistricting case", FULL);
    expect(copy.article!.id).toBeGreaterThan(original.article!.id);
    const hash = original.article!.contentHash;
    expect(await repo.findByContentHash(hash, siblingsOf(nytUs))).toEqual({
      id: original.article!.id,
      outletKey: nytUs.outletKey,
      sameOutlet: true,
      syndicatedOfArticleId: null,
    });
    // Read by the outlet that holds the COPY, the copy wins over the earlier
    // original: that preference is what keeps one outlet to one row.
    expect(await repo.findByContentHash(hash, siblingsOf(bbcWorld))).toMatchObject({
      id: copy.article!.id,
      sameOutlet: true,
    });
    // An outlet with no row of its own gets the earliest row, flagged foreign.
    expect(await repo.findByContentHash(hash, [])).toMatchObject({
      id: original.article!.id,
      sameOutlet: false,
    });
    expect(await repo.findByContentHash("no-such-hash", siblingsOf(nytUs))).toBeNull();
  });

  // The bug the outlet preference exists for. A wire piece stored first by a
  // third outlet used to be the ONLY row the lookup returned, so each feed of
  // a second outlet saw a cross-outlet match and inserted its own copy: one
  // newsroom, two rows, two dots in a story matrix that counts newsrooms.
  it("gives one outlet one row when a third outlet stored the wire text first", async () => {
    const wire = await ingestOne(bbcWorld, "Wire desk files on the ceasefire", FULL);
    const first = await ingestOne(nytPolitics, "Wire desk files on the ceasefire", FULL);
    const second = await ingestOne(nytUs, "Wire desk files on the ceasefire", FULL);

    expect(first.plan.action).toBe("insert");
    expect(first.plan.action === "insert" && first.plan.kind).toBe("syndicated");
    expect(first.article!.syndicatedOfArticleId).toBe(wire.article!.id);

    // The second sister feed finds its OWN outlet's row first and stops.
    expect(second.plan).toEqual({ action: "skip-same-outlet-copy", originalId: first.article!.id });
    expect(second.article).toBeNull();

    const { rows } = await pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM articles WHERE content_hash = $1 AND source_id = ANY($2::int[])",
      [wire.article!.contentHash, [nytPolitics.id, nytUs.id]],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("keeps the copy's row when the original is deleted, with the pointer cleared", async () => {
    const original = await ingestOne(nytPolitics, "Port strike enters its third day", FULL);
    const copy = await ingestOne(bbcWorld, "Port strike enters its third day", FULL);
    await pool.query("DELETE FROM articles WHERE id = $1", [original.article!.id]);
    const back = await repo.findArticleById(copy.article!.id);
    expect(back).not.toBeNull();
    expect(back!.syndicatedOfArticleId).toBeNull();
  });

  it("refuses a row that points at itself", async () => {
    const { article } = await ingestOne(nytPolitics, "Self-pointer check", FULL);
    await expect(
      pool.query("UPDATE articles SET syndicated_of_article_id = id WHERE id = $1", [article!.id]),
    ).rejects.toThrow(/articles_not_syndicated_of_self/);
  });

  it("never queues an unscored article older than the scoring window: backlog ages out", async () => {
    const fresh = await ingestOne(nytUs, "Scored today, inside the window", FULL);
    const stale = await ingestOne(nytPolitics, "Left unscored by a failed run", FULL);
    await pool.query(
      "UPDATE articles SET published_at = NOW() - make_interval(hours => $2) WHERE id = $1",
      [stale.article!.id, repo.SCORE_WINDOW_HOURS + 1],
    );
    const ids = (await repo.listUnscoredArticles(500)).map((a) => a.id);
    expect(ids).toContain(fresh.article!.id);
    expect(ids).not.toContain(stale.article!.id);
  });

  it("queues the original for scoring and leaves the copy out", async () => {
    const original = await ingestOne(nytUs, "Budget talks resume in the capital", FULL);
    const copy = await ingestOne(bbcWorld, "Budget talks resume in the capital", FULL);
    const ids = (await repo.listUnscoredArticles(500)).map((a) => a.id);
    expect(ids).toContain(original.article!.id);
    expect(ids).not.toContain(copy.article!.id);
  });
});

describe("retrying a headline-only row", () => {
  // The path runIngest takes when a feed lists a URL it already stored as
  // headline-only: look the row up, decide to retry, extract again, upgrade in
  // one statement, and if the retry brought nothing while a sister feed has
  // meanwhile stored the piece with a body, drop the hollow row.
  async function retry(
    source: Source,
    stored: { id: number; url: string; title: string; publishedAt: Date | null },
    extracted: ExtractedContent,
  ): Promise<{ upgraded: Awaited<ReturnType<typeof repo.upgradeHeadlineOnlyArticle>>; hollowDropped: boolean }> {
    const lookup = await repo.findStoredBySourceUrl(source.id, stored.url);
    expect(lookup).not.toBeNull();
    expect(shouldRetryExtraction(lookup!, repo.CONTEXT_WINDOW_DAYS)).toBe(true);
    const it = { url: stored.url, title: stored.title, author: null, publishedAt: stored.publishedAt };
    const hash = hashForItem(it, extracted);
    const siblings = siblingsOf(source);
    const plan = planArticleRow({
      source,
      item: it,
      extracted,
      verdict: detectPaywall(extracted.wordCount, source),
      hash,
      existing: await repo.findByContentHash(hash, siblings),
    });
    const upgrade = headlineUpgradeFromPlan(plan);
    if (upgrade) return { upgraded: await repo.upgradeHeadlineOnlyArticle(stored.id, upgrade), hollowDropped: false };
    const sister = await repo.findSameOutletPiece(siblings, it, stored.id);
    const hollowDropped =
      sister !== null && sister.wordCount > 0 && (await repo.deleteHeadlineOnlyArticle(stored.id));
    return { upgraded: null, hollowDropped };
  }

  it("upgrades to a body in one statement and enters the scoring queue", async () => {
    const { article } = await ingestOne(bbcWorld, "Timed out last night, readable today", EMPTY);
    expect((await repo.listUnscoredArticles(500)).map((a) => a.id)).not.toContain(article!.id);

    const { upgraded } = await retry(bbcWorld, article!, FULL);
    expect(upgraded).toMatchObject({
      id: article!.id,
      rawText: BODY,
      wordCount: 300,
      extractionStatus: "full",
      extractedVia: "publisher",
      paywallFlag: false,
      contentHash: hashForItem(article!, FULL),
    });
    expect(upgraded!.fetchedAt.getTime()).toBeGreaterThanOrEqual(article!.fetchedAt.getTime());
    expect((await repo.listUnscoredArticles(500)).map((a) => a.id)).toContain(article!.id);
    // Same row, same story-facing identity: the id did not move.
    expect(await repo.findArticleById(article!.id)).toMatchObject({ id: article!.id, wordCount: 300 });
  });

  it("stays a headline-only row when the retry still yields nothing", async () => {
    const { article } = await ingestOne(bbcWorld, "Still behind the wall", EMPTY);
    expect(await retry(bbcWorld, article!, EMPTY)).toEqual({ upgraded: null, hollowDropped: false });
    expect(await repo.findArticleById(article!.id)).toMatchObject({ wordCount: 0, extractionStatus: "failed" });
  });

  // 2026-09-26: a thin row (some text, under 200 words) used to stay thin
  // forever; NPR pieces extracted in full on later runs but were never fetched
  // again. It now upgrades in place, and its story membership becomes full.
  it("upgrades a thin row to a real body and makes its story membership full", async () => {
    const thinText = Array.from({ length: 120 }, (_, i) => `thin${i}`).join(" ");
    const { article } = await ingestOne(bbcWorld, "Thin on the first read", { text: thinText, wordCount: 120, via: "publisher" });
    expect(article!.wordCount).toBe(120);
    expect(shouldRetryExtraction(article!, repo.CONTEXT_WINDOW_DAYS, new Date(), true)).toBe(true);
    const stories = await import("./storiesRepo.js");
    const story = await stories.insertStory({ headline: "Thin story", eventStatement: "Something happened.", section: null });
    await stories.addStoryMember({ storyId: story.id, articleId: article!.id, role: "primary", kind: "headline_only", syndicatedOfArticleId: null, confidence: "high", reason: "test", addedRunId: null });
    const up = { rawText: BODY, wordCount: 300, extractionStatus: "full" as const, extractedVia: "publisher" as const, paywallFlag: false, contentHash: "thin-upgrade-hash", syndicatedOfArticleId: null };
    const upgraded = await repo.upgradeThinArticle(article!.id, up, 200);
    expect(upgraded).toMatchObject({ id: article!.id, wordCount: 300, extractionStatus: "full" });
    expect((await stories.listStoryMembers(story.id))[0]!.kind).toBe("full");
    // A second, shorter "upgrade" never replaces the real body.
    expect(await repo.upgradeThinArticle(article!.id, { ...up, rawText: "x ".repeat(250), wordCount: 250, contentHash: "shorter" }, 200)).toBeNull();
    expect((await repo.findArticleById(article!.id))!.wordCount).toBe(300);
  });

  it("never overwrites a row that already has a body (the guard holds)", async () => {
    const { article } = await ingestOne(nytPolitics, "Already read once", FULL);
    expect(await repo.findStoredBySourceUrl(nytPolitics.id, article!.url)).toMatchObject({ extractionStatus: "full", wordCount: 300 });
    expect(shouldRetryExtraction(article!, repo.CONTEXT_WINDOW_DAYS)).toBe(false);
    const result = await repo.upgradeHeadlineOnlyArticle(article!.id, {
      rawText: "replacement text",
      wordCount: 2,
      extractionStatus: "partial",
      extractedVia: "feed",
      paywallFlag: false,
      contentHash: "replacement-hash",
      syndicatedOfArticleId: null,
    });
    expect(result).toBeNull();
    expect((await repo.findArticleById(article!.id))!.rawText).toBe(BODY);
  });

  // The duplicate the fresh path refuses to write, arriving in the other order:
  // the hollow row was stored first and a sister feed filled the piece in
  // afterwards. Left alone, the outlet shows a hollow dot beside a full one.
  it("drops the hollow row once a sister feed has stored the piece with a body", async () => {
    const day = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const title = "Sister feed got through the wall";
    const hollow = await ingestOneDated(nytPolitics, title, EMPTY, day);
    expect(hollow.article!.wordCount).toBe(0);
    const filled = await ingestOneDated(nytUs, title, FULL, day);
    expect(filled.article).not.toBeNull();

    const outcome = await retry(nytPolitics, hollow.article!, EMPTY);
    expect(outcome).toEqual({ upgraded: null, hollowDropped: true });
    expect(await repo.findArticleById(hollow.article!.id)).toBeNull();
    // The body row is untouched, and the outlet is one row for one piece.
    expect(await repo.findArticleById(filled.article!.id)).toMatchObject({ wordCount: 300 });
  });

  // Two hollow rows for one piece must not delete each other. Only a sister
  // row WITH a body wins, so whichever is retried first finds nothing to yield
  // to. Built by hand because the fresh path refuses to write the second one.
  it("keeps a hollow row when the only sister row is also hollow", async () => {
    const day = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const title = "Both feeds timed out";
    const first = await ingestOneDated(nytPolitics, title, EMPTY, day);
    const twin = await repo.insertArticle({
      sourceId: nytUs.id,
      url: `https://example.test/twin/${first.article!.id}`,
      title,
      author: null,
      publishedAt: day,
      rawText: "",
      wordCount: 0,
      extractionStatus: "failed",
      paywallFlag: false,
      contentHash: `${first.article!.contentHash}-twin`,
      extractedVia: null,
      syndicatedOfArticleId: null,
    });
    expect(twin).not.toBeNull();

    expect(await retry(nytPolitics, first.article!, EMPTY)).toEqual({ upgraded: null, hollowDropped: false });
    expect(await repo.findArticleById(first.article!.id)).not.toBeNull();
    expect(await repo.findArticleById(twin!.id)).not.toBeNull();
  });

  it("refuses an upgrade that carries no body", async () => {
    const { article } = await ingestOne(bbcWorld, "No body to upgrade with", EMPTY);
    await expect(
      repo.upgradeHeadlineOnlyArticle(article!.id, {
        rawText: "",
        wordCount: 0,
        extractionStatus: "failed",
        extractedVia: null,
        paywallFlag: false,
        contentHash: "x",
        syndicatedOfArticleId: null,
      }),
    ).rejects.toThrow(/must carry a body/);
  });
});

describe("one outlet, one row per piece", () => {
  it("does not write a hollow twin when a sister feed already holds the body", async () => {
    const day = new Date("2026-09-13T15:00:00Z");
    const first = await ingestOneDated(nytPolitics, "Governor signs the housing bill", FULL, day);
    const siblingIds = [nytPolitics.id, nytUs.id];
    // Different URL on the sister feed, same headline, same day.
    const sisterItem = { ...item("Governor signs the housing bill", day) };
    expect(await repo.findSameOutletPiece(siblingIds, sisterItem)).toEqual({ id: first.article!.id, wordCount: 300 });
    // Another outlet is not consulted.
    expect(await repo.findSameOutletPiece([bbcWorld.id], sisterItem)).toBeNull();
    // A different day is a different piece.
    expect(
      await repo.findSameOutletPiece(siblingIds, { ...sisterItem, publishedAt: new Date("2026-09-14T15:00:00Z") }),
    ).toBeNull();
    // The same URL matches regardless of date.
    expect(
      await repo.findSameOutletPiece(siblingIds, { url: first.article!.url, title: "Renamed", publishedAt: null }),
    ).toEqual({ id: first.article!.id, wordCount: 300 });
    // A row never matches itself: the retry path asks whether a SISTER feed
    // has covered the piece, and its own row is always sitting there.
    expect(await repo.findSameOutletPiece(siblingIds, first.article!, first.article!.id)).toBeNull();
  });
});

describe("findByContentHash is bounded to the context window", () => {
  it("ignores a same-hash row older than the window", async () => {
    const { article } = await ingestOne(nytUs, "Ancient wire copy", FULL);
    expect(await repo.findByContentHash(article!.contentHash, siblingsOf(nytUs))).not.toBeNull();
    await pool.query("UPDATE articles SET published_at = NOW() - INTERVAL '40 days' WHERE id = $1", [article!.id]);
    expect(await repo.findByContentHash(article!.contentHash, siblingsOf(nytUs))).toBeNull();
  });
});

describe("0002_article_syndication reverses", () => {
  it("drops the column and both constraints, leaves the rows, then re-applies", async () => {
    const before = await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM articles");

    // down() reverses exactly the last applied migration. Unwind until only
    // versions below 0002 remain, so a later migration does not leave this
    // test asserting against a schema where 0002 is still applied.
    const ledgerVersions = async () =>
      (await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")).rows.map(
        (r) => r.version,
      );
    while ((await ledgerVersions()).some((v) => v >= "0002")) {
      await migrate.down(migrationsDir);
    }

    const column = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'articles'
           AND column_name = 'syndicated_of_article_id'
       ) AS present`,
    );
    expect(column.rows[0]!.present).toBe(false);
    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('articles_headline_only_has_no_body', 'articles_not_syndicated_of_self')`,
    );
    expect(constraints.rows).toEqual([]);
    expect(await ledgerVersions()).toEqual(["0001"]);
    const after = await pool.query<{ n: string }>("SELECT COUNT(*) AS n FROM articles");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

    await migrate.up(migrationsDir);
    const { article } = await ingestOne(bbcWorld, "Alive after a round trip", EMPTY);
    expect(article!.extractionStatus).toBe("failed");
  }, 60_000);
});

describe("getArticleSummariesByIds", () => {
  it("returns an empty list for an empty request without querying", async () => {
    expect(await repo.getArticleSummariesByIds([])).toEqual([]);
  });

  it("returns exactly the requested ids, including a headline-only one, and excludes an unrequested id", async () => {
    const { article: full } = await ingestOne(bbcWorld, "S4 fixture: full body", FULL);
    const { article: headlineOnly } = await ingestOne(bbcWorld, "S4 fixture: headline only", EMPTY);
    const { article: other } = await ingestOne(bbcWorld, "S4 fixture: not requested", FULL);

    const rows = await repo.getArticleSummariesByIds([full!.id, headlineOnly!.id]);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([full!.id, headlineOnly!.id].sort((a, b) => a - b));
    expect(rows.some((r) => r.id === other!.id)).toBe(false);

    const headlineRow = rows.find((r) => r.id === headlineOnly!.id)!;
    expect(headlineRow.score).toBeNull();
    expect(headlineRow.excerpt).toBeNull();
    expect(headlineRow.title).toBe("S4 fixture: headline only");

    const fullRow = rows.find((r) => r.id === full!.id)!;
    // No score has been written for this fixture, so an unscored full-body
    // article is indistinguishable from headline-only here — that is
    // rowToScoreDTO's existing, already-tested null handling, not new
    // behaviour this function adds.
    expect(fullRow.score).toBeNull();
    expect(fullRow.title).toBe("S4 fixture: full body");
  });
});

// Migration 0006 (Max, 2026-09-27): the furniture filter's story text is what
// every reader sees, raw_text is never touched, and a body upgrade drops a
// filter result computed on the old body.
describe("clean_text from the furniture filter", () => {
  const story = Array.from({ length: 120 }, (_, i) => `story${i}`).join(" ");
  const withCaption = `${story}\n\nRobert F. Bukaty/AP Photo\n\n${story} again`;

  it("reads back the clean text, keeps raw_text, and stores what was set aside", async () => {
    const { article } = await ingestOne(bbcWorld, "Budget passes with a caption", { text: withCaption, wordCount: 241, via: "publisher" });
    expect(article!.cleaned).toBe(false);
    const clean = `${story}\n\n${story} again`;
    await repo.setCleanText(article!.id, clean, [{ index: 1, class: "caption", confidence: 0.97, text: "Robert F. Bukaty/AP Photo" }]);
    const read = await repo.findArticleById(article!.id);
    expect(read!.rawText).toBe(clean);
    expect(read!.cleaned).toBe(true);
    const row = (await pool.query(`SELECT raw_text, furniture FROM articles WHERE id = $1`, [article!.id])).rows[0];
    expect(row.raw_text).toBe(withCaption);
    expect(row.furniture).toEqual([{ index: 1, class: "caption", confidence: 0.97, text: "Robert F. Bukaty/AP Photo" }]);
  });

  it("drops a stale filter result when the body is upgraded", async () => {
    const thin = Array.from({ length: 120 }, (_, i) => `thinner${i}`).join(" ");
    const { article } = await ingestOne(bbcWorld, "Thin, then filtered, then upgraded", { text: thin, wordCount: 120, via: "publisher" });
    await repo.setCleanText(article!.id, thin, []);
    const up = { rawText: BODY, wordCount: 300, extractionStatus: "full" as const, extractedVia: "publisher" as const, paywallFlag: false, contentHash: "clean-upgrade-hash", syndicatedOfArticleId: null };
    const upgraded = await repo.upgradeThinArticle(article!.id, up, 200);
    expect(upgraded!.rawText).toBe(BODY);
    expect(upgraded!.cleaned).toBe(false);
  });
});
