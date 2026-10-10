import { anthropic, models } from "../lib/anthropic.js";
import { pool } from "../db/client.js";
import type { Queryable } from "../db/repos/storiesRepo.js";
import { CRITIC_SYSTEM } from "./prompts.js";
import type { ModelUsage, StoryModelClient } from "./assignment.js";
import { listOpenStoryCards, properNouns, type StoryCard } from "./retrieval.js";
import type { StorySplitGroup } from "./ledger.js";

export interface CriticMember {
  articleId: number;
  title: string;
  publishedAt: Date | null;
  confidence: "high" | "medium" | "low";
  gainedThisRun: boolean;
}

export interface CriticStory {
  card: StoryCard;
  primaryMembers: CriticMember[];
  anchorArticleId: number | null;
}

export async function loadCriticStories(runId: number, days: number, db: Queryable = pool): Promise<CriticStory[]> {
  const [cards, memberResult] = await Promise.all([
    listOpenStoryCards(days, db),
    db.query<{
      story_id: string;
      article_id: number;
      title: string;
      published_at: Date | null;
      confidence: "high" | "medium" | "low";
      gained_this_run: boolean;
      anchor_article_id: number | null;
    }>(
      `SELECT sm.story_id, sm.article_id, a.title, a.published_at, sm.confidence, st.anchor_article_id,
              (sm.added_run_id = $1) AS gained_this_run
       FROM story_members sm
       JOIN stories st ON st.id = sm.story_id AND st.status <> 'merged'
       JOIN articles a ON a.id = sm.article_id
       WHERE sm.role = 'primary'
       ORDER BY sm.story_id, a.published_at NULLS LAST, sm.article_id`,
      [runId],
    ),
  ]);
  const byStory = new Map<string, CriticMember[]>();
  const anchorByStory = new Map<string, number | null>();
  for (const row of memberResult.rows) {
    const members = byStory.get(row.story_id) ?? [];
    members.push({
      articleId: row.article_id,
      title: row.title,
      publishedAt: row.published_at,
      confidence: row.confidence,
      gainedThisRun: row.gained_this_run,
    });
    byStory.set(row.story_id, members);
    anchorByStory.set(row.story_id, row.anchor_article_id);
  }
  return cards.map((card) => ({
    card,
    primaryMembers: byStory.get(card.id) ?? [],
    anchorArticleId: anchorByStory.get(card.id) ?? null,
  }));
}

export interface CriticOptions {
  client?: StoryModelClient;
  model?: string;
  callIndex?: number;
  onUsage?: (
    usage: ModelUsage & { model: string; stage: "critic"; callIndex: number; wallMs: number; status: "succeeded" | "failed"; error: string | null },
  ) => void | Promise<void>;
}

export interface SplitReview {
  storyId: string;
  anchorArticleId: number;
  groups: StorySplitGroup[];
  reason: string;
  valid: boolean;
}

export interface MergeReview {
  leftStoryId: string;
  rightStoryId: string;
  decision: "yes" | "no" | "unsure";
  reason: string;
}

const SPLIT_TOOL = {
  name: "submit_split_review",
  description: "Partition every primary article into one-development groups.",
  input_schema: {
    type: "object" as const,
    properties: {
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            headline: { type: "string" },
            event_statement: { type: "string" },
            article_ids: { type: "array", items: { type: "integer" } },
          },
          required: ["headline", "event_statement", "article_ids"],
          additionalProperties: false,
        },
      },
      reason: { type: "string" },
    },
    required: ["groups", "reason"],
    additionalProperties: false,
  },
};

const MERGE_TOOL = {
  name: "submit_merge_review",
  description: "Say yes only if two story cards describe the same development.",
  input_schema: {
    type: "object" as const,
    properties: {
      decision: { type: "string", enum: ["yes", "no", "unsure"] },
      reason: { type: "string" },
    },
    required: ["decision", "reason"],
    additionalProperties: false,
  },
};

function text(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function responseUsage(response: {
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}): ModelUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
  };
}

export function needsSplitReview(story: CriticStory): boolean {
  const gained = story.primaryMembers.filter((member) => member.gainedThisRun);
  if (gained.length === 0) return false;
  if (story.primaryMembers.length >= 3) return true;
  if (gained.some((member) => member.confidence !== "high")) return true;
  const dates = story.primaryMembers
    .map((member) => member.publishedAt?.getTime())
    .filter((value): value is number => value !== undefined);
  return dates.length >= 2 && Math.max(...dates) - Math.min(...dates) > 36 * 60 * 60 * 1000;
}

export function anchorArticleId(story: CriticStory): number {
  if (story.primaryMembers.length === 0) throw new Error("a critic story needs a primary member");
  if (story.anchorArticleId !== null && story.primaryMembers.some((member) => member.articleId === story.anchorArticleId)) {
    return story.anchorArticleId;
  }
  return [...story.primaryMembers].sort((a, b) => {
    const left = a.publishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const right = b.publishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.articleId - b.articleId;
  })[0]!.articleId;
}

// Headlines are title case, so properNouns() reads "How", "Why", "Are" and
// "Exclusive" as names. Measured 2026-09-22 on 400 real headlines: these were
// among the most frequent "names", and with ONE shared name required every
// Trump story paired with every other (1,932 merge reviews for 400 stories).
// Kept local to the merge filter; candidate retrieval's properNouns use is
// unchanged.
const HEADLINE_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "has", "have", "had", "how", "why", "what", "who", "when", "where",
  "will", "can", "could", "would", "should", "may", "might", "its", "his", "her", "their", "our", "your", "you",
  "they", "this", "that", "these", "those", "not", "but", "with", "from", "into", "over", "after", "before",
  "amid", "about", "against", "says", "said", "say", "new", "first", "last", "more", "most", "all", "out",
  "off", "open", "exclusive", "breaking", "live", "watch", "video", "update", "updates", "report", "reports",
  "analysis", "opinion", "inside", "here", "now", "just", "still", "big", "top", "day", "week", "year",
]);

// A pair needs this many shared names to be worth a merge review. One shared
// name ("Trump") matched most of a day's political stories; two ("Dario
// Amodei", "Supreme Court") cut 400-story pairs from 1,932 to 113. Cost: a
// same-event pair that shares only one name is no longer proposed here.
// Assignment and sweep still attach such articles; this pass is a second net.
export const MERGE_MIN_SHARED_NAMES = 2;

function entityTokens(card: StoryCard): Set<string> {
  return new Set(
    properNouns(`${card.headline} ${card.eventStatement}`)
      .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
      .filter((value) => value.length >= 3 && !HEADLINE_WORDS.has(value)),
  );
}

export interface MergeCandidatePair {
  left: StoryCard;
  right: StoryCard;
  sharedNames: number;
}

// Pairs worth a merge review, strongest first: most shared names, then the
// most recently updated. The caller caps how many it reviews, so the order
// decides which pairs get checked on a busy day.
export function mergeCandidatePairs(stories: readonly StoryCard[]): MergeCandidatePair[] {
  const tokens = stories.map(entityTokens);
  const pairs: MergeCandidatePair[] = [];
  for (let left = 0; left < stories.length; left++) {
    for (let right = left + 1; right < stories.length; right++) {
      const a = stories[left]!;
      const b = stories[right]!;
      if (Math.abs(a.firstSeenAt.getTime() - b.firstSeenAt.getTime()) > 48 * 60 * 60 * 1000) continue;
      let sharedNames = 0;
      for (const token of tokens[right]!) if (tokens[left]!.has(token)) sharedNames += 1;
      if (sharedNames >= MERGE_MIN_SHARED_NAMES) pairs.push({ left: a, right: b, sharedNames });
    }
  }
  const newest = (pair: MergeCandidatePair) => Math.max(pair.left.updatedAt.getTime(), pair.right.updatedAt.getTime());
  return pairs.sort((x, y) => y.sharedNames - x.sharedNames || newest(y) - newest(x));
}

function toolInput(response: { content?: Array<{ type?: string; name?: string; input?: unknown }> }, name: string): unknown {
  return response.content?.find((entry) => entry.type === "tool_use" && entry.name === name)?.input;
}

export async function reviewSplit(story: CriticStory, options: CriticOptions = {}): Promise<SplitReview> {
  const client = options.client ?? (anthropic() as unknown as StoryModelClient);
  const model = options.model ?? models.stories;
  const anchor = anchorArticleId(story);
  const startedAt = Date.now();
  let response;
  try {
    response = await client.messages.create({
    model,
    max_tokens: Math.min(16_000, Math.max(2_048, story.primaryMembers.length * 500)),
    system: CRITIC_SYSTEM,
    tools: [SPLIT_TOOL],
    tool_choice: { type: "tool", name: "submit_split_review" },
    messages: [{
      role: "user",
      content: JSON.stringify({
        story: { id: story.card.id, headline: story.card.headline, event_statement: story.card.eventStatement },
        anchor_article_id: anchor,
        primary_articles: story.primaryMembers.map((member) => ({ article_id: member.articleId, title: member.title })),
      }),
    }],
    });
  } catch (error) {
    if (options.onUsage) await options.onUsage({
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      model, stage: "critic", callIndex: options.callIndex ?? 1, wallMs: Date.now() - startedAt,
      status: "failed", error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const usage = responseUsage(response);
  if (options.onUsage) await options.onUsage({ ...usage, model, stage: "critic", callIndex: options.callIndex ?? 1, wallMs: Date.now() - startedAt, status: "succeeded", error: null });
  if (response.stop_reason !== "tool_use") {
    return {
      storyId: story.card.id,
      anchorArticleId: anchor,
      groups: [],
      reason: `Split review did not return a tool call (${response.stop_reason ?? "none"}).`,
      valid: false,
    };
  }
  const input = toolInput(response, "submit_split_review");
  if (!input || typeof input !== "object") {
    return { storyId: story.card.id, anchorArticleId: anchor, groups: [], reason: "Malformed split review.", valid: false };
  }
  const raw = input as { groups?: unknown; reason?: unknown };
  const reason = text(raw.reason) ?? "Malformed split review.";
  const groups: StorySplitGroup[] = Array.isArray(raw.groups)
    ? raw.groups.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const group = entry as { headline?: unknown; event_statement?: unknown; article_ids?: unknown };
        const headline = text(group.headline);
        const eventStatement = text(group.event_statement);
        const articleIds = Array.isArray(group.article_ids)
          ? group.article_ids.filter((id): id is number => Number.isSafeInteger(id) && (id as number) > 0)
          : [];
        return headline && eventStatement && articleIds.length > 0 ? [{ headline, eventStatement, articleIds }] : [];
      })
    : [];
  const expected = [...story.primaryMembers.map((member) => member.articleId)].sort((a, b) => a - b);
  const actual = groups.flatMap((group) => group.articleIds).sort((a, b) => a - b);
  const valid = groups.length > 0
    && actual.length === expected.length
    && actual.every((id, index) => id === expected[index])
    && groups.filter((group) => group.articleIds.includes(anchor)).length === 1;
  return { storyId: story.card.id, anchorArticleId: anchor, groups, reason, valid };
}

export async function reviewMerge(
  left: StoryCard,
  right: StoryCard,
  options: CriticOptions = {},
): Promise<MergeReview> {
  const client = options.client ?? (anthropic() as unknown as StoryModelClient);
  const model = options.model ?? models.stories;
  const startedAt = Date.now();
  let response;
  try {
    response = await client.messages.create({
    model,
    max_tokens: 2_048,
    system: CRITIC_SYSTEM,
    tools: [MERGE_TOOL],
    tool_choice: { type: "tool", name: "submit_merge_review" },
    messages: [{ role: "user", content: JSON.stringify({ left, right }) }],
    });
  } catch (error) {
    if (options.onUsage) await options.onUsage({
      inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      model, stage: "critic", callIndex: options.callIndex ?? 1, wallMs: Date.now() - startedAt,
      status: "failed", error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const usage = responseUsage(response);
  if (options.onUsage) await options.onUsage({ ...usage, model, stage: "critic", callIndex: options.callIndex ?? 1, wallMs: Date.now() - startedAt, status: "succeeded", error: null });
  if (response.stop_reason !== "tool_use") {
    return {
      leftStoryId: left.id,
      rightStoryId: right.id,
      decision: "unsure",
      reason: `Merge review did not return a tool call (${response.stop_reason ?? "none"}).`,
    };
  }
  const input = toolInput(response, "submit_merge_review");
  if (!input || typeof input !== "object") {
    return { leftStoryId: left.id, rightStoryId: right.id, decision: "unsure", reason: "Malformed merge review." };
  }
  const raw = input as { decision?: unknown; reason?: unknown };
  const decision = raw.decision === "yes" || raw.decision === "no" || raw.decision === "unsure" ? raw.decision : "unsure";
  return {
    leftStoryId: left.id,
    rightStoryId: right.id,
    decision,
    reason: text(raw.reason) ?? "Merge review gave no reason.",
  };
}
