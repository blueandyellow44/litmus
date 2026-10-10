import { describe, expect, it } from "vitest";
import type { Queryable } from "../db/repos/storiesRepo.js";
import {
  fullTextCandidateQuery,
  lexicalCandidateScore,
  listUnassignedStoryArticles,
  properNouns,
  retrieveCandidateStories,
  type StoryArticle,
} from "./retrieval.js";

function article(over: Partial<StoryArticle> = {}): StoryArticle {
  return {
    id: 1,
    title: "Anthropic updates Claude after White House meeting",
    url: "https://example.test/1",
    outletKey: "example",
    outletName: "Example",
    sourceLean: "center",
    publishedAt: new Date("2026-09-13T12:00:00Z"),
    fetchedAt: new Date("2026-09-13T12:05:00Z"),
    extractionStatus: "full",
    wordCount: 500,
    syndicatedOfArticleId: null,
    articleSummary: "Dario Amodei met White House officials.",
    reactingTo: null,
    section: "technology",
    ...over,
  };
}

function storyRow(id: string, headline: string, rank: number, updatedAt = "2026-09-13T11:00:00Z") {
  return {
    id,
    headline,
    event_statement: `${headline} happens.`,
    section: "technology",
    first_seen_at: new Date("2026-09-13T10:00:00Z"),
    updated_at: new Date(updatedAt),
    member_headlines: [headline],
    member_article_ids: [10],
    outlet_keys: ["example"],
    text_rank: rank,
  };
}

function dbWith(rows: unknown[]): Queryable & { sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const query = (async (text: string, values?: unknown[]) => {
    sql.push(text);
    params.push(values ?? []);
    return { rows, rowCount: rows.length };
  }) as Queryable["query"];
  return {
    sql,
    params,
    query,
  };
}

describe("proper-noun retrieval", () => {
  it("deduplicates names and drops sentence furniture", () => {
    expect(properNouns("The White House met Dario Amodei. Dario Amodei spoke Sunday."))
      .toEqual(["White House", "Dario Amodei"]);
  });

  it("keeps short acronyms and does not match them inside longer words", () => {
    expect(properNouns("US and EU officials discuss AI rules in Iran.")).toEqual(["US", "EU", "AI", "Iran"]);
    const a = article({ title: "Iran announces a vote", articleSummary: null });
    const unrelated = {
      ...storyRow("st_x", "Iranian markets react", 0),
      eventStatement: "Iranian markets react.",
    };
    const card = {
      id: unrelated.id,
      headline: unrelated.headline,
      eventStatement: unrelated.event_statement,
      section: unrelated.section,
      firstSeenAt: unrelated.first_seen_at,
      updatedAt: unrelated.updated_at,
      memberHeadlines: unrelated.member_headlines,
      memberArticleIds: unrelated.member_article_ids,
      outletKeys: unrelated.outlet_keys,
    };
    expect(lexicalCandidateScore(a, card, 0)).toBe(0);
  });

  it("adds a distinct signal for shared names", () => {
    const a = article();
    const related = {
      id: "st_related",
      headline: "Dario Amodei meets White House officials",
      eventStatement: "Anthropic chief meets officials.",
      section: "technology",
      firstSeenAt: new Date(),
      updatedAt: new Date(),
      memberHeadlines: [],
      memberArticleIds: [],
      outletKeys: [],
    };
    const unrelated = { ...related, id: "st_other", headline: "Markets close higher", eventStatement: "Stocks rise." };
    expect(lexicalCandidateScore(a, related, 0)).toBeGreaterThan(lexicalCandidateScore(a, unrelated, 0));
  });

  it("reranks full-text results with shared proper nouns and applies the limit", async () => {
    const db = dbWith([
      storyRow("st_rank", "Markets close higher", 0.4),
      storyRow("st_name", "Dario Amodei meets White House officials", 0.05),
      storyRow("st_zero", "Sports result", 0),
    ]);
    const cards = await retrieveCandidateStories(article(), 1, 1, db);
    expect(cards.map((card) => card.id)).toEqual(["st_name"]);
    expect(db.params[0]?.[0]).toMatch(/ OR /);
  });

  it("builds a recall-oriented OR query instead of requiring every term", () => {
    expect(fullTextCandidateQuery(article())).toContain("anthropic OR");
  });
});

describe("unassigned eligibility", () => {
  it("has no score, word-count, extraction-status, or fetched-date eligibility filter", async () => {
    const db = dbWith([]);
    expect(await listUnassignedStoryArticles(14, db)).toEqual([]);
    const sql = db.sql[0]!.toLowerCase();
    expect(sql).not.toContain("join scores");
    expect(sql).not.toContain("word_count >");
    expect(sql).not.toContain("extraction_status =");
    expect(sql).not.toContain("a.fetched_at >=");
    expect(sql).toContain("a.published_at >=");
    expect(sql).not.toContain("coalesce(a.published_at, a.fetched_at)");
    expect(sql).not.toContain("sm.role = 'primary'");
    expect(sql).toContain("story_article_states");
  });

  it("refuses a non-positive or non-integer window", async () => {
    await expect(listUnassignedStoryArticles(0, dbWith([]))).rejects.toThrow("positive integer");
    await expect(listUnassignedStoryArticles(1.5, dbWith([]))).rejects.toThrow("positive integer");
  });
});
