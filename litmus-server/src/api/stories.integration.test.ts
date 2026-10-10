import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { stopTestDatabase } from "../db/testDatabase.js";
import type { PHScore } from "../scoring/phScorer.js";

// listStoriesFeed against a real database: the query joins four tables and the
// DTO shape (excerpt building, framing notes, outlet counting) only proves out
// against real rows, not a mocked pool.

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
let scoresRepo: typeof import("../db/repos/scoresRepo.js");
let stories: typeof import("./stories.js");

let sourceId: number;
let otherSourceId: number;
let nextArticle = 0;

const LONG_PARAGRAPH =
  "The city council voted on Tuesday to approve the new transit funding measure after a lengthy public hearing that drew residents from every district. Supporters said the plan would cut commute times substantially, while critics questioned the financing structure and warned about cost overruns on similar projects elsewhere in the state.";

async function insertArticle(rawText: string | null = null, forSourceId = sourceId): Promise<number> {
  nextArticle += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO articles (source_id, url, title, extraction_status, content_hash, raw_text, published_at)
     VALUES ($1, $2, $3, 'full', $4, $5, NOW())
     RETURNING id`,
    [
      forSourceId,
      `https://example.test/a/${nextArticle}`,
      `Article ${nextArticle}`,
      `hash-${nextArticle}`,
      rawText ?? "",
    ],
  );
  return rows[0]!.id;
}

function score(articleId: number, over: Partial<PHScore> = {}): PHScore {
  return {
    articleId,
    headline: 2,
    language: 2,
    sourcing: 2,
    fallacies: 2,
    structure: 2,
    composite: 2.3,
    breakdown: {} as PHScore["breakdown"],
    flags: {} as PHScore["flags"],
    label: "Grounded",
    rationale: {
      headline: "h",
      language: "l",
      sourcing: "s",
      fallacies: "f",
      structure: "st",
      summary: "A grounded, sourced report on the transit vote.",
    },
    markers: [],
    excerptIndices: [0],
    politicalLean: 0,
    articleSummary: "The council approved transit funding.",
    reactingTo: null,
    section: "Politics",
    modelUsed: "test-fixture",
    ...over,
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "litmus-stories-api-pg-"));
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
  scoresRepo = await import("../db/repos/scoresRepo.js");
  stories = await import("./stories.js");

  await pool.query(await readFile(SCHEMA_PATH, "utf-8"));
  await migrate.up(migrationsDir);

  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO sources (name, rss_url, lean, type, paywall_status, reliability, enabled)
     VALUES ('Example', 'https://example.test/rss', 'center', 'digital-native', 'free', 3, TRUE)
     RETURNING id`,
  );
  sourceId = rows[0]!.id;
  const { rows: otherRows } = await pool.query<{ id: number }>(
    `INSERT INTO sources (name, rss_url, lean, type, paywall_status, reliability, enabled)
     VALUES ('Other Outlet', 'https://example.test/other-rss', 'left', 'digital-native', 'free', 3, TRUE)
     RETURNING id`,
  );
  otherSourceId = otherRows[0]!.id;
}, 180_000);

afterAll(async () => {
  // Waits for the pool's connections to close before the fast shutdown
  // (testDatabase.ts; the 2026-10-09 edition failed on this race).
  await stopTestDatabase({ pool, pg, databaseUrl: process.env.DATABASE_URL });
  await rm(dataDir, { recursive: true, force: true });
});

describe("listStoriesFeed", () => {
  it("assembles a full StoryDTO from real joined rows", async () => {
    const run = await repo.startStoryRun();
    await repo.finishStoryRun(run.id, { counts: { offered: 3 }, usage: {}, sweepComplete: true });

    const primaryA = await insertArticle(`${LONG_PARAGRAPH}\n\n${LONG_PARAGRAPH}`);
    const primaryB = await insertArticle(`${LONG_PARAGRAPH}\n\n${LONG_PARAGRAPH}`, otherSourceId);
    const headlineOnly = await insertArticle(null);
    await scoresRepo.insertScore(score(primaryA, { composite: 2.1 }));
    await scoresRepo.insertScore(score(primaryB, {
      composite: 3.4,
      breakdown: { composite: 3.4, base: 2.9, effectiveDimensions: { headline: 4, language: 2, sourcing: 3, fallacies: 1, structure: 3 }, raised: ["loaded headline together with an emotional lede"] },
      flags: { emotionalLede: true, loadedHeadline: true, fallacyCount: 0, oneSidedSourcing: false, opinionColumn: false, register: "news" },
      rationale: { headline: "The headline calls the vote a rout.", language: "l", sourcing: "s", fallacies: "f", structure: "st", summary: "The headline calls the vote a rout before the body reports it." },
    }));
    // headlineOnly is deliberately never scored.

    const story = await repo.insertStory({
      headline: "City approves transit funding",
      eventStatement: "The city council approved the transit funding measure.",
      section: "politics",
    });
    await repo.addStoryMember({
      storyId: story.id, articleId: primaryA, role: "primary", kind: "full",
      syndicatedOfArticleId: null, confidence: "high", reason: "seed", addedRunId: run.id,
    });
    await repo.addStoryMember({
      storyId: story.id, articleId: primaryB, role: "primary", kind: "full",
      syndicatedOfArticleId: null, confidence: "high", reason: "seed", addedRunId: run.id,
    });
    await repo.addStoryMember({
      storyId: story.id, articleId: headlineOnly, role: "secondary", kind: "headline_only",
      syndicatedOfArticleId: null, confidence: "medium", reason: "seed", addedRunId: run.id,
    });

    const [dto] = await stories.listStoriesFeed(pool);
    expect(dto).toBeDefined();
    expect(dto!.id).toBe(story.id);
    expect(dto!.headline).toBe("City approves transit funding");
    expect(dto!.assessment).toBeNull();
    expect(dto!.memberCount).toBe(3);
    expect(dto!.outletCount).toBe(2); // 2 distinct primary outlets; the headline-only member is secondary
    expect(dto!.singleOutlet).toBe(false);
    expect(dto!.phMin).toBe(2.1);
    expect(dto!.phMax).toBe(3.4);
    expect(dto!.coverage.sweepComplete).toBe(true);

    const memberA = dto!.members.find((m) => m.articleId === primaryA)!;
    expect(memberA.composite).toBe(2.1);
    expect(memberA.howItWasTold).toBe("A grounded, sourced report on the transit vote.");
    expect(memberA.excerpt).not.toBeNull();
    expect(memberA.excerpt!.paragraphs.length).toBeGreaterThan(0);

    // A score stored before the breakdown existed carries no heat; one with
    // the breakdown and flags names its driver and the floor that bound.
    expect(memberA.heat).toBeNull();
    const memberB = dto!.members.find((m) => m.articleId === primaryB)!;
    expect(memberB.heat).not.toBeNull();
    expect(memberB.heat!.driver).toBe("headline");
    expect(memberB.heat!.loadedHeadline).toBe(true);
    expect(memberB.heat!.emotionalLede).toBe(true);
    expect(memberB.heat!.floors).toEqual(["loaded headline together with an emotional lede"]);
    expect(memberB.heat!.note).toBe("The headline calls the vote a rout.");
    expect(memberB.heat!.lede).toBe(memberB.excerpt!.paragraphs[0]!.match(/^[^.!?]+[.!?]/)![0]);

    const memberHeadlineOnly = dto!.members.find((m) => m.articleId === headlineOnly)!;
    expect(memberHeadlineOnly.composite).toBeNull();
    expect(memberHeadlineOnly.excerpt).toBeNull();
  });

  it("excludes merged and dormant stories, includes only open ones", async () => {
    const openArticle = await insertArticle(LONG_PARAGRAPH);
    // A second, different-outlet member so this story clears the
    // single-outlet filter and the test still isolates the merged/dormant
    // behavior it is named for.
    const openArticleB = await insertArticle(LONG_PARAGRAPH, otherSourceId);
    const mergedArticle = await insertArticle(LONG_PARAGRAPH);
    await scoresRepo.insertScore(score(openArticle));
    await scoresRepo.insertScore(score(openArticleB));
    await scoresRepo.insertScore(score(mergedArticle));

    const openStory = await repo.insertStory({ headline: "Open story stays", eventStatement: "It stays.", section: null });
    await repo.addStoryMember({
      storyId: openStory.id, articleId: openArticle, role: "primary", kind: "full",
      syndicatedOfArticleId: null, confidence: "high", reason: "seed", addedRunId: null,
    });
    await repo.addStoryMember({
      storyId: openStory.id, articleId: openArticleB, role: "primary", kind: "full",
      syndicatedOfArticleId: null, confidence: "high", reason: "seed", addedRunId: null,
    });

    const survivorStory = await repo.insertStory({ headline: "Survivor", eventStatement: "It survives.", section: null });
    const mergedStory = await repo.insertStory({ headline: "Merged away", eventStatement: "It merges.", section: null });
    await repo.addStoryMember({
      storyId: mergedStory.id, articleId: mergedArticle, role: "primary", kind: "full",
      syndicatedOfArticleId: null, confidence: "high", reason: "seed", addedRunId: null,
    });
    await pool.query("UPDATE stories SET status = 'merged', merged_into = $2 WHERE id = $1", [mergedStory.id, survivorStory.id]);

    const dtos = await stories.listStoriesFeed(pool);
    const ids = dtos.map((d) => d.id);
    expect(ids).toContain(openStory.id);
    expect(ids).not.toContain(mergedStory.id);
    // survivorStory has no members, so it never appears either (the JOIN requires a member).
    expect(ids).not.toContain(survivorStory.id);
  });

  it("surfaces a set assessment instead of null", async () => {
    const article = await insertArticle(LONG_PARAGRAPH);
    const articleB = await insertArticle(LONG_PARAGRAPH, otherSourceId);
    await scoresRepo.insertScore(score(article));
    await scoresRepo.insertScore(score(articleB));
    const story = await repo.insertStory({ headline: "Assessed story", eventStatement: "It happened.", section: null });
    await repo.addStoryMember({
      storyId: story.id, articleId: article, role: "primary", kind: "full",
      syndicatedOfArticleId: null, confidence: "high", reason: "seed", addedRunId: null,
    });
    await repo.addStoryMember({
      storyId: story.id, articleId: articleB, role: "primary", kind: "full",
      syndicatedOfArticleId: null, confidence: "high", reason: "seed", addedRunId: null,
    });
    await pool.query(
      `UPDATE stories SET assessment_text = $2, assessment_model = $3, assessment_generated_at = NOW(), membership_hash = $4 WHERE id = $1`,
      [story.id, "What happened, plainly.", "test-model", "test-membership-hash"],
    );

    const dto = (await stories.listStoriesFeed(pool)).find((d) => d.id === story.id)!;
    expect(dto.assessment).not.toBeNull();
    expect(dto.assessment!.text).toBe("What happened, plainly.");
    expect(dto.assessment!.model).toBe("test-model");
  });

  it("excludes single-outlet stories - not \"sufficient sources\" to publish", async () => {
    // Found 2026-09-21: a failed/partial ledger run can leave hundreds of
    // never-merged single-article stubs open (685 in one real edition), and
    // shipping every one of them to the client is most of what made the
    // front page look hung.
    const article = await insertArticle(LONG_PARAGRAPH);
    await scoresRepo.insertScore(score(article));
    const thinStory = await repo.insertStory({ headline: "Solo outlet stub", eventStatement: "One outlet reported it.", section: null });
    await repo.addStoryMember({
      storyId: thinStory.id, articleId: article, role: "primary", kind: "full",
      syndicatedOfArticleId: null, confidence: "high", reason: "seed", addedRunId: null,
    });

    const dtos = await stories.listStoriesFeed(pool);
    expect(dtos.map((d) => d.id)).not.toContain(thinStory.id);
  });
});
