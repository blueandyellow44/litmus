import { anthropic, models } from "../lib/anthropic.js";
import { logger } from "../lib/logger.js";
import { SWEEP_SYSTEM } from "./prompts.js";
import type { ModelUsage, StoryModelClient } from "./assignment.js";
import type { StoryArticle, StoryCard } from "./retrieval.js";
import { CallSkippedError, rethrowIfFatal } from "./modelErrors.js";
import { ModelCallLimiter, settleAll } from "./concurrency.js";

export type SweepDecision =
  | { articleId: number; action: "attach"; storyIds: string[]; role: "primary" | "secondary"; reason: string }
  | { articleId: number; action: "none"; reason: string }
  | { articleId: number; action: "flag"; reason: string };

export interface SweepCheck {
  articleId: number;
  storyId: string;
  outcome: "excluded" | "match" | "uncertain";
  reason: string;
}

export interface ValidatedSweepBatch {
  shard: number;
  articleIds: number[];
  checkedByArticle: Map<number, number>;
  checks: SweepCheck[];
}

export interface SweepOptions {
  client?: StoryModelClient;
  articleBatchSize?: number;
  storyShardSize?: number;
  concurrency?: number;
  model?: string;
  seededStoryIds?: ReadonlyMap<number, string>;
  onUsage?: (
    usage: ModelUsage & { model: string; stage: "sweep"; callIndex: number; wallMs: number; status: "succeeded" | "failed"; error: string | null },
  ) => void | Promise<void>;
  onValidatedBatch?: (batch: ValidatedSweepBatch) => void | Promise<void>;
}

export interface SweepResult {
  decisions: SweepDecision[];
  checks: SweepCheck[];
  incompleteArticleIds: number[];
  usage: ModelUsage;
  calls: number;
}

interface SweepModelResponse {
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  content?: Array<{ type?: string; name?: string; input?: unknown }>;
}

const SWEEP_TOOL = {
  name: "submit_sweep_results",
  description: "Return exactly one exhaustive-sweep result for every offered article.",
  input_schema: {
    type: "object" as const,
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            article_id: { type: "integer" },
            action: { type: "string", enum: ["attach", "none", "flag"] },
            story_ids: { type: "array", items: { type: "string" } },
            role: { type: "string", enum: ["primary", "secondary"] },
            reason: { type: "string" },
          },
          required: ["article_id", "action", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
};

const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

function usageOf(response: SweepModelResponse): ModelUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

// 2026-09-17: the prompt now asks for at most 20 words (SWEEP_SYSTEM), but a
// model that occasionally runs long used to lose the whole decision here, not
// just its wording — the article fell through to "incomplete" and got
// automatically flagged with "Exhaustive sweep did not finish" even when the
// model had a perfectly good, correct verdict. A verbose explanation is not
// evidence the verdict is wrong, so this truncates for the audit trail
// instead of discarding the decision under it. See sweep.test.ts.
function shortReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const reason = raw.trim();
  if (!reason) return null;
  const words = reason.split(/\s+/);
  return words.length <= 20 ? reason : `${words.slice(0, 20).join(" ")}…`;
}

// 2026-09-26: the first completed real run rejected 365 of Haiku's own sweep
// answers as "failed schema validation" and flagged 141 of 155 articles for
// good. The prompt then asked for "the matching story_id, or null", which is
// not what the tool takes. The prompt now states the tool's fields, and the
// parser accepts the harmless variations (a missing reason, a missing role on
// a single match, the article's own story named as its match) instead of
// discarding a real verdict over them. A match to a card that was never
// offered is still refused.
const NO_REASON = "Model gave no reason.";

function parseDecision(
  raw: unknown,
  articleId: number,
  offered: ReadonlySet<string>,
  ownStoryId: string | null = null,
): SweepDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.article_id !== articleId) return null;
  const reason = shortReason(value.reason) ?? NO_REASON;
  if (value.action === "none") return { articleId, action: "none", reason };
  if (value.action === "flag") return { articleId, action: "flag", reason };
  if (value.action !== "attach") return null;
  const rawIds = Array.isArray(value.story_ids)
    ? value.story_ids
    : typeof value.story_id === "string" ? [value.story_id] : [];
  const storyIds = rawIds
    .filter((entry): entry is string => typeof entry === "string" && entry !== "")
    .filter((id) => id !== ownStoryId);
  const unique = [...new Set(storyIds)];
  if (unique.length === 0) return { articleId, action: "none", reason };
  if (unique.some((id) => !offered.has(id))) return null;
  const role = value.role === "primary" || value.role === "secondary" ? value.role : unique.length === 1 ? "primary" : null;
  if (!role || (role === "primary" && unique.length !== 1)) return null;
  return { articleId, action: "attach", storyIds: unique, role, reason };
}

interface Context {
  client: StoryModelClient;
  model: string;
  limiter: ModelCallLimiter;
  onUsage: SweepOptions["onUsage"];
  onValidatedBatch: SweepOptions["onValidatedBatch"];
  nextCallIndex: number;
}

interface BatchAttempt {
  decisions: SweepDecision[];
  checks: SweepCheck[];
  incomplete: number[];
  usage: ModelUsage;
}

function checksFor(
  decisions: readonly SweepDecision[],
  cardsByArticle: ReadonlyMap<number, readonly StoryCard[]>,
): SweepCheck[] {
  const checks: SweepCheck[] = [];
  for (const decision of decisions) {
    const selected = new Set(decision.action === "attach" ? decision.storyIds : []);
    for (const card of cardsByArticle.get(decision.articleId) ?? []) {
      checks.push({
        articleId: decision.articleId,
        storyId: card.id,
        outcome: decision.action === "flag" ? "uncertain" : selected.has(card.id) ? "match" : "excluded",
        reason: selected.has(card.id) || decision.action !== "attach"
          ? decision.reason
          : "Model found this card was not the same event.",
      });
    }
  }
  return checks;
}

async function persistValidated(
  shard: number,
  decisions: readonly SweepDecision[],
  cardsByArticle: ReadonlyMap<number, readonly StoryCard[]>,
  callback: SweepOptions["onValidatedBatch"],
): Promise<SweepCheck[]> {
  const checks = checksFor(decisions, cardsByArticle);
  if (callback && decisions.length > 0) {
    const articleIds = decisions.map((decision) => decision.articleId);
    await callback({
      shard,
      articleIds,
      checkedByArticle: new Map(articleIds.map((id) => [id, cardsByArticle.get(id)?.length ?? 0])),
      checks,
    });
  }
  return checks;
}

function storyPayload(card: StoryCard) {
  return {
    story_id: card.id,
    headline: card.headline,
    event_statement: card.eventStatement,
    first_seen_at: card.firstSeenAt.toISOString(),
    member_headlines: card.memberHeadlines.slice(0, 3),
  };
}

async function attemptBatch(
  articles: readonly StoryArticle[],
  cards: readonly StoryCard[],
  shard: number,
  seeded: ReadonlyMap<number, string>,
  context: Context,
  retried = false,
): Promise<BatchAttempt> {
  const cardsByArticle = new Map(
    articles.map((article) => [article.id, cards.filter((card) => card.id !== seeded.get(article.id))]),
  );
  // Cards once per request, not once per article (2026-09-26): repeating the
  // whole shard under all 25 articles made the sweep 3.44M input tokens and
  // 85% of a real run's cost. Each article names its own story instead, so the
  // model knows which card not to match.
  const body = {
    stories: cards.map(storyPayload),
    articles: articles.map((article) => ({
      article_id: article.id,
      title: article.title,
      outlet: article.outletName,
      published_at: article.publishedAt?.toISOString() ?? null,
      summary: article.articleSummary,
      reacting_to: article.reactingTo,
      own_story_id: seeded.get(article.id) ?? null,
    })),
  };
  const callIndex = ++context.nextCallIndex;
  const startedAt = Date.now();
  let response: SweepModelResponse;
  try {
    response = await context.limiter.run(() =>
      context.client.messages.create({
        model: context.model,
        max_tokens: Math.min(32_000, Math.max(2_048, articles.length * 320)),
        system: SWEEP_SYSTEM,
        tools: [SWEEP_TOOL],
        tool_choice: { type: "tool", name: "submit_sweep_results" },
        messages: [{ role: "user", content: `Check every article against every story supplied for it.\n${JSON.stringify(body)}` }],
      }) as Promise<SweepModelResponse>,
    );
  } catch (error) {
    // Another call already hit a fatal error; this one was never sent.
    if (error instanceof CallSkippedError) throw error.fatal;
    const message = error instanceof Error ? error.message : String(error);
    if (context.onUsage) {
      await context.onUsage({
        ...ZERO_USAGE,
        model: context.model,
        stage: "sweep",
        callIndex,
        wallMs: Math.max(0, Date.now() - startedAt),
        status: "failed",
        error: message,
      });
    }
    logger.error("story sweep model request failed", {
      shard,
      articleIds: articles.map((article) => article.id),
      error: message,
    });
    // Marking the articles incomplete would flag them for good; a fatal error
    // ends the run instead (modelErrors.ts).
    rethrowIfFatal(error);
    return { decisions: [], checks: [], incomplete: articles.map((article) => article.id), usage: { ...ZERO_USAGE } };
  }
  const usage = usageOf(response);
  if (context.onUsage) {
    await context.onUsage({
      ...usage,
      model: context.model,
      stage: "sweep",
      callIndex,
      wallMs: Math.max(0, Date.now() - startedAt),
      status: "succeeded",
      error: null,
    });
  }
  if (response.stop_reason === "max_tokens") {
    logger.warn("story sweep response truncated", { shard, articleIds: articles.map((article) => article.id) });
    if (retried || articles.length === 1) {
      return { decisions: [], checks: [], incomplete: articles.map((article) => article.id), usage };
    }
    const parts = await settleAll(
      chunks(articles, Math.ceil(articles.length / 2)).map((part) =>
        attemptBatch(part, cards, shard, seeded, context, true),
      ),
    );
    return {
      decisions: parts.flatMap((part) => part.decisions),
      checks: parts.flatMap((part) => part.checks),
      incomplete: parts.flatMap((part) => part.incomplete),
      usage: parts.reduce((sum, part) => addUsage(sum, part.usage), usage),
    };
  }

  const tool = response.content?.find((entry) => entry.type === "tool_use" && entry.name === "submit_sweep_results");
  const raw = tool?.input && typeof tool.input === "object" ? (tool.input as { results?: unknown }).results : null;
  const rawResults = Array.isArray(raw) ? raw : [];
  const grouped = new Map<number, unknown[]>();
  for (const entry of rawResults) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { article_id?: unknown }).article_id;
    if (!Number.isInteger(id) || !cardsByArticle.has(id as number)) continue;
    const values = grouped.get(id as number) ?? [];
    values.push(entry);
    grouped.set(id as number, values);
  }

  const valid: SweepDecision[] = [];
  const invalid: StoryArticle[] = [];
  const invalidReasons: Array<{ articleId: number; reason: string }> = [];
  for (const article of articles) {
    const entries = grouped.get(article.id) ?? [];
    const parsed = entries.length === 1
      ? parseDecision(entries[0], article.id, new Set(cardsByArticle.get(article.id)!.map((card) => card.id)), seeded.get(article.id) ?? null)
      : null;
    if (parsed) {
      valid.push(parsed);
    } else {
      invalid.push(article);
      invalidReasons.push({
        articleId: article.id,
        reason:
          entries.length === 0
            ? "no result entry"
            : entries.length > 1
              ? "duplicate result entries"
              : "result entry failed schema validation",
      });
    }
  }
  // Unlike the request-failure and truncation branches above, a response
  // that parses fine at the JSON level but is missing/malformed per-article
  // previously left sweepComplete: false with nothing in the logs to explain
  // why (found 2026-09-17 chasing a real run's silent sweepComplete: false).
  if (invalidReasons.length > 0) {
    logger.warn("story sweep response missing or invalid results for some articles", {
      shard,
      retried,
      invalid: invalidReasons,
      // What the model actually sent, so the next rejection explains itself.
      sample: invalid.slice(0, 2).map((article) => JSON.stringify(grouped.get(article.id) ?? null).slice(0, 400)),
    });
  }
  if (invalid.length > 0 && !retried) {
    const validChecks = await persistValidated(shard, valid, cardsByArticle, context.onValidatedBatch);
    const retryParts = invalid.length === articles.length && invalid.length > 1
      ? chunks(invalid, Math.ceil(invalid.length / 2))
      : [invalid];
    const retries = await settleAll(
      retryParts.map((part) => attemptBatch(part, cards, shard, seeded, context, true)),
    );
    const retryById = new Map(retries.flatMap((part) => part.decisions).map((decision) => [decision.articleId, decision]));
    const combined = articles
      .map((article) => valid.find((decision) => decision.articleId === article.id) ?? retryById.get(article.id))
      .filter((decision): decision is SweepDecision => decision !== undefined);
    return {
      decisions: combined,
      checks: [...validChecks, ...retries.flatMap((part) => part.checks)],
      incomplete: retries.flatMap((part) => part.incomplete),
      usage: retries.reduce((sum, part) => addUsage(sum, part.usage), usage),
    };
  }
  if (invalid.length > 0) {
    const validChecks = await persistValidated(shard, valid, cardsByArticle, context.onValidatedBatch);
    return {
      decisions: valid,
      checks: validChecks,
      incomplete: invalid.map((article) => article.id),
      usage,
    };
  }

  const checks = await persistValidated(shard, valid, cardsByArticle, context.onValidatedBatch);
  return { decisions: valid, checks, incomplete: [], usage };
}

// The candidate-story list is repeated in full for every article in a batch
// (each article's payload carries its own `stories` array), so a request's
// size is driven by articleBatchSize * storyShardSize, not either alone. At
// the Sonnet-tuned defaults (25 * 150 = 3,750 story-card repetitions) a real
// run overflowed Haiku 4.5's 200K context outright ("prompt is too long: ~450K
// tokens", 2026-09-19) - Haiku's window is far smaller than Sonnet 5's, and
// nothing here previously accounted for that. Shrink the shard, not the batch:
// fewer candidate cards per request still covers every story, just over more
// (smaller) requests, which is the exhaustive design's own intended lever.
function isHaikuModel(model: string): boolean {
  return model.toLowerCase().includes("haiku");
}

export async function sweepArticles(
  articles: readonly StoryArticle[],
  stories: readonly StoryCard[],
  options: SweepOptions = {},
): Promise<SweepResult> {
  if (articles.length === 0) return { decisions: [], checks: [], incompleteArticleIds: [], usage: { ...ZERO_USAGE }, calls: 0 };
  const model = options.model ?? models.stories;
  const articleBatchSize = positiveInteger(options.articleBatchSize ?? 25, "sweep article batch size");
  const storyShardSize = positiveInteger(
    options.storyShardSize ?? (isHaikuModel(model) ? 40 : 150),
    "sweep story shard size",
  );
  const concurrency = positiveInteger(options.concurrency ?? 5, "sweep concurrency");
  const seeded = options.seededStoryIds ?? new Map<number, string>();
  const context: Context = {
    client: options.client ?? (anthropic() as unknown as StoryModelClient),
    model,
    limiter: new ModelCallLimiter(concurrency),
    onUsage: options.onUsage,
    onValidatedBatch: options.onValidatedBatch,
    nextCallIndex: 0,
  };
  if (stories.length === 0) {
    return {
      decisions: articles.map((article) => ({ articleId: article.id, action: "none", reason: "No open story existed to check." })),
      checks: [],
      incompleteArticleIds: [],
      usage: { ...ZERO_USAGE },
      calls: 0,
    };
  }

  const attempts = await settleAll(
    chunks(stories, storyShardSize).flatMap((cards, shard) =>
      chunks(articles, articleBatchSize).map((batch) => attemptBatch(batch, cards, shard, seeded, context)),
    ),
  );
  const incomplete = new Set(attempts.flatMap((attempt) => attempt.incomplete));
  const perArticle = new Map<number, SweepDecision[]>();
  for (const decision of attempts.flatMap((attempt) => attempt.decisions)) {
    const values = perArticle.get(decision.articleId) ?? [];
    values.push(decision);
    perArticle.set(decision.articleId, values);
  }

  const decisions = articles.map<SweepDecision>((article) => {
    // An unfinished check is not evidence against the article: keep what
    // assignment decided (2026-09-26). Flagging here removed 141 articles for
    // good in the first real run. The run still reports sweepComplete false.
    if (incomplete.has(article.id)) return { articleId: article.id, action: "none", reason: "Exhaustive sweep did not finish; assignment decision kept." };
    const shardDecisions = perArticle.get(article.id) ?? [];
    if (shardDecisions.some((decision) => decision.action === "flag")) {
      return { articleId: article.id, action: "flag", reason: "Exhaustive sweep was ambiguous." };
    }
    const attachments = shardDecisions.filter(
      (decision): decision is Extract<SweepDecision, { action: "attach" }> => decision.action === "attach",
    );
    const primaryIds = [...new Set(attachments.filter((decision) => decision.role === "primary").flatMap((decision) => decision.storyIds))];
    const secondaryIds = [...new Set(attachments.filter((decision) => decision.role === "secondary").flatMap((decision) => decision.storyIds))];
    if (primaryIds.length > 1 || (primaryIds.length > 0 && secondaryIds.length > 0)) {
      return { articleId: article.id, action: "flag", reason: "Sweep returned conflicting story matches." };
    }
    if (primaryIds.length === 1) {
      return { articleId: article.id, action: "attach", storyIds: primaryIds, role: "primary", reason: attachments.find((d) => d.storyIds.includes(primaryIds[0]!))!.reason };
    }
    if (secondaryIds.length > 0) {
      return { articleId: article.id, action: "attach", storyIds: secondaryIds, role: "secondary", reason: "Roundup matched several events in exhaustive sweep." };
    }
    return { articleId: article.id, action: "none", reason: "No open story was the same event." };
  });

  return {
    decisions,
    checks: attempts.flatMap((attempt) => attempt.checks),
    incompleteArticleIds: [...incomplete].sort((a, b) => a - b),
    usage: attempts.reduce((sum, attempt) => addUsage(sum, attempt.usage), { ...ZERO_USAGE }),
    calls: context.nextCallIndex,
  };
}
