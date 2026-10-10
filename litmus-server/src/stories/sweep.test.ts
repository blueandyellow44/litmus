import { describe, expect, it } from "vitest";
import type { StoryModelClient } from "./assignment.js";
import type { StoryArticle, StoryCard } from "./retrieval.js";
import { sweepArticles } from "./sweep.js";
import { FatalModelError } from "./modelErrors.js";

function article(id: number): StoryArticle {
  return {
    id,
    title: `Article ${id}`,
    url: `https://example.test/${id}`,
    outletKey: `outlet-${id}`,
    outletName: `Outlet ${id}`,
    sourceLean: "center",
    publishedAt: new Date("2026-09-13T12:00:00Z"),
    fetchedAt: new Date("2026-09-13T12:05:00Z"),
    extractionStatus: "full",
    wordCount: 500,
    syndicatedOfArticleId: null,
    articleSummary: `Summary ${id}`,
    reactingTo: null,
    section: "world",
  };
}

function story(id: string): StoryCard {
  return {
    id,
    headline: `Story ${id}`,
    eventStatement: `Actor performs act ${id}.`,
    section: "world",
    firstSeenAt: new Date("2026-09-13T10:00:00Z"),
    updatedAt: new Date("2026-09-13T11:00:00Z"),
    memberHeadlines: [`Member ${id}`],
    memberArticleIds: [900],
    outletKeys: ["earlier"],
  };
}

function ids(params: Record<string, unknown>): number[] {
  const messages = params.messages as Array<{ content: string }>;
  const body = JSON.parse(messages[0]!.content.slice(messages[0]!.content.indexOf("{"))) as {
    articles: Array<{ article_id: number }>;
  };
  return body.articles.map((entry) => entry.article_id);
}

function storyIds(params: Record<string, unknown>, articleId: number): string[] {
  const messages = params.messages as Array<{ content: string }>;
  // Cards are sent once per request (2026-09-26); an article may match any of
  // them except its own story.
  const body = JSON.parse(messages[0]!.content.slice(messages[0]!.content.indexOf("{"))) as {
    stories: Array<{ story_id: string }>;
    articles: Array<{ article_id: number; own_story_id: string | null }>;
  };
  const own = body.articles.find((entry) => entry.article_id === articleId)!.own_story_id;
  return body.stories.map((entry) => entry.story_id).filter((id) => id !== own);
}

function response(results: unknown, stopReason = "tool_use") {
  return {
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: "tool_use", name: "submit_sweep_results", input: { results } }],
  };
}

function fake(factory: (params: Record<string, unknown>, call: number) => unknown): StoryModelClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return factory(params, calls.length) as never;
      },
    },
  };
}

function none(articleId: number) {
  return { article_id: articleId, action: "none", reason: "Different actors, act, or occasion." };
}

describe("sweepArticles", () => {
  it("does no model work for empty input or an empty ledger", async () => {
    const client = fake(() => response([]));
    expect(await sweepArticles([], [story("st_a")], { client })).toMatchObject({ calls: 0, decisions: [] });
    const result = await sweepArticles([article(1)], [], { client });
    expect(result.calls).toBe(0);
    expect(result.decisions[0]?.action).toBe("none");
  });

  it("shards 151 stories and batches 26 articles without losing a check", async () => {
    const client = fake((params) => response(ids(params).map(none)));
    const persisted: Array<{ shard: number; ids: number[]; counts: number[] }> = [];
    const result = await sweepArticles(
      Array.from({ length: 26 }, (_, index) => article(index + 1)),
      Array.from({ length: 151 }, (_, index) => story(`st_${index + 1}`)),
      {
        client,
        // Pinned explicitly: this test is about the sharding math at a
        // 150-card shard, independent of whatever models.stories defaults to
        // in production (Haiku's smaller default shard is covered by its own
        // test above).
        model: "claude-sonnet-5",
        onValidatedBatch: ({ shard, articleIds, checkedByArticle }) => {
          persisted.push({ shard, ids: articleIds, counts: articleIds.map((id) => checkedByArticle.get(id)!) });
        },
      },
    );
    expect(client.calls).toHaveLength(4);
    expect(result.checks).toHaveLength(26 * 151);
    expect(result.incompleteArticleIds).toEqual([]);
    expect(persisted).toHaveLength(4);
  });

  it("excludes a seeded singleton so a missed older story can win", async () => {
    const client = fake((params) => response([{
      article_id: 1,
      action: "attach",
      story_ids: ["st_older"],
      role: "primary",
      reason: "Same actors, act, and occasion.",
    }]));
    const result = await sweepArticles(
      [article(1)],
      [story("st_own"), story("st_older")],
      { client, seededStoryIds: new Map([[1, "st_own"]]) },
    );
    expect(storyIds(client.calls[0]!, 1)).toEqual(["st_older"]);
    expect(result.decisions[0]).toMatchObject({ action: "attach", storyIds: ["st_older"] });
  });

  it("ends the run on a locked account instead of marking articles incomplete (2026-09-22)", async () => {
    const client = fake(() => {
      throw Object.assign(new Error("400 You have reached your specified API usage limits."), { status: 400 });
    });
    await expect(sweepArticles([article(1), article(2)], [story("st_a")], { client })).rejects.toThrow(FatalModelError);
  });

  // Codex review of a9d3a56 (2026-09-26): the same queued-call and
  // unsettled-sibling defect as assignment.
  it("starts no queued batch after a fatal error and settles in-flight work before rejecting", async () => {
    const usage: Array<{ status: string }> = [];
    let persisted = 0;
    const client = fake(async (params, call) => {
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw Object.assign(new Error("400 You have reached your specified API usage limits."), { status: 400 });
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      return response(ids(params).map(none));
    });
    let atReject = { usage: -1, persisted: -1 };
    const run = sweepArticles(
      Array.from({ length: 200 }, (_, index) => article(index + 1)),
      [story("st_a")],
      {
        client,
        concurrency: 5,
        articleBatchSize: 25,
        onUsage: (entry) => { usage.push(entry); },
        onValidatedBatch: () => { persisted += 1; },
      },
    ).catch((error: unknown) => {
      atReject = { usage: usage.length, persisted };
      throw error;
    });
    await expect(run).rejects.toThrow(FatalModelError);
    expect(client.calls).toHaveLength(5);
    expect(atReject).toEqual({ usage: 5, persisted: 4 });
    expect(usage.filter((entry) => entry.status === "failed")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(client.calls).toHaveLength(5);
    expect(usage).toHaveLength(5);
  });

  it("keeps a 529 as an incomplete batch, not a fatal stop", async () => {
    const client = fake(async (params, call) => {
      if (call === 1) throw Object.assign(new Error("529 overloaded_error"), { status: 529 });
      return response(ids(params).map(none));
    });
    const result = await sweepArticles([article(1), article(2), article(3)], [story("st_a")], {
      client,
      concurrency: 2,
      articleBatchSize: 1,
    });
    expect(client.calls).toHaveLength(3);
    expect(result.incompleteArticleIds).toEqual([1]);
  });

  it("does not credit a malformed shard and reports it incomplete after one smaller retry", async () => {
    const client = fake(() => response([]));
    let persisted = 0;
    const result = await sweepArticles([article(1), article(2)], [story("st_a")], {
      client,
      onValidatedBatch: () => { persisted += 1; },
    });
    expect(persisted).toBe(0);
    expect(result.incompleteArticleIds).toEqual([1, 2]);
    // An unfinished check keeps assignment's decision instead of flagging the
    // article for good (2026-09-26); the run still reports it incomplete.
    expect(result.decisions.every((decision) => decision.action === "none")).toBe(true);
    expect(client.calls.map(ids)).toEqual([[1, 2], [1], [2]]);
  });

  it("truncates a reason over 20 words instead of discarding the decision under it", async () => {
    const longReason = "This article discusses a related but ultimately distinct occasion involving different actors and a separate act entirely from the story card offered here today";
    expect(longReason.split(/\s+/).length).toBeGreaterThan(20);
    const client = fake(() => response([{ article_id: 1, action: "none", reason: longReason }]));
    const result = await sweepArticles([article(1)], [story("st_a")], { client });
    // The parsed decision was credited, not lost to a retry — sweepArticles's
    // own aggregation always writes a fixed reason for the final "none"
    // outcome, so the truncation is visible on the per-story check instead.
    expect(result.incompleteArticleIds).toEqual([]);
    expect(client.calls).toHaveLength(1);
    expect(result.decisions).toEqual([{ articleId: 1, action: "none", reason: "No open story was the same event." }]);
    expect(result.checks).toEqual([{
      articleId: 1,
      storyId: "st_a",
      outcome: "excluded",
      reason: `${longReason.split(/\s+/).slice(0, 20).join(" ")}…`,
    }]);
  });

  it("credits a valid first-pass article while retrying only its malformed peer", async () => {
    const client = fake((params, call) => {
      const offered = ids(params);
      if (call === 1) return response([none(offered[0]!), { article_id: offered[1], action: "bad", reason: "Bad." }]);
      return response(offered.map(none));
    });
    const credited = new Map<number, number>();
    const result = await sweepArticles([article(1), article(2)], [story("st_a"), story("st_b")], {
      client,
      onValidatedBatch: ({ articleIds, checkedByArticle }) => {
        for (const id of articleIds) credited.set(id, (credited.get(id) ?? 0) + checkedByArticle.get(id)!);
      },
    });
    expect(client.calls.map(ids)).toEqual([[1, 2], [2]]);
    expect(credited).toEqual(new Map([[1, 2], [2, 2]]));
    expect(result.checks).toHaveLength(4);
    expect(result.incompleteArticleIds).toEqual([]);
  });

  it("flags conflicting primary matches from separate shards", async () => {
    const client = fake((params) => {
      const match = storyIds(params, 1)[0]!;
      return response([{
        article_id: 1,
        action: "attach",
        story_ids: [match],
        role: "primary",
        reason: "Same event.",
      }]);
    });
    const result = await sweepArticles([article(1)], [story("st_a"), story("st_b")], {
      client,
      storyShardSize: 1,
    });
    expect(result.decisions[0]).toMatchObject({ action: "flag" });
  });

  it("supports a roundup matching several stories as secondary", async () => {
    const client = fake((params) => response([{
      article_id: 1,
      action: "attach",
      story_ids: storyIds(params, 1),
      role: "secondary",
      reason: "Roundup reports each event.",
    }]));
    const result = await sweepArticles([article(1)], [story("st_a"), story("st_b")], { client });
    expect(result.decisions[0]).toMatchObject({ action: "attach", role: "secondary", storyIds: ["st_a", "st_b"] });
  });

  it("rejects partial truncated output and accumulates every paid call", async () => {
    const client = fake((params, call) => call === 1
      ? response([none(ids(params)[0]!)], "max_tokens")
      : response(ids(params).map(none)));
    const result = await sweepArticles(
      [article(1), article(2), article(3), article(4)],
      [story("st_a")],
      { client, articleBatchSize: 4 },
    );
    expect(client.calls.map(ids)).toEqual([[1, 2, 3, 4], [1, 2], [3, 4]]);
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 15 });
    expect(result.decisions.every((decision) => decision.action === "none")).toBe(true);
  });

  it("shards Haiku into smaller story batches than Sonnet, unless overridden", async () => {
    const cards = Array.from({ length: 45 }, (_, i) => story(`st_${i}`));
    const client = fake((params) => response(ids(params).map(none)));

    await sweepArticles([article(1)], cards, { client, model: "claude-haiku-4-5" });
    // 45 stories over a 40-card shard needs 2 requests; each must stay <= 40.
    expect(client.calls).toHaveLength(2);
    for (const call of client.calls) expect(storyIds(call, 1).length).toBeLessThanOrEqual(40);

    client.calls.length = 0;
    await sweepArticles([article(1)], cards, { client, model: "claude-sonnet-5" });
    // 45 stories fit inside Sonnet's 150-card shard in one request.
    expect(client.calls).toHaveLength(1);
    expect(storyIds(client.calls[0]!, 1)).toHaveLength(45);

    client.calls.length = 0;
    await sweepArticles([article(1)], cards, { client, model: "claude-haiku-4-5", storyShardSize: 10 });
    expect(client.calls).toHaveLength(5);
  });

  // The first completed real run (2026-09-26) rejected 365 answers this way.
  it("accepts a missing reason, a missing role on one match, and a singular story_id", async () => {
    const client = fake((params) => response(ids(params).map((articleId) => (
      articleId === 1 ? { article_id: 1, action: "attach", story_id: "st_a" }
        : articleId === 2 ? { article_id: 2, action: "none" }
          : { article_id: 3, action: "attach", story_ids: ["st_a"], reason: "Same actors, act, and occasion." }
    ))));
    const result = await sweepArticles([article(1), article(2), article(3)], [story("st_a")], { client });
    expect(result.incompleteArticleIds).toEqual([]);
    expect(result.decisions.map((d) => d.action)).toEqual(["attach", "none", "attach"]);
    expect(result.decisions[0]).toMatchObject({ storyIds: ["st_a"], role: "primary", reason: "Model gave no reason." });
  });

  it("reads a match to the article's own story as no match, not an invalid answer", async () => {
    const client = fake((params) => response(ids(params).map((articleId) => ({
      article_id: articleId, action: "attach", story_ids: ["st_own"], role: "primary", reason: "Same event.",
    }))));
    const result = await sweepArticles([article(1)], [story("st_own"), story("st_other")], {
      client,
      seededStoryIds: new Map([[1, "st_own"]]),
    });
    expect(result.incompleteArticleIds).toEqual([]);
    expect(result.decisions[0]?.action).toBe("none");
  });

  it("still refuses a match to a card that was never offered", async () => {
    const client = fake((params) => response(ids(params).map((articleId) => ({
      article_id: articleId, action: "attach", story_ids: ["st_invented"], role: "primary", reason: "Same event.",
    }))));
    const result = await sweepArticles([article(1)], [story("st_a")], { client });
    expect(result.incompleteArticleIds).toEqual([1]);
    expect(result.decisions[0]?.action).toBe("none");
  });

  it("sends each story card once per request, not once per article", async () => {
    const client = fake((params) => response(ids(params).map(none)));
    await sweepArticles([article(1), article(2), article(3)], [story("st_a"), story("st_b")], { client });
    const content = (client.calls[0]!.messages as Array<{ content: string }>)[0]!.content;
    expect(content.split('"story_id":"st_a"').length - 1).toBe(1);
  });
});
