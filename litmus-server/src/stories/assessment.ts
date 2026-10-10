// S4: the plain-language story assessment (docs/plans/story-first-build-
// 2026-09-13.md; length ruling updated 2026-09-17, see ASSESSMENT_SYSTEM).
// Writes stories.assessment_text for every story whose live membership has
// diverged from the membership its stored assessment was written for.
//
// Headline and event_statement are NOT this module's concern — S3 (ledger.ts
// via setStoryCard, called from assignment/critic) already owns those, and
// setStoryAssessment's own column set makes that split explicit. This module
// only ever reads them as context for the model, never writes them.
//
// Uses only member titles, summaries, and capped excerpts (ArticleSummaryDTO),
// which structurally cannot carry rawText — see getArticleSummariesByIds.

import { anthropic, models } from "../lib/anthropic.js";
import { pool } from "../db/client.js";
import {
  currentMembershipHash,
  listStoriesUpdatedSince,
  listStoryMembers,
  setStoryAssessment,
  type Queryable,
  type StoryMemberRecord,
  type StoryRecord,
} from "../db/repos/storiesRepo.js";
import { getArticleSummariesByIds } from "../db/repos/articlesRepo.js";
import type { ArticleSummaryDTO } from "../api/types.js";
import { ASSESSMENT_SYSTEM } from "./prompts.js";
import type { ModelUsage, StoryModelClient } from "./assignment.js";
import { membershipHash } from "./identity.js";
import { logger } from "../lib/logger.js";
import { rethrowIfFatal } from "./modelErrors.js";
import { mapLimit } from "./concurrency.js";

interface AssessmentModelResponse {
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  content?: Array<{ type?: string; name?: string; input?: unknown }>;
}

const ASSESSMENT_TOOL = {
  name: "submit_story_assessment",
  description: "Return the plain-language assessment for one story.",
  input_schema: {
    type: "object" as const,
    properties: {
      headline: { type: "string" },
      event_statement: { type: "string" },
      paragraphs: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        maxItems: 3,
      },
      // Political Wire scope (Max, 2026-09-26): does this story belong on the
      // front page? See ASSESSMENT_SYSTEM for the rule.
      touches_politics: { type: "boolean" },
    },
    required: ["headline", "event_statement", "paragraphs", "touches_politics"],
    additionalProperties: false,
  },
};

export interface AssessmentMemberPayload {
  outlet: string;
  title: string;
  publishedAt: string | null;
  // null for a headline-only or unscored member — the model is told so
  // explicitly rather than left to infer it from an absent field.
  summary: string | null;
  excerptLead: string | null;
}

export type AssessmentRequest = {
  model: string;
  max_tokens: number;
  system: string;
  tools: [typeof ASSESSMENT_TOOL];
  tool_choice: { type: "tool"; name: "submit_story_assessment" };
  messages: [{ role: "user"; content: string }];
};

export interface StoryAssessment {
  headline: string;
  eventStatement: string;
  paragraphs: string[];
  touchesPolitics: boolean;
  text: string; // paragraphs joined by a blank line — the DTO's stored shape
}

export interface AssessOptions {
  client?: StoryModelClient;
  model?: string;
  callIndex?: number;
  now?: () => Date;
  // Sees the exact request for every attempt, retries included — the trial
  // archives it so an output can be checked against what the model was given.
  onRequest?: (request: AssessmentRequest & { storyId: string; callIndex: number }) => void | Promise<void>;
  onUsage?: (
    usage: ModelUsage & {
      model: string;
      stage: "assessment";
      storyId: string;
      callIndex: number;
      wallMs: number;
      status: "succeeded" | "failed";
      error: string | null;
    },
  ) => void | Promise<void>;
}

function usageOf(response: AssessmentModelResponse): ModelUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: response.usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: response.usage?.cache_read_input_tokens ?? 0,
  };
}

function toolInput(response: AssessmentModelResponse): Record<string, unknown> | null {
  const tool = response.content?.find((entry) => entry.type === "tool_use" && entry.name === "submit_story_assessment");
  return tool?.input && typeof tool.input === "object" ? (tool.input as Record<string, unknown>) : null;
}

function nonEmpty(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value === "" ? null : value;
}

// Two or three paragraphs of at most four sentences each is as much as LITMUS
// may publish (Max, 2026-09-26: a legal ceiling, not a style). Checked here so
// a longer answer retries once and is never stored.
export const MAX_SENTENCES_PER_PARAGRAPH = 4;
// The house length (Max, 2026-09-26, "cut the summary by a third"): at most
// eight sentences in all, two-thirds of the twelve the legal ceiling allows.
export const MAX_SENTENCES_TOTAL = 8;

export function exceedsLength(text: string): boolean {
  const paragraphs = text.split("\n\n").filter((p) => p.trim() !== "");
  const counts = paragraphs.map(sentenceCount);
  return counts.some((n) => n > MAX_SENTENCES_PER_PARAGRAPH) || counts.reduce((a, n) => a + n, 0) > MAX_SENTENCES_TOTAL;
}

// Abbreviations and initials whose period does not end a sentence ("U.S.",
// "Mr.", "Sept.", "J. D."), masked before counting. Found by the parallel
// session reviewing de3564e: counting every period read "The U.S. and Mr.
// Smith met on Sept. 5. They agreed." as five sentences and would have left
// most politics stories unassessed.
const ABBREVIATION = /\b(?:[A-Z]\.){2,}|\b(?:Mr|Mrs|Ms|Dr|Sen|Rep|Gov|Lt|Gen|Col|Sgt|St|Jr|Sr|Inc|Corp|Co|vs|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.|\b[A-Z]\.(?=\s[A-Z])/g;

// A sentence ends at . ! or ? (and any closing quote or bracket) followed by
// whitespace and the start of a new sentence; the end of the paragraph closes
// the last one, whether or not it ends in an abbreviation.
const SENTENCE_BREAK = /(?<=[.!?]["\u201d\u2019')\]]*)\s+(?=["\u201c\u2018(\[]?[A-Z0-9])/;

export function sentenceCount(paragraph: string): number {
  const masked = paragraph.replace(ABBREVIATION, (match) => match.replace(/\./g, "")).trim();
  if (masked === "") return 0;
  return masked.split(SENTENCE_BREAK).filter((part) => part.trim() !== "").length;
}

// The paragraph's opening sentence, by the same break rule, returned in the
// paragraph's own characters: the break is found on the masked text, and the
// masking only removes dots inside abbreviations, so the word count carries
// back to the original unchanged.
export function firstSentence(paragraph: string): string {
  const original = paragraph.trim().split(/\s+/).filter(Boolean);
  const masked = paragraph.replace(ABBREVIATION, (match) => match.replace(/\./g, "")).trim();
  const first = masked.split(SENTENCE_BREAK)[0] ?? "";
  const words = first.split(/\s+/).filter(Boolean).length;
  return original.slice(0, words).join(" ");
}

function paragraphProblem(raw: unknown): string {
  if (!Array.isArray(raw)) return "paragraphs missing";
  if (raw.length < 2 || raw.length > 3) return `paragraphs: ${raw.length}, need 2 or 3`;
  const counts = raw.map((p) => (typeof p === "string" ? sentenceCount(p) : 0));
  if (counts.some((n) => n > MAX_SENTENCES_PER_PARAGRAPH)) return `sentences per paragraph ${counts.join("/")}, max ${MAX_SENTENCES_PER_PARAGRAPH}`;
  const total = counts.reduce((a, n) => a + n, 0);
  if (total > MAX_SENTENCES_TOTAL) return `sentences in all ${total}, max ${MAX_SENTENCES_TOTAL}`;
  return "a paragraph is empty";
}

function parseParagraphs(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) return null;
  const paragraphs = raw.map(nonEmpty);
  if (paragraphs.some((p) => p === null)) return null;
  if ((paragraphs as string[]).some((p) => sentenceCount(p) > MAX_SENTENCES_PER_PARAGRAPH)) return null;
  if ((paragraphs as string[]).reduce((a, p) => a + sentenceCount(p), 0) > MAX_SENTENCES_TOTAL) return null;
  return paragraphs as string[];
}

// The event leads, never an outlet — checked the cheap, deterministic way: does
// the opening of the first paragraph name one of this story's own outlets? A
// real proper noun that happens to share a word with an outlet name (rare, but
// possible) can false-positive this; that is why a hit RETRIES with a
// corrective note rather than silently rejecting the assessment outright.
function opensWithAnOutlet(firstParagraph: string, outletNames: readonly string[]): string | null {
  const opening = firstParagraph.slice(0, 80).toLowerCase();
  for (const name of outletNames) {
    const bare = name.split("—")[0]!.trim().toLowerCase();
    if (bare.length >= 3 && opening.includes(bare)) return name;
  }
  return null;
}

// The other way an outlet takes the lead: the opening says who reported the
// event ("CNN reported", "According to Reuters") — even an outlet that is not a
// member, which the name check above cannot see (the 2026-09-26 trial's CNN
// story opened this way in both models). Same retry-then-flag treatment. A
// source that is itself an actor ("Police reported") can false-positive this.
const ATTRIBUTION_OPENING = /^\s*(?:[Aa]ccording to\b|(?:the\s+)?[A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,4}\s+(?:reported|reports|has reported|is reporting)\b)/;

function opensWithAttribution(firstParagraph: string): string | null {
  const hit = ATTRIBUTION_OPENING.exec(firstParagraph);
  return hit ? hit[0].trim() : null;
}

function buildUserContent(story: StoryRecord, members: readonly AssessmentMemberPayload[], correction: string | null): string {
  const body = JSON.stringify({
    headline_on_record: story.headline,
    event_statement_on_record: story.eventStatement,
    members,
  });
  return correction ? `${correction}\n${body}` : body;
}

async function callAssessmentModel(
  story: StoryRecord,
  members: readonly AssessmentMemberPayload[],
  options: Required<Pick<AssessOptions, "client" | "model">> & Pick<AssessOptions, "onUsage" | "onRequest" | "callIndex">,
  correction: string | null,
): Promise<{ parsed: StoryAssessment | null; usage: ModelUsage; malformedReason: string | null }> {
  const request: AssessmentRequest = {
    model: options.model,
    max_tokens: 2_048,
    system: ASSESSMENT_SYSTEM,
    tools: [ASSESSMENT_TOOL],
    tool_choice: { type: "tool", name: "submit_story_assessment" },
    messages: [{ role: "user", content: buildUserContent(story, members, correction) }],
  };
  if (options.onRequest) await options.onRequest({ ...request, storyId: story.id, callIndex: options.callIndex ?? 1 });
  const startedAt = Date.now();
  let response: AssessmentModelResponse;
  try {
    response = (await options.client.messages.create(request)) as AssessmentModelResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.onUsage) {
      await options.onUsage({
        inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
        model: options.model, stage: "assessment", storyId: story.id,
        callIndex: options.callIndex ?? 1, wallMs: Date.now() - startedAt, status: "failed", error: message,
      });
    }
    // A locked account or bad key fails every story the same way; end the run
    // instead of calling once per story (modelErrors.ts).
    rethrowIfFatal(error);
    return { parsed: null, usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, malformedReason: message };
  }
  const usage = usageOf(response);
  if (options.onUsage) {
    await options.onUsage({
      ...usage, model: options.model, stage: "assessment", storyId: story.id,
      callIndex: options.callIndex ?? 1, wallMs: Date.now() - startedAt, status: "succeeded", error: null,
    });
  }
  if (response.stop_reason !== "tool_use") {
    return { parsed: null, usage, malformedReason: `no tool call (stop_reason ${response.stop_reason ?? "none"})` };
  }
  const input = toolInput(response);
  const headline = nonEmpty(input?.headline);
  const eventStatement = nonEmpty(input?.event_statement);
  const paragraphs = parseParagraphs(input?.paragraphs);
  const touchesPolitics = typeof input?.touches_politics === "boolean" ? input.touches_politics : null;
  // Name the exact failure, so a run's log says which rule refused it
  // (2026-09-26: five refusals shared one catch-all message).
  const problems = [
    !headline && "headline",
    !eventStatement && "event_statement",
    !paragraphs && paragraphProblem(input?.paragraphs),
    touchesPolitics === null && "touches_politics missing",
  ].filter(Boolean);
  if (!headline || !eventStatement || !paragraphs || touchesPolitics === null) {
    return { parsed: null, usage, malformedReason: `refused: ${problems.join("; ")}` };
  }
  return {
    parsed: { headline, eventStatement, paragraphs, touchesPolitics, text: paragraphs.join("\n\n") },
    usage,
    malformedReason: null,
  };
}

export const ASSESSMENT_CALLS_PER_STORY = 2;

// One story, start to finish: call the model, retry once on either a
// malformed response or the outlet-leads heuristic, and return whichever
// attempt produced a usable assessment. Never throws on a bad model
// response — a story that cannot be assessed this run is left for the next
// one, exactly like every other story stage's fail-safe.
export async function assessStory(
  story: StoryRecord,
  members: readonly AssessmentMemberPayload[],
  options: AssessOptions = {},
): Promise<{ assessment: StoryAssessment | null; usage: ModelUsage; openedWithOutlet: boolean; flagReason: string | null }> {
  const client = options.client ?? (anthropic() as unknown as StoryModelClient);
  const model = options.model ?? models.stories;
  const outletNames = members.map((m) => m.outlet);
  let totalUsage: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  let openedWithOutlet = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const correction = attempt === 0 ? null
      : openedWithOutlet
        ? "Correction: your last attempt opened by naming an outlet or saying who reported the event. Rewrite so the event leads: open with the principal actor and the act, and name no outlet as the teller."
        : "Correction: your last attempt was not usable. Return headline, event_statement, and two or three plain paragraphs through the tool.";
    const { parsed, usage, malformedReason } = await callAssessmentModel(
      // Each attempt gets its own call index: story_run_usage is keyed on
      // (run, stage, call_index), so sharing one let a retry overwrite the
      // first attempt's row. Callers reserve ASSESSMENT_CALLS_PER_STORY.
      story, members, { client, model, onUsage: options.onUsage, onRequest: options.onRequest, callIndex: (options.callIndex ?? 1) + attempt },
      correction,
    );
    totalUsage = {
      inputTokens: totalUsage.inputTokens + usage.inputTokens,
      outputTokens: totalUsage.outputTokens + usage.outputTokens,
      cacheCreationInputTokens: totalUsage.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      cacheReadInputTokens: totalUsage.cacheReadInputTokens + usage.cacheReadInputTokens,
    };
    if (!parsed) {
      if (attempt === 1) {
        logger.warn("story assessment gave up after malformed retry", { storyId: story.id, reason: malformedReason });
        return { assessment: null, usage: totalUsage, openedWithOutlet: false, flagReason: malformedReason };
      }
      continue;
    }
    const outletHit = opensWithAnOutlet(parsed.paragraphs[0]!, outletNames) ?? opensWithAttribution(parsed.paragraphs[0]!);
    if (outletHit && attempt === 0) {
      openedWithOutlet = true;
      continue;
    }
    if (outletHit) {
      // Retried once and still opened with an outlet — persist it rather than
      // discard a real assessment over a style heuristic, but make the miss
      // visible instead of silently shipping it.
      logger.warn("story assessment still opened with an outlet after one retry", { storyId: story.id, outlet: outletHit });
      return { assessment: parsed, usage: totalUsage, openedWithOutlet: true, flagReason: null };
    }
    return { assessment: parsed, usage: totalUsage, openedWithOutlet: false, flagReason: null };
  }
  return { assessment: null, usage: totalUsage, openedWithOutlet: false, flagReason: "exhausted retries" };
}

export function toMemberPayload(member: StoryMemberRecord, article: ArticleSummaryDTO | undefined): AssessmentMemberPayload {
  return {
    outlet: article?.sourceName ?? `Article ${member.articleId}`,
    title: article?.title ?? "(untitled)",
    publishedAt: article?.publishedAt ?? null,
    summary: article?.score?.articleSummary ?? null,
    // The whole published excerpt, not only its first paragraph (2026-09-26,
    // "the goal is more text from stories, not less"). It is the same window
    // the site already shows, capped at 200 words or 25% of the article.
    excerptLead: article?.excerpt?.paragraphs.join("\n\n") || null,
  };
}

export interface AssessStoriesResult {
  assessedStoryIds: string[];
  skippedUpToDateStoryIds: string[];
  skippedNoMembersStoryIds: string[];
  skippedOverCapStoryIds: string[];
  flaggedOpeningWithOutletStoryIds: string[];
  flaggedUnassessableStoryIds: string[];
  usage: ModelUsage;
  calls: number;
}

// Which due story is written up first. Stories never written up come first,
// newest first, so the day's own news is always judged and shown; then
// stories missing a scope verdict; then rewrites; within a tier, most-covered
// first. 2026-09-27: ordered by coverage alone, backlog stories took every
// slot, today's 53 new stories went unjudged, and the front page showed only
// yesterday's.
export function assessmentOrder(
  a: Pick<StoryRecord, "assessment" | "touchesPolitics" | "firstSeenAt" | "id">, aPrimaries: number,
  b: Pick<StoryRecord, "assessment" | "touchesPolitics" | "firstSeenAt" | "id">, bPrimaries: number,
): number {
  const tier = (st: typeof a) => (st.assessment === null ? 0 : st.touchesPolitics === null ? 1 : 2);
  return tier(a) - tier(b)
    || (tier(a) === 0 ? b.firstSeenAt.getTime() - a.firstSeenAt.getTime() : 0)
    || bPrimaries - aPrimaries
    || a.id.localeCompare(b.id);
}

export interface AssessStoriesOptions extends Pick<AssessOptions, "client" | "model"> {
  // The ledger's story window (lookbackLimit.ts); required so no literal
  // window can creep back in here.
  days: number;
  // Hard cap on stories assessed per run, most-covered first; the rest keep
  // their event statement as the lede and wait for the next run.
  maxStories: number;
  concurrency?: number;
  startingCallIndex?: number;
  now?: () => Date;
  onUsage?: AssessOptions["onUsage"];
  db?: Queryable;
}

// The orchestrator (wired into the ledger run 2026-09-26; before that it was
// built but never called, so every story read "Assessment pending"). Every
// non-merged story updated inside the window whose stored assessment no
// longer matches its live membership, most-covered first, capped, run
// `concurrency` at a time. Each assessment is saved as soon as it is written.
export async function assessStories(options: AssessStoriesOptions): Promise<AssessStoriesResult> {
  const now = options.now ?? (() => new Date());
  const db = options.db ?? pool;
  const since = new Date(now().getTime() - options.days * 24 * 60 * 60 * 1000);

  const candidates = await listStoriesUpdatedSince(since, db);
  const result: AssessStoriesResult = {
    assessedStoryIds: [],
    skippedUpToDateStoryIds: [],
    skippedNoMembersStoryIds: [],
    skippedOverCapStoryIds: [],
    flaggedOpeningWithOutletStoryIds: [],
    flaggedUnassessableStoryIds: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    calls: 0,
  };

  const due: Array<{ story: StoryRecord; members: StoryMemberRecord[]; liveHash: string; primaries: number }> = [];
  for (const story of candidates) {
    const members = await listStoryMembers(story.id, db);
    if (members.length === 0) {
      result.skippedNoMembersStoryIds.push(story.id);
      continue;
    }
    const liveHash = membershipHash(members.map((m) => ({ articleId: m.articleId, role: m.role, kind: m.kind })));
    // Up to date means the same members AND a scope verdict: stories assessed
    // before touches_politics existed (2026-09-26) carry none, and would stay
    // hidden from the front page forever if their members never change.
    // ...and, since the house length was cut (2026-09-26), a stored summary
    // within it; a longer one is rewritten.
    if (liveHash === story.membershipHash && story.touchesPolitics !== null && !exceedsLength(story.assessment?.text ?? "")) {
      result.skippedUpToDateStoryIds.push(story.id);
      continue;
    }
    const primaries = members.filter((m) => m.role === "primary").length;
    due.push({ story, members, liveHash, primaries });
  }
  due.sort((a, b) => assessmentOrder(a.story, a.primaries, b.story, b.primaries));
  const selected = due.slice(0, options.maxStories);
  result.skippedOverCapStoryIds = due.slice(options.maxStories).map((entry) => entry.story.id);

  const firstCallIndex = (options.startingCallIndex ?? 0) + 1;
  await mapLimit(selected.map((entry, index) => ({ ...entry, index })), options.concurrency ?? 5, async ({ story, members, liveHash, index }) => {
    const articles = await getArticleSummariesByIds(members.map((m) => m.articleId));
    const byId = new Map(articles.map((a) => [a.id, a]));
    const payload = members.map((m) => toMemberPayload(m, byId.get(m.articleId)));

    const { assessment, usage, openedWithOutlet, flagReason } = await assessStory(story, payload, {
      client: options.client,
      model: options.model,
      callIndex: firstCallIndex + index * ASSESSMENT_CALLS_PER_STORY,
      onUsage: options.onUsage,
    });
    result.usage = {
      inputTokens: result.usage.inputTokens + usage.inputTokens,
      outputTokens: result.usage.outputTokens + usage.outputTokens,
      cacheCreationInputTokens: result.usage.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens + usage.cacheReadInputTokens,
    };
    result.calls += 1;
    if (!assessment) {
      result.flaggedUnassessableStoryIds.push(story.id);
      logger.warn("story left unassessed this run", { storyId: story.id, reason: flagReason });
      return;
    }
    if (openedWithOutlet) result.flaggedOpeningWithOutletStoryIds.push(story.id);
    await setStoryAssessment(story.id, {
      text: assessment.text,
      model: options.model ?? models.stories,
      generatedAt: now(),
      membershipHash: liveHash,
      touchesPolitics: assessment.touchesPolitics,
    }, db);
    result.assessedStoryIds.push(story.id);
  });

  return result;
}
