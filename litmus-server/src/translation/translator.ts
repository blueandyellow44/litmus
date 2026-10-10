// On-demand bias-stripped translation via Claude Sonnet.
// Called from the translations API handler when a user clicks into an article
// and no cached translation exists yet.

import { anthropic, models } from "../lib/anthropic.js";
import type { Article } from "../types.js";
import { logger } from "../lib/logger.js";

export interface TranslationResult {
  translatedText: string;         // the bias-stripped version, with inline [removed: X] annotations
  removedFallacies: string[];     // e.g. ["appeal to fear", "ad hominem", "whataboutism"]
  notableChanges: string[];       // short bullets describing the biggest edits
  modelUsed: string;
}

// Minimum body length for translation. Below this we lack enough text to do
// anything meaningful and the user would just get a restatement of the stub.
// 300 words ≈ 1800 chars; the build prompt uses 300 as the threshold.
export const TRANSLATION_MIN_WORDS = 300;

export class TooShortError extends Error {
  constructor(public wordCount: number) {
    super(`Article has ${wordCount} words; translation requires at least ${TRANSLATION_MIN_WORDS}`);
    this.name = "TooShortError";
  }
}

const TRANSLATOR_SYSTEM = `
You are a rewrite editor for Litmus, a news-reading tool. Your job is to take a political news article and return a faithful, bias-stripped version that reads like a wire-service report of the same story.

WHAT TO STRIP:
- Loaded verbs — "slammed", "torched", "caved", "lashed out", "blasted", "fired back" → use neutral verbs: "criticized", "said", "agreed to", "responded".
- Emotional adverb stacking — "brutally", "shockingly", "stunningly", "absolutely".
- Catastrophizing and scare framing — rephrase as factual framing.
- Rhetorical questions used as arguments — cut or convert to a statement.
- Metaphors of violence or war when not literal.
- Logical fallacies — appeal to fear, ad hominem, false dilemma, slippery slope, straw man, whataboutism, cherry-picking, anecdote-as-evidence. When you remove one, insert an inline annotation: [removed: appeal to fear] right where the fallacy was.
- Emotional anecdote ledes — restructure to inverted pyramid: lead with what happened, who it affected, when and where, then context.

WHAT TO PRESERVE:
- Every factual claim, date, name, number, and place.
- Every direct quote, VERBATIM, in quotation marks, with attribution.
- Every named source.
- Proportional representation of multiple perspectives (if the original was 80/20, DO surface the buried 20 — do not invent balance that wasn't there).
- The story's meaning. You are not arguing with the article; you are dressing it in wire-service clothes.

RULES:
- Do NOT invent content. If a detail isn't in the original, do not add it.
- Do NOT take a political position. Neither "fair and balanced" nor "fact-checked" — just report what happened.
- Do NOT make it shorter than it has to be. A faithful wire-report translation of a 700-word op-ed might be 500 words; don't cut to 200.
- DO keep the reading level and vocabulary accessible — this is a news app for adults who want clarity.
- Your output IS the translation. Do not include preamble like "Here is the translation:" — just the text.

TOOL OUTPUT:
Use the submit_translation tool. Return:
1. translated_text — the full rewritten article
2. removed_fallacies — a short list of the fallacy types you stripped (use the names above: "appeal to fear", "ad hominem", etc.). Empty array if you didn't strip any.
3. notable_changes — 3–6 short bullets describing the biggest edits. Examples: "Replaced 'slammed' with 'criticized' throughout". "Moved buried counter-quote from Senator X to paragraph 3". "Removed emotional anecdote lede; replaced with factual lede."
`.trim();

const TRANSLATE_TOOL = {
  name: "submit_translation",
  description: "Submit the bias-stripped translation of the article.",
  input_schema: {
    type: "object" as const,
    properties: {
      translated_text: {
        type: "string",
        description: "Full rewritten article, with inline [removed: ...] annotations where fallacies were stripped.",
      },
      removed_fallacies: {
        type: "array",
        items: { type: "string" },
        description: "Short list of fallacy types removed, empty array if none.",
      },
      notable_changes: {
        type: "array",
        items: { type: "string" },
        description: "3-6 short bullets describing the biggest edits.",
      },
    },
    required: ["translated_text", "removed_fallacies", "notable_changes"],
    additionalProperties: false,
  },
};

interface ToolInput {
  translated_text: string;
  removed_fallacies: string[];
  notable_changes: string[];
}

// Send the article to Sonnet and get back a translation. Throws TooShortError
// if the article is below the word-count threshold — that's a business rule,
// not an API error, so the caller can return 400 with a useful message.
export async function translateArticle(article: Article): Promise<TranslationResult> {
  if (article.wordCount < TRANSLATION_MIN_WORDS) {
    throw new TooShortError(article.wordCount);
  }

  const userMessage = `Source: ${article.title}
Author: ${article.author ?? "unknown"}
URL: ${article.url}
Word count: ${article.wordCount}

---

${article.rawText}`;

  const client = anthropic();
  const response = await client.messages.create({
    model: models.translator,
    max_tokens: 4096,
    system: TRANSLATOR_SYSTEM,
    tools: [TRANSLATE_TOOL],
    tool_choice: { type: "tool", name: "submit_translation" },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = response.content.find(
    (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
  );
  if (!toolUse) {
    logger.error("translator returned no tool_use block", { stop_reason: response.stop_reason });
    throw new Error("Claude did not call submit_translation");
  }

  const input = toolUse.input as ToolInput;
  if (!input?.translated_text || typeof input.translated_text !== "string") {
    throw new Error("submit_translation returned malformed input");
  }

  return {
    translatedText: input.translated_text,
    removedFallacies: Array.isArray(input.removed_fallacies) ? input.removed_fallacies : [],
    notableChanges: Array.isArray(input.notable_changes) ? input.notable_changes : [],
    modelUsed: models.translator,
  };
}
