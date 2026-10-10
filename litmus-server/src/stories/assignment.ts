import { anthropic, models } from "../lib/anthropic.js";
import { logger } from "../lib/logger.js";
import type { StoryArticle, StoryCard } from "./retrieval.js";
import { ASSIGN_SYSTEM } from "./prompts.js";
import { CallSkippedError, rethrowIfFatal } from "./modelErrors.js";
import { ModelCallLimiter, settleAll } from "./concurrency.js";

export type StoryDecision =
  | {
      articleId: number;
      action: "attach";
      storyIds: string[];
      role: "primary" | "secondary";
      confidence: "high" | "medium" | "low";
      reason: string;
    }
  | {
      articleId: number;
      action: "new";
      newStoryKey: string;
      headline: string;
      eventStatement: string;
      confidence: "high" | "medium" | "low";
      reason: string;
    }
  | { articleId: number; action: "flag"; reason: string }
  | { articleId: number; action: "not_news"; reason: string };

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface AssignmentResult {
  decisions: StoryDecision[];
  usage: ModelUsage;
  calls: number;
}

interface StoryModelResponse {
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  content?: Array<{ type?: string; name?: string; input?: unknown }>;
}

export interface StoryModelClient {
  messages: {
    create(params: Record<string, unknown>): Promise<StoryModelResponse>;
  };
}

export interface AssignmentOptions {
  client?: StoryModelClient;
  batchSize?: number;
  concurrency?: number;
  model?: string;
  startingCallIndex?: number;
  onUsage?: (
    usage: ModelUsage & { model: string; stage: "assignment"; callIndex: number; wallMs: number; status: "succeeded" | "failed"; error: string | null },
  ) => void | Promise<void>;
}

const ASSIGN_TOOL = {
  name: "submit_story_decisions",
  description: "Return exactly one Story Ledger decision for every offered article.",
  input_schema: {
    type: "object" as const,
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
      properties: {
        article_id: { type: "integer" },
        action: { type: "string", enum: ["attach", "new", "flag", "not_news"] },
        story_ids: { type: "array", items: { type: "string" } },
        role: { type: "string", enum: ["primary", "secondary"] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        new_story_key: { type: "string" },
        headline: { type: "string" },
        event_statement: { type: "string" },
        reason: { type: "string" },
      },
          required: ["article_id", "action", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["decisions"],
    additionalProperties: false,
  },
};

const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
  };
}

function responseUsage(response: StoryModelResponse): ModelUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
  };
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function words(value: string): number {
  return value.trim() === "" ? 0 : value.trim().split(/\s+/).length;
}

function confidence(raw: unknown): "high" | "medium" | "low" | null {
  return raw === "high" || raw === "medium" || raw === "low" ? raw : null;
}

// 2026-09-17: truncate rather than discard on overflow — see the matching
// note in sweep.ts's shortReason. ASSIGN_SYSTEM already asks for at most 20
// words, so this is defense-in-depth, not the primary fix.
function shortReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim();
  if (reason === "") return null;
  if (words(reason) <= 20) return reason;
  return `${reason.split(/\s+/).slice(0, 20).join(" ")}…`;
}

function text(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value === "" ? null : value;
}

function normalizedStoryKey(raw: unknown): string | null {
  const value = text(raw)?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return value && value.length <= 80 ? value : null;
}

function candidateIds(articleId: number, candidates: ReadonlyMap<number, readonly StoryCard[]>): Set<string> {
  return new Set((candidates.get(articleId) ?? []).map((card) => card.id));
}

function parseDecision(
  raw: unknown,
  offeredId: number,
  candidates: ReadonlyMap<number, readonly StoryCard[]>,
): StoryDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (entry.article_id !== offeredId) return null;
  const reason = shortReason(entry.reason);
  if (!reason) return null;

  switch (entry.action) {
    case "attach": {
      const storyIds = Array.isArray(entry.story_ids)
        ? entry.story_ids.map(text).filter((value): value is string => value !== null)
        : [];
      const uniqueStoryIds = [...new Set(storyIds)];
      const role = entry.role === "primary" || entry.role === "secondary" ? entry.role : null;
      if (!role || uniqueStoryIds.length === 0 || uniqueStoryIds.length !== storyIds.length) return null;
      if (role === "primary" && uniqueStoryIds.length !== 1) return null;
      const offeredStories = candidateIds(offeredId, candidates);
      if (uniqueStoryIds.some((storyId) => !offeredStories.has(storyId))) return null;
      const confidenceLevel = confidence(entry.confidence);
      if (!confidenceLevel) return null;
      return { articleId: offeredId, action: "attach", storyIds: uniqueStoryIds, role, confidence: confidenceLevel, reason };
    }
    case "new": {
      const newStoryKey = normalizedStoryKey(entry.new_story_key);
      const headline = text(entry.headline);
      const eventStatement = text(entry.event_statement);
      const confidenceLevel = confidence(entry.confidence);
      if (!newStoryKey || !headline || !eventStatement || !confidenceLevel) return null;
      return {
        articleId: offeredId,
        action: "new",
        newStoryKey,
        headline,
        eventStatement,
        confidence: confidenceLevel,
        reason,
      };
    }
    case "flag":
      return { articleId: offeredId, action: "flag", reason };
    case "not_news":
      return { articleId: offeredId, action: "not_news", reason };
    default:
      return null;
  }
}

function payloadArticle(
  article: StoryArticle,
  candidates: ReadonlyMap<number, readonly StoryCard[]>,
  related: readonly StoryArticle[],
) {
  return {
    article_id: article.id,
    title: article.title,
    outlet: article.outletName,
    published_at: article.publishedAt?.toISOString() ?? null,
    summary: article.articleSummary,
    // Only present when the article itself explicitly frames its content as a
    // reaction to a named event/statement (see SAME_EVENT_RULE) - null means
    // the scorer found no such framing, not that none was checked for.
    reacting_to: article.reactingTo,
    extraction_status: article.extractionStatus,
    candidate_stories: (candidates.get(article.id) ?? []).slice(0, 20).map((card) => ({
      story_id: card.id,
      headline: card.headline,
      event_statement: card.eventStatement,
      first_seen_at: card.firstSeenAt.toISOString(),
      member_headlines: card.memberHeadlines.slice(0, 3),
    })),
    related_unassigned_articles: related.map((other) => ({ article_id: other.id, title: other.title })),
  };
}

const STOPWORDS = new Set([
  "about", "after", "against", "amid", "and", "before", "from", "into", "over", "says", "that", "the", "this", "with",
]);

function lexicalWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
  );
}

// The model sees the nearest same-run articles as well as persisted cards. This
// is the collision guard for parallel batches: related articles can emit one
// shared new_story_key, and all new decisions are resolved serially afterwards.
function relatedSameRun(article: StoryArticle, all: readonly StoryArticle[]): StoryArticle[] {
  const target = lexicalWords(`${article.title} ${article.articleSummary ?? ""}`);
  return all
    .filter((other) => other.id !== article.id)
    .map((other) => {
      const source = lexicalWords(`${other.title} ${other.articleSummary ?? ""}`);
      let shared = 0;
      for (const word of target) if (source.has(word)) shared++;
      return { other, shared };
    })
    .filter((entry) => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.other.id - b.other.id)
    .slice(0, 10)
    .map((entry) => entry.other);
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

interface BatchResult {
  decisions: StoryDecision[];
  usage: ModelUsage;
}

interface AssignmentContext {
  client: StoryModelClient;
  model: string;
  limiter: ModelCallLimiter;
  onUsage: AssignmentOptions["onUsage"];
  nextCallIndex: number;
}

function fallbackFlags(articles: readonly StoryArticle[], reason: string): StoryDecision[] {
  return articles.map((article) => ({ articleId: article.id, action: "flag", reason }));
}

async function assignBatch(
  batch: readonly StoryArticle[],
  allArticles: readonly StoryArticle[],
  candidates: ReadonlyMap<number, readonly StoryCard[]>,
  context: AssignmentContext,
  truncationDepth = 0,
  validationRetried = false,
): Promise<BatchResult> {
  const body = {
    articles: batch.map((article) => payloadArticle(article, candidates, relatedSameRun(article, allArticles))),
  };
  const callIndex = ++context.nextCallIndex;
  const startedAt = Date.now();
  let response: StoryModelResponse;
  try {
    response = await context.limiter.run(() =>
      context.client.messages.create({
        model: context.model,
        max_tokens: Math.min(32_000, Math.max(2_048, batch.length * 640)),
        system: ASSIGN_SYSTEM,
        tools: [ASSIGN_TOOL],
        tool_choice: { type: "tool", name: "submit_story_decisions" },
        messages: [{ role: "user", content: `Decide every article in this JSON.\n${JSON.stringify(body)}` }],
      }),
    );
  } catch (error) {
    // Another call already hit a fatal error; this one was never sent.
    if (error instanceof CallSkippedError) throw error.fatal;
    const message = error instanceof Error ? error.message : String(error);
    if (context.onUsage) {
      await context.onUsage({
        ...ZERO_USAGE,
        model: context.model,
        stage: "assignment",
        callIndex,
        wallMs: Math.max(0, Date.now() - startedAt),
        status: "failed",
        error: message,
      });
    }
    logger.error("story assignment model request failed", {
      articleIds: batch.map((article) => article.id),
      truncationDepth,
      error: message,
    });
    // Splitting the batch or flagging its articles cannot fix a locked
    // account or a bad key; end the run instead (modelErrors.ts).
    rethrowIfFatal(error);
    if (truncationDepth >= 2 || batch.length === 1) {
      return {
        decisions: fallbackFlags(batch, "Model request failed after bounded retries."),
        usage: { ...ZERO_USAGE },
      };
    }
    const midpoint = Math.ceil(batch.length / 2);
    const parts = await settleAll([
      assignBatch(batch.slice(0, midpoint), allArticles, candidates, context, truncationDepth + 1, validationRetried),
      assignBatch(batch.slice(midpoint), allArticles, candidates, context, truncationDepth + 1, validationRetried),
    ]);
    return {
      decisions: parts.flatMap((part) => part.decisions),
      usage: parts.reduce((sum, part) => addUsage(sum, part.usage), { ...ZERO_USAGE }),
    };
  }
  const usage = responseUsage(response);
  if (context.onUsage) {
    await context.onUsage({
      ...usage,
      model: context.model,
      stage: "assignment",
      callIndex,
      wallMs: Math.max(0, Date.now() - startedAt),
      status: "succeeded",
      error: null,
    });
  }

  if (response.stop_reason === "max_tokens") {
    logger.warn("story assignment response truncated", { articles: batch.length, truncationDepth });
    if (truncationDepth >= 2 || batch.length === 1) {
      return {
        decisions: fallbackFlags(batch, "Model response truncated after bounded retries."),
        usage,
      };
    }
    const midpoint = Math.ceil(batch.length / 2);
    const parts = await settleAll([
      assignBatch(batch.slice(0, midpoint), allArticles, candidates, context, truncationDepth + 1, validationRetried),
      assignBatch(batch.slice(midpoint), allArticles, candidates, context, truncationDepth + 1, validationRetried),
    ]);
    return {
      decisions: parts.flatMap((part) => part.decisions),
      usage: parts.reduce((sum, part) => addUsage(sum, part.usage), usage),
    };
  }

  const toolUse = response.content?.find(
    (block) => block.type === "tool_use" && block.name === "submit_story_decisions",
  );
  const rawInput = toolUse?.input;
  const rawDecisions =
    rawInput && typeof rawInput === "object" && Array.isArray((rawInput as { decisions?: unknown }).decisions)
      ? (rawInput as { decisions: unknown[] }).decisions
      : [];

  const offered = new Map(batch.map((article) => [article.id, article]));
  const byId = new Map<number, unknown[]>();
  for (const raw of rawDecisions) {
    if (!raw || typeof raw !== "object") continue;
    const id = (raw as { article_id?: unknown }).article_id;
    if (!Number.isInteger(id) || !offered.has(id as number)) continue;
    const entries = byId.get(id as number) ?? [];
    entries.push(raw);
    byId.set(id as number, entries);
  }

  const good: StoryDecision[] = [];
  const retry: StoryArticle[] = [];
  for (const article of batch) {
    const entries = byId.get(article.id) ?? [];
    const parsed = entries.length === 1 ? parseDecision(entries[0], article.id, candidates) : null;
    if (parsed) good.push(parsed);
    else retry.push(article);
  }

  if (retry.length === 0) return { decisions: good, usage };
  if (validationRetried) {
    return {
      decisions: [...good, ...fallbackFlags(retry, "Model decision invalid after retry.")].sort(
        (a, b) => batch.findIndex((article) => article.id === a.articleId) - batch.findIndex((article) => article.id === b.articleId),
      ),
      usage,
    };
  }

  logger.warn("story assignment decisions failed reconciliation; retrying affected articles", {
    articleIds: retry.map((article) => article.id),
  });
  const retryBatches = retry.length === batch.length && retry.length > 1
    ? batches(retry, Math.ceil(retry.length / 2))
    : [retry];
  const retried = await settleAll(
    retryBatches.map((part) => assignBatch(part, allArticles, candidates, context, truncationDepth, true)),
  );
  const resolved = new Map(
    [...good, ...retried.flatMap((part) => part.decisions)].map((decision) => [decision.articleId, decision]),
  );
  return {
    decisions: batch.map((article) => resolved.get(article.id)!),
    usage: retried.reduce((sum, part) => addUsage(sum, part.usage), usage),
  };
}

export async function assignArticleBatches(
  articles: readonly StoryArticle[],
  candidates: ReadonlyMap<number, readonly StoryCard[]>,
  options: AssignmentOptions = {},
): Promise<AssignmentResult> {
  if (articles.length === 0) return { decisions: [], usage: { ...ZERO_USAGE }, calls: 0 };
  const ids = new Set<number>();
  for (const article of articles) {
    if (!Number.isInteger(article.id) || article.id <= 0) throw new Error("article ids must be positive integers");
    if (ids.has(article.id)) throw new Error(`article ${article.id} was offered more than once`);
    ids.add(article.id);
  }

  const batchSize = requirePositiveInteger(options.batchSize ?? 25, "assignment batch size");
  const concurrency = requirePositiveInteger(options.concurrency ?? 5, "assignment concurrency");
  const model = options.model ?? models.stories;
  const client = options.client ?? (anthropic() as unknown as StoryModelClient);
  const startingCallIndex = options.startingCallIndex ?? 0;
  requireNonNegativeInteger(startingCallIndex, "starting call index");
  const context: AssignmentContext = {
    client,
    model,
    limiter: new ModelCallLimiter(concurrency),
    onUsage: options.onUsage,
    nextCallIndex: startingCallIndex,
  };
  const results = await settleAll(
    batches(articles, batchSize).map((batch) => assignBatch(batch, articles, candidates, context)),
  );
  const byId = new Map(results.flatMap((result) => result.decisions).map((decision) => [decision.articleId, decision]));
  return {
    decisions: articles.map((article) => byId.get(article.id)!),
    usage: results.reduce((sum, result) => addUsage(sum, result.usage), { ...ZERO_USAGE }),
    calls: context.nextCallIndex,
  };
}
