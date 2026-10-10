import { describe, expect, it } from "vitest";
import type { StoryArticle, StoryCard } from "./retrieval.js";
import { assignArticleBatches, type StoryModelClient } from "./assignment.js";
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
    eventStatement: `Actor does act ${id} on one occasion.`,
    section: "world",
    firstSeenAt: new Date("2026-09-13T10:00:00Z"),
    updatedAt: new Date("2026-09-13T11:00:00Z"),
    memberHeadlines: ["Earlier report"],
    memberArticleIds: [900],
    outletKeys: ["earlier"],
  };
}

type ResponseFactory = (
  params: Record<string, unknown>,
  call: number,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

function client(factory: ResponseFactory): StoryModelClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return factory(params, calls.length);
      },
    },
  };
}

function response(decisions: unknown, stopReason = "tool_use") {
  return {
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: "tool_use", name: "submit_story_decisions", input: { decisions } }],
  };
}

const USAGE_LIMIT =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}';

const withStatus = (status: number, message: string) => Object.assign(new Error(message), { status });

function offeredIds(params: Record<string, unknown>): number[] {
  const messages = params.messages as Array<{ content: string }>;
  const parsed = JSON.parse(messages[0]!.content.slice(messages[0]!.content.indexOf("{"))) as {
    articles: Array<{ article_id: number }>;
  };
  return parsed.articles.map((entry) => entry.article_id);
}

function newDecision(articleId: number) {
  return {
    article_id: articleId,
    action: "new",
    new_story_key: `event-${articleId}`,
    headline: `Event ${articleId}`,
    event_statement: `Actor does one act for event ${articleId}.`,
    confidence: "high",
    reason: "No candidate is the same event.",
  };
}

describe("assignArticleBatches", () => {
  it("does not call the model for empty input", async () => {
    const stub = client(() => response([]));
    const result = await assignArticleBatches([], new Map(), { client: stub });
    expect(result.decisions).toEqual([]);
    expect(result.calls).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("accepts one valid decision for every offered article", async () => {
    const stub = client((params) => response(offeredIds(params).map(newDecision)));
    const articles = [article(1), article(2)];
    const result = await assignArticleBatches(articles, new Map(), { client: stub });
    expect(result.decisions.map((decision) => decision.articleId)).toEqual([1, 2]);
    expect(result.decisions.every((decision) => decision.action === "new")).toBe(true);
  });

  it("retries only duplicated and missing ids, then reconciles exactly once", async () => {
    const stub = client((params, call) => {
      const ids = offeredIds(params);
      if (call === 1) {
        return response([newDecision(ids[0]!), newDecision(ids[0]!), newDecision(999)]);
      }
      return response(ids.map(newDecision));
    });
    const result = await assignArticleBatches([article(1), article(2)], new Map(), { client: stub });
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls.slice(1).map(offeredIds)).toEqual([[1], [2]]);
    expect(result.decisions.map((decision) => decision.articleId)).toEqual([1, 2]);
  });

  it("flags an article after two malformed answers instead of inventing a join", async () => {
    const stub = client(() => response([{ article_id: 1, action: "attach", reason: "Missing story id." }]));
    const result = await assignArticleBatches([article(1)], new Map(), { client: stub });
    expect(stub.calls).toHaveLength(2);
    expect(result.decisions).toEqual([
      { articleId: 1, action: "flag", reason: "Model decision invalid after retry." },
    ]);
  });

  it("rejects an attachment to a story that was not offered to that article", async () => {
    const stub = client(() =>
      response([{
        article_id: 1,
        action: "attach",
        story_ids: ["st_not_offered"],
        role: "primary",
        reason: "Same event.",
      }]),
    );
    const result = await assignArticleBatches(
      [article(1)],
      new Map([[1, [story("st_offered")]]]),
      { client: stub },
    );
    expect(result.decisions[0]).toEqual({
      articleId: 1,
      action: "flag",
      reason: "Model decision invalid after retry.",
    });
  });

  it("accepts a roundup as a secondary member of several offered stories", async () => {
    const stub = client(() => response([{
      article_id: 1,
      action: "attach",
      story_ids: ["st_a", "st_b"],
      role: "secondary",
      confidence: "high",
      reason: "Roundup reports both events.",
    }]));
    const result = await assignArticleBatches(
      [article(1)],
      new Map([[1, [story("st_a"), story("st_b")]]]),
      { client: stub },
    );
    expect(result.decisions[0]).toEqual({
      articleId: 1,
      action: "attach",
      storyIds: ["st_a", "st_b"],
      role: "secondary",
      confidence: "high",
      reason: "Roundup reports both events.",
    });
  });

  it("rejects several primary targets and repeated secondary targets", async () => {
    for (const malformed of [
      { article_id: 1, action: "attach", story_ids: ["st_a", "st_b"], role: "primary", reason: "Same." },
      { article_id: 1, action: "attach", story_ids: ["st_a", "st_a"], role: "secondary", reason: "Same." },
    ]) {
      const stub = client(() => response([malformed]));
      const result = await assignArticleBatches(
        [article(1)],
        new Map([[1, [story("st_a"), story("st_b")]]]),
        { client: stub },
      );
      expect(result.decisions[0]?.action).toBe("flag");
    }
  });

  it("halves a truncated batch and never accepts the partial tool payload", async () => {
    const stub = client((params, call) => {
      const ids = offeredIds(params);
      if (call === 1) return response(ids.slice(0, 1).map(newDecision), "max_tokens");
      return response(ids.map(newDecision));
    });
    const result = await assignArticleBatches(
      [article(1), article(2), article(3), article(4)],
      new Map(),
      { client: stub, batchSize: 4 },
    );
    expect(stub.calls.map(offeredIds)).toEqual([[1, 2, 3, 4], [1, 2], [3, 4]]);
    expect(result.decisions.map((decision) => decision.articleId)).toEqual([1, 2, 3, 4]);
  });

  it("bounds recursive calls at the requested concurrency", async () => {
    let active = 0;
    let peak = 0;
    const stub = client(async (params) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return response(offeredIds(params), "max_tokens");
    });
    const result = await assignArticleBatches(
      Array.from({ length: 40 }, (_, index) => article(index + 1)),
      new Map(),
      { client: stub, batchSize: 10, concurrency: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(result.decisions).toHaveLength(40);
    expect(result.decisions.every((decision) => decision.action === "flag")).toBe(true);
  });

  it("retries a wholly malformed batch in smaller pieces", async () => {
    const stub = client((params, call) => {
      const ids = offeredIds(params);
      if (call === 1) return response([]);
      return response(ids.map(newDecision));
    });
    const result = await assignArticleBatches(
      [article(1), article(2), article(3), article(4)],
      new Map(),
      { client: stub, batchSize: 4 },
    );
    expect(stub.calls.map(offeredIds)).toEqual([[1, 2, 3, 4], [1, 2], [3, 4]]);
    expect(result.decisions.every((decision) => decision.action === "new")).toBe(true);
  });

  it("degrades a rejected request through bounded smaller calls", async () => {
    const stub = client(() => {
      throw new Error("fixture outage");
    });
    const result = await assignArticleBatches(
      [article(1), article(2), article(3), article(4)],
      new Map(),
      { client: stub, batchSize: 4, concurrency: 2 },
    );
    expect(result.decisions).toHaveLength(4);
    expect(result.decisions.every((decision) => decision.action === "flag")).toBe(true);
    expect(result.calls).toBe(7);
  });

  it("ends the run on a locked account instead of splitting and flagging (2026-09-22)", async () => {
    const stub = client(() => {
      throw Object.assign(
        new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}'),
        { status: 400 },
      );
    });
    await expect(
      assignArticleBatches([article(1), article(2), article(3), article(4)], new Map(), { client: stub, batchSize: 4 }),
    ).rejects.toThrow(FatalModelError);
    // One call, no half-batch retries.
    expect(stub.calls).toHaveLength(1);
  });

  // Codex review of a9d3a56 (2026-09-26): 200 articles at concurrency 5 still
  // attempted all eight batches after fatal usage-limit errors, and the
  // rejection reached the caller while sibling calls were still in flight.
  it("starts no queued batch after a fatal error and settles in-flight calls before rejecting", async () => {
    const usage: Array<{ status: string; callIndex: number }> = [];
    const stub = client(async (params, call) => {
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw withStatus(400, USAGE_LIMIT);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      return response(offeredIds(params).map(newDecision));
    });
    let usageAtReject = -1;
    const run = assignArticleBatches(
      Array.from({ length: 200 }, (_, index) => article(index + 1)),
      new Map(),
      { client: stub, batchSize: 25, concurrency: 5, onUsage: (entry) => { usage.push(entry); } },
    ).catch((error: unknown) => {
      usageAtReject = usage.length;
      throw error;
    });
    await expect(run).rejects.toThrow(FatalModelError);
    // Five calls were in flight when the first one failed; the other three
    // batches never started.
    expect(stub.calls).toHaveLength(5);
    // Every started call was accounted for before the caller saw the error.
    expect(usageAtReject).toBe(5);
    expect(usage.filter((entry) => entry.status === "failed")).toHaveLength(1);
    expect(usage.filter((entry) => entry.status === "succeeded")).toHaveLength(4);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stub.calls).toHaveLength(5);
    expect(usage).toHaveLength(5);
  });

  it("records every concurrent fatal failure and still starts nothing queued", async () => {
    const usage: Array<{ status: string }> = [];
    const stub = client(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw withStatus(400, USAGE_LIMIT);
    });
    await expect(
      assignArticleBatches(
        Array.from({ length: 200 }, (_, index) => article(index + 1)),
        new Map(),
        { client: stub, batchSize: 25, concurrency: 5, onUsage: (entry) => { usage.push(entry); } },
      ),
    ).rejects.toThrow(FatalModelError);
    expect(stub.calls).toHaveLength(5);
    expect(usage.map((entry) => entry.status)).toEqual(Array(5).fill("failed"));
  });

  it("does not start a split or retry call once a sibling hit a fatal error", async () => {
    const stub = client(async (params, call) => {
      if (call === 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw withStatus(400, USAGE_LIMIT);
      }
      // In flight when the fatal error lands; asks for a half-batch retry.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(offeredIds(params), "max_tokens");
    });
    await expect(
      assignArticleBatches(
        Array.from({ length: 8 }, (_, index) => article(index + 1)),
        new Map(),
        { client: stub, batchSize: 4, concurrency: 2 },
      ),
    ).rejects.toThrow(FatalModelError);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stub.calls).toHaveLength(2);
  });

  it("keeps retrying ordinary 429 and 529 rejections alongside successful batches", async () => {
    const usage: Array<{ status: string }> = [];
    const stub = client(async (params, call) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (call === 1) throw withStatus(429, "429 rate_limit_error");
      if (call === 2) throw withStatus(529, "529 overloaded_error");
      return response(offeredIds(params).map(newDecision));
    });
    const result = await assignArticleBatches(
      Array.from({ length: 8 }, (_, index) => article(index + 1)),
      new Map(),
      { client: stub, batchSize: 4, concurrency: 2, onUsage: (entry) => { usage.push(entry); } },
    );
    expect(result.decisions.every((decision) => decision.action === "new")).toBe(true);
    // Two rejected batches, each retried as two halves.
    expect(stub.calls).toHaveLength(6);
    expect(usage.filter((entry) => entry.status === "failed")).toHaveLength(2);
  });

  it("scales max_tokens, aggregates usage, and awaits per-call accounting", async () => {
    const accounted: number[] = [];
    const stub = client((params) => response(offeredIds(params).map(newDecision)));
    const result = await assignArticleBatches(
      Array.from({ length: 28 }, (_, index) => article(index + 1)),
      new Map(),
      {
        client: stub,
        batchSize: 25,
        onUsage: async ({ callIndex }) => {
          await Promise.resolve();
          accounted.push(callIndex);
        },
      },
    );
    expect(stub.calls.map((call) => call.max_tokens)).toEqual([16_000, 2_048]);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect(accounted.sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("validates action-specific fields", async () => {
    const malformed = [
      { article_id: 1, action: "new", reason: "No fields." },
      { article_id: 1, action: "attach", story_ids: [], role: "primary", reason: "No target." },
      { article_id: 1, action: "unknown", reason: "Unknown action." },
    ];
    for (const decision of malformed) {
      const stub = client(() => response([decision]));
      const result = await assignArticleBatches([article(1)], new Map(), { client: stub });
      expect(result.decisions[0]?.action).toBe("flag");
    }
  });

  // 2026-09-17: before this, a reason over 20 words dropped the WHOLE decision
  // (not just its wording), so an otherwise-correct "new" call fell through to
  // a retry and then a "flag" fallback. See the matching note in sweep.ts.
  it("truncates a reason over 20 words instead of discarding the decision under it", async () => {
    const longReason = "This is a genuinely new development with no candidate story that shares the same actors, act, or occasion here at all today";
    expect(longReason.split(/\s+/).length).toBeGreaterThan(20);
    const stub = client(() => response([{ ...newDecision(1), reason: longReason }]));
    const result = await assignArticleBatches([article(1)], new Map(), { client: stub });
    expect(stub.calls).toHaveLength(1);
    expect(result.decisions[0]?.action).toBe("new");
    expect(result.decisions[0]?.reason).toBe(`${longReason.split(/\s+/).slice(0, 20).join(" ")}…`);
  });

  it("refuses duplicate offered article ids before making a model call", async () => {
    const stub = client(() => response([]));
    await expect(assignArticleBatches([article(1), article(1)], new Map(), { client: stub })).rejects.toThrow(
      /offered more than once/,
    );
    expect(stub.calls).toHaveLength(0);
  });

  it("scales to realistic volume in bounded batches", async () => {
    const stub = client((params) => response(offeredIds(params).map(newDecision)));
    const articles = Array.from({ length: 650 }, (_, index) => article(index + 1));
    const result = await assignArticleBatches(articles, new Map(), {
      client: stub,
      batchSize: 25,
      concurrency: 5,
    });
    expect(result.decisions).toHaveLength(650);
    expect(stub.calls).toHaveLength(26);
    expect(stub.calls.every((call) => offeredIds(call).length <= 25)).toBe(true);
  });
});
