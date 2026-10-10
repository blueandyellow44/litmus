// The "Why 2.2 Grounded" line must be a reason, checked in code at write time.
//
// rationale.summary is shown to readers as why an article earned its score.
// The prompt says "a summary of the news is not a reason", and Haiku ignores it:
// on the 2026-10-02 edition 221 of 342 one-liners carried no evaluative word at
// all ("An Iranian spokeswoman said the U.S. delivered a counterproposal"), 125
// of 205 among Jev-judged articles (audit 2026-10-02, section 3.3). More prompt
// wording had already failed, so the rule is enforced here.
//
// Max's ruling (2026-10-02): a summary that fails is retried once with the check
// stated; a second failure stores null, and the card shows the band word with
// no Why line. A reason is never written in code and never invented: the
// alternative was a summary that only retells the news, presented as a reason.

import { anthropic } from "../lib/anthropic.js";
import { logger } from "../lib/logger.js";

// Words that talk about HOW the article is written rather than what happened.
// Matched as whole words, case-insensitive. The fix-session brief's list, plus
// the forms of each that verdicts actually use ("framed", "sources").
const EVALUATIVE_TERMS = [
  "headlines?", "fram(?:e|es|ed|ing)", "loaded", "language", "attribut\\w*",
  "sourc(?:e|es|ed|ing)", "one-sided", "counterpoints?", "editorial\\w*", "opinion",
  "ledes?", "anecdot\\w*", "modifiers?", "characteri[sz]\\w*", "scare quotes",
  "restrained", "plain", "tilt\\w*", "steer\\w*", "emotional\\w*", "neutral(?:ly)?",
  "balanced", "straightforward", "column", "adjectives?", "word choices?",
];
const EVALUATIVE = new RegExp(`\\b(?:${EVALUATIVE_TERMS.join("|")})\\b`, "i");

export function isReason(summary: string | null | undefined): boolean {
  return typeof summary === "string" && summary.trim().length > 0 && EVALUATIVE.test(summary);
}

// ── The Why line names what set the number (Max, 2026-10-02: "i like it") ──
//
// A reason about the writing is not enough: "a plain headline" passed on a
// story whose score came from one-sided sourcing. The composite's own
// breakdown says which dimension set the number, so the Why line must talk
// about that one. Deterministic, no model judgement.

export type Dimension = "headline" | "language" | "sourcing" | "fallacies" | "structure";
export const DIMENSIONS: readonly Dimension[] = ["headline", "language", "sourcing", "fallacies", "structure"];

// The words a reason uses when it is talking about each dimension.
const DRIVER_VOCAB: Record<Dimension, RegExp> = {
  headline: /\bheadlines?\b/i,
  language: /\b(language|word(?:ing|s)?|word choices?|adjectives?|verbs?|modifiers?|loaded|charged|emotional\w*|tone|phrasing|restrained|measured|neutral(?:ly)?|plain|scare quotes|characteri[sz]\w*)\b/i,
  sourcing: /\b(sourc(?:e|es|ed|ing)|voices?|quot(?:e|es|ed|ing)|attribut\w*|one-sided|balanced|perspectives?|counterpoints?|sides?|critics?|experts?|officials?)\b/i,
  fallacies: /\b(reasoning|fallac\w*|argu(?:e|es|ed|ment)\w*|logic\w*|leap|straw|whatabout\w*|slippery|speculat\w*|opinion|column)\b/i,
  structure: /\b(structure\w*|ledes?|anecdot\w*|buried|placement|inverted pyramid|order(?:ed)?|leads? with|fram(?:e|es|ed|ing)|straightforward|wire-style)\b/i,
};

const DRIVER_WORDS: Record<Dimension, string> = {
  headline: "the headline", language: "the outlet's own language", sourcing: "the sourcing",
  fallacies: "the reasoning", structure: "the structure",
};

// The dimension that set the number: the highest effective dimension, the
// heavier-weighted one (headline, language) on a tie. Null when unreadable.
export function biggestDriver(effective: Partial<Record<Dimension, unknown>> | null | undefined): Dimension | null {
  if (!effective) return null;
  let best: { d: Dimension; v: number } | null = null;
  for (const d of DIMENSIONS) {
    const v = effective[d];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!best || v > best.v) best = { d, v };
  }
  return best?.d ?? null;
}

export function namesDriver(summary: string, driver: Dimension | null): boolean {
  return driver === null || DRIVER_VOCAB[driver].test(summary);
}

export function isDriverReason(summary: string | null | undefined, driver: Dimension | null): boolean {
  return isReason(summary) && namesDriver(summary!, driver);
}

// "sourcing 3.0 pushed it up; language 1.9 held it down": the drivers in plain
// words, handed to Haiku with the set scores and to the retry.
export function driversText(effective: Partial<Record<Dimension, unknown>>): string {
  const read = DIMENSIONS.map((d) => ({ d, v: effective[d] })).filter((x): x is { d: Dimension; v: number } => typeof x.v === "number" && Number.isFinite(x.v));
  const up = read.filter((x) => x.v >= 2.5).sort((a, b) => b.v - a.v).map((x) => `${x.d} ${x.v.toFixed(1)}`);
  const down = read.filter((x) => x.v <= 2.0).sort((a, b) => a.v - b.v).map((x) => `${x.d} ${x.v.toFixed(1)}`);
  const parts = [up.length ? `${up.join(", ")} pushed it up` : "", down.length ? `${down.join(", ")} held it down` : ""].filter(Boolean);
  return parts.join("; ") || "every dimension landed mid-scale";
}

export function driverWords(driver: Dimension): string {
  return DRIVER_WORDS[driver];
}

export interface ReasonRequest {
  articleId: number;
  title: string;
  band: string;
  composite: number;
  // The model's own per-dimension notes, already written in the scoring pass:
  // the material a reason is made from, so the retry never sees less than the
  // first attempt did.
  dimensionNotes: Record<string, string>;
  failedSummary: string;
  // The dimension that set the number, and the drivers in plain words. The
  // retry must name the driver; a summary that does not stays null.
  driver: Dimension | null;
  drivers: string;
}

const REASON_TOOL = {
  name: "submit_reasons",
  description: "Return one reason sentence per article.",
  input_schema: {
    type: "object" as const,
    properties: {
      reasons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            article_id: { type: "integer" },
            summary: { type: "string", description: "One sentence: why the article earned its band, naming the writing choices that set it." },
          },
          required: ["article_id", "summary"],
          additionalProperties: false,
        },
      },
    },
    required: ["reasons"],
    additionalProperties: false,
  },
};

const RETRY_INSTRUCTIONS = `Each article below already has a score and notes on its headline, language, sourcing, reasoning and structure. Its one-sentence "why" came back as a retelling of the news, which is not a reason.

Write ONE sentence per article that tells a reader WHY it earned its band. Each article names "must_name": the part of the writing that set its score. Your sentence must be about that part first (the headline, the outlet's own language, the sourcing, the reasoning, or the structure), using the notes for what it did. Do not invent anything the notes do not say. Do not retell the news. Do not argue with the score.`;

// One retry for every failing summary in a batch, in a single call. Returns the
// new summary per article only where it now passes; every other article gets
// null. A failed call returns all nulls: the retry can lose a reason, never a
// score.
export async function retryReasons(
  requests: ReasonRequest[],
  opts: { model: string; onUsage?: (u: { inputTokens: number; outputTokens: number; model: string }) => void },
): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>(requests.map((r) => [r.articleId, null]));
  const driverOf = new Map(requests.map((r) => [r.articleId, r.driver]));
  if (requests.length === 0) return out;
  try {
    const response = await anthropic().messages.create({
      model: opts.model,
      max_tokens: 2048,
      system: RETRY_INSTRUCTIONS,
      tools: [REASON_TOOL],
      tool_choice: { type: "tool", name: "submit_reasons" },
      messages: [{
        role: "user",
        content: JSON.stringify(requests.map((r) => ({
          article_id: r.articleId, headline: r.title, band: r.band, score: r.composite, notes: r.dimensionNotes,
          drivers: r.drivers, must_name: r.driver ? driverWords(r.driver) : "the writing choice that set the score",
          rejected_why: r.failedSummary,
        })), null, 2),
      }],
    });
    try {
      opts.onUsage?.({ inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0, model: opts.model });
    } catch { /* accounting never fails scoring */ }
    const toolUse = response.content.find((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
    const reasons = (toolUse?.input as { reasons?: Array<{ article_id?: unknown; summary?: unknown }> } | undefined)?.reasons;
    if (!Array.isArray(reasons)) return out;
    for (const r of reasons) {
      if (typeof r.article_id !== "number" || !out.has(r.article_id) || typeof r.summary !== "string") continue;
      const summary = r.summary.trim();
      if (isDriverReason(summary, driverOf.get(r.article_id) ?? null)) out.set(r.article_id, summary);
    }
  } catch (err) {
    logger.warn("reason retry failed; failing summaries are stored as null", {
      articles: requests.length, err: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}
