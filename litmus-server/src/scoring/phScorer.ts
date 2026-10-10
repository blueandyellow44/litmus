// Send a batch of articles to Claude Haiku and get back P/H scores.
// Uses tool-use to force structured JSON — much more reliable than regex parsing
// of free-text responses.

import { anthropic, models } from "../lib/anthropic.js";
import {
  CALIBRATION_INSTRUCTIONS,
  bandFor,
  LABELS,
  MARKER_CATEGORIES,
  SECTIONS,
  type Label,
  type MarkerCategory,
  type PHMarker,
  type Section,
} from "./calibration.js";
import {
  applyRegisterPin,
  computeComposite,
  REGISTERS,
  type CompositeBreakdown,
  type CompositeDimensions,
  type CompositeFlags,
} from "./composite.js";
import { admitScore } from "./invariants.js";
import { judgeWithJev, type JevJudgment } from "./jevJudge.js";
import { jevAvailable, JEV_MODEL } from "../lib/jev.js";
import { env } from "../lib/env.js";
import { buildScoreWindow } from "./scoreWindow.js";
import {
  parseDeclaredBand,
  parseFlags,
  parsePoliticalLean,
  reconcileIds,
} from "./admission.js";
import { CONTENT_TYPES, admitContent, isPublishableType } from "./contentType.js";
import { markExcerpt, mergeMarkers } from "./markExcerpt.js";
import { biggestDriver, driversText, isDriverReason, retryReasons } from "./reasonCheck.js";
// Shared with the excerpt pass. One implementation, two callers.
import { occursOutsideQuotes, isPageFurniture, dropNonStaffSpeech, isTooWeakToMark, markerWhy } from "./markerGuards.js";
import { splitParagraphs } from "../lib/paragraphs.js";
import type { Article } from "../types.js";
import { logger } from "../lib/logger.js";

export type { PHMarker, Section } from "./calibration.js";

export interface DimensionRationale {
  headline: string;
  language: string;
  sourcing: string;
  fallacies: string;
  structure: string;
  // Null when the one-liner failed the reason check and its one retry
  // (reasonCheck.ts). Never a news summary presented as a reason.
  summary: string | null;
}

export interface PHScore {
  articleId: number;
  // The RAW dimensions, exactly as the model judged them, after parsing and
  // range-clamping and before any flag-driven floor. These are the model's
  // testimony and are stored unmodified so a published score can always be
  // separated into "what the model said" and "what the arithmetic did with it".
  // The post-floor values live in `breakdown.effectiveDimensions`; the composite
  // is computed from THOSE, never from these. Do not conflate the two — a
  // sourcing of 1.2 raw and 3.0 effective is one article, and both numbers are
  // true about it.
  headline: number;
  language: number;
  sourcing: number;
  fallacies: number;
  structure: number;
  composite: number;
  // How the composite was reached, term by term. Computed in code, so it can be
  // shown to a reader or audited later.
  breakdown: CompositeBreakdown;
  flags: CompositeFlags;
  label: Label;
  rationale: DimensionRationale;
  markers: PHMarker[];
  excerptIndices: number[];
  politicalLean: number; // -100..+100, independent of P/H
  articleSummary: string; // neutral "just the facts"
  // Internal to the Story Ledger's grouping decision, never shown to readers.
  // Unlike articleSummary this is deliberately allowed to carry relational
  // context ("responding to X's essay") - null means either not yet scored
  // under this field, or the article does not report itself as a reaction;
  // a grouping decision treats both the same way.
  reactingTo: string | null;
  section: Section | null;
  modelUsed: string;
  // The band the model committed to BEFORE choosing a decimal. Not persisted —
  // it exists so a calibration run can catch the model naming one band and then
  // emitting a composite from another, which is the tell that "pick the band
  // first" is being skipped and the old middle-hugging reflex is back.
  declaredBand?: Label | null;
}

const MARKER_CATEGORY_SET = new Set<string>(MARKER_CATEGORIES);
const STRIP_PTAG = /^\s*\[P\d+\]\s*/; // defensive: drop a [P#] prefix if the model copies it

// The body handed to the scorer. Bounded at MAX_BODY_CHARS, but head AND tail
// rather than head only — a long read buries its counterpoint and turns its
// register past the old 6,000-character cut, so "sourcing" and "structure" were
// being judged on a window that could not contain the evidence. See
// scoreWindow.ts. The 250–500 word reader excerpt is still built server-side
// from the FULL rawText, so this bound never shrinks what a reader sees.
export function buildArticlePayload(article: Article): {
  article_id: number;
  source_paywall_partial: boolean;
  title: string;
  paragraph_count: number;
  body_is_complete: boolean;
  body: string;
} {
  const paragraphs = splitParagraphs(article.rawText);
  const window = buildScoreWindow(paragraphs);
  return {
    article_id: article.id,
    source_paywall_partial: article.extractionStatus === "partial",
    title: article.title,
    paragraph_count: paragraphs.length,
    // Named in the payload so the model is told, rather than left to infer from
    // an elision marker, that it is looking at part of a longer piece.
    body_is_complete: window.complete,
    body: window.body,
  };
}

const SCORE_TOOL = {
  name: "submit_scores",
  description: "Submit P/H scores for the batch of articles you were given.",
  input_schema: {
    type: "object" as const,
    properties: {
      scores: {
        type: "array",
        description: "One entry per article in the same order as the input.",
        items: {
          type: "object",
          properties: {
            article_id: { type: "integer", description: "The article_id you were given." },
            content_type: {
              type: "string",
              enum: [...CONTENT_TYPES],
              description:
                "WHAT THIS PAGE IS. article or transcript are publishable; listing, navigation, furniture and other are not and stop it being scored. Decide this FIRST and answer it honestly even when the rest of the fields are easy to fill in.",
            },
            headline:   { type: "number",  description: "1.0–5.0, one decimal." },
            language:   { type: "number",  description: "1.0–5.0, one decimal." },
            sourcing:   { type: "number",  description: "1.0–5.0, one decimal." },
            fallacies:  { type: "number",  description: "1.0–5.0, one decimal." },
            structure:  { type: "number",  description: "1.0–5.0, one decimal." },
            band:       { type: "string",  enum: [...LABELS], description: "Your holistic read: which band the article matches, chosen from the anchor descriptions." },
            flags: {
              type: "object",
              description: "Structured observations. The composite is computed from these plus the dimensions; you do not report a composite.",
              properties: {
                emotional_lede:     { type: "boolean", description: "Does the piece make the reader FEEL something before giving them facts?" },
                loaded_headline:    { type: "boolean", description: "Does the headline use a loaded verb, catastrophizing, scare quotes, or victory/defeat framing?" },
                fallacy_count:      { type: "integer", description: "How many DISTINCT logical fallacies appear in the outlet's own reasoning. 0 if none." },
                one_sided_sourcing: { type: "boolean", description: "Is one side absent, or given token space next to the other?" },
                opinion_column:     { type: "boolean", description: "Is this an opinion column, editorial, or review rather than reporting?" },
                register:           { type: "string", enum: [...REGISTERS], description: "news for hard news; sports, culture, or feature where vivid language is genre convention." },
              },
              required: ["emotional_lede", "loaded_headline", "fallacy_count", "one_sided_sourcing", "opinion_column", "register"],
              additionalProperties: false,
            },
            rationale: {
              type: "object",
              properties: {
                headline:  { type: "string" },
                language:  { type: "string" },
                sourcing:  { type: "string" },
                fallacies: { type: "string" },
                structure: { type: "string" },
                summary:   { type: "string", description: "One sentence, shown to readers as 'Why this score': WHY the article earned its band. Name the specific choices that moved it (the headline, the outlet's own word choices, whose voices are quoted and whose are missing). Never restate the news; article_summary does that." },
              },
              required: ["headline", "language", "sourcing", "fallacies", "structure", "summary"],
              additionalProperties: false,
            },
            markers: {
              type: "array",
              description: "Phrase-level highlights. Each text MUST be an exact verbatim substring of the body (no [P#] prefix).",
              items: {
                type: "object",
                properties: {
                  text:      { type: "string", description: "Exact verbatim span copied from the body." },
                  category:  { type: "string", enum: [...MARKER_CATEGORIES] },
                  intensity: { type: "integer", description: "1–5, how far it veers (see instructions)." },
                  why:       { type: "string",  description: "Twelve words or fewer, plain English, shown to readers under the quote: what this exact wording does that makes it loaded (or grounded). Name the move, e.g. 'labels Trump's role as illegitimate without saying who appointed whom' or 'gives a checkable figure and its source'. Never restate the category name." },
                },
                required: ["text", "category", "intensity", "why"],
                additionalProperties: false,
              },
            },
            excerpt_paragraphs: {
              type: "array",
              description: "1–2 anchor paragraph indices (the [P#] numbers) where the ~300-word illustrative excerpt should begin.",
              items: { type: "integer" },
            },
            political_lean: { type: "integer", description: "-100 (far left) .. 0 (center) .. +100 (far right). Independent of P/H." },
            article_summary: { type: "string", description: "2–3 neutral 'just the facts' sentences." },
            reacting_to: {
              type: "string",
              description:
                "Internal, not shown to readers. If the article itself explicitly frames its content as responding to, elaborating on, or reacting to another specific named event, statement, or publication (e.g. 'in response to X's essay', 'after Y said...', a named person's later interview on their own earlier proposal), name that triggering event/statement in one short clause, close to how the article itself states the connection. Do not infer a connection the article does not state — shared topic or timing alone is not enough. If the article does not explicitly frame itself as a reaction, return exactly \"none\".",
            },
            section: { type: "string", enum: [...SECTIONS], description: "The article's newspaper section." },
          },
          required: ["article_id", "content_type", "headline", "language", "sourcing", "fallacies", "structure", "band", "flags", "rationale", "markers", "excerpt_paragraphs", "political_lean", "article_summary", "reacting_to", "section"],
          additionalProperties: false,
        },
      },
    },
    required: ["scores"],
    additionalProperties: false,
  },
};

interface RawMarker {
  text?: unknown;
  category?: unknown;
  intensity?: unknown;
  why?: unknown;
}

interface ToolUseScoreInput {
  scores: Array<{
    article_id: number;
    content_type?: unknown;
    headline: number;
    language: number;
    sourcing: number;
    fallacies: number;
    structure: number;
    band?: unknown;
    flags?: unknown;
    rationale: DimensionRationale;
    markers?: RawMarker[];
    excerpt_paragraphs?: unknown[];
    political_lean?: unknown;
    article_summary?: unknown;
    reacting_to?: unknown;
    section?: unknown;
  }>;
}

const SECTION_SET = new Set<string>(SECTIONS);

// Section is the one place a null is still honest: it means "unclassified", it
// is typed `Section | null` all the way to the DTO, and no surface converts it
// into a specific section. Compare political_lean, which had the same shape and
// defaulted to 0 — a number that renders as "Center".
function sanitizeSection(s: unknown): Section | null {
  return typeof s === "string" && SECTION_SET.has(s) ? (s as Section) : null;
}

// "none" (the model's explicit no-reaction answer) and anything unparseable
// both collapse to null — see the reactingTo field comment on PHScore.
function sanitizeReactingTo(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "none") return null;
  return trimmed;
}

// The tool schema requests rationale, but the API does not strictly enforce
// input_schema — never trust it. A missing/malformed rationale must not become
// undefined (JSON.stringify(undefined) -> NULL -> NOT NULL violation on insert).
function sanitizeRationale(r: unknown): DimensionRationale {
  const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    headline:  str(o.headline),
    language:  str(o.language),
    sourcing:  str(o.sourcing),
    fallacies: str(o.fallacies),
    structure: str(o.structure),
    summary:   str(o.summary),
  };
}

// A dimension the model did not return as a usable number is NOT a 3.0.
//
// It used to be. A missing, null, string, NaN or Infinity dimension silently
// became 3.0 — dead centre of the scale, the most plausible-looking number
// available, and completely invented. It then flowed into the weighted
// composite, the published band, and the term-by-term breakdown the reader is
// shown, with nothing anywhere recording that a fifth of the judgement was
// fabricated. That is the exact failure mode this instrument exists to catch in
// other people's writing.
//
// Returning null instead makes the caller decide, and the caller rejects the
// article. Out-of-range but genuinely numeric values are still CLAMPED rather
// than rejected: 5.4 is a model overshooting a scale it was told the top of, and
// the intent is unambiguous, which is not true of NaN.
export function parseDim(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(1.0, Math.min(5.0, Math.round(n * 10) / 10));
}

const DIMENSION_KEYS = ["headline", "language", "sourcing", "fallacies", "structure"] as const;

// Every dimension, or the names of the ones that did not parse.
export function parseDimensions(
  raw: Record<string, unknown>,
): { dimensions: CompositeDimensions } | { missing: string[] } {
  const parsed: Partial<CompositeDimensions> = {};
  const missing: string[] = [];
  for (const key of DIMENSION_KEYS) {
    const v = parseDim(raw[key]);
    if (v === null) missing.push(key);
    else parsed[key] = v;
  }
  if (missing.length > 0) return { missing };
  return { dimensions: parsed as CompositeDimensions };
}

function clampIntensity(n: unknown): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

// Spans of quoted speech (curly or straight). The hard silo: a span inside a
// named speaker's quote is not the outlet's voice, so it is never marked.
//
// MUST STAY BYTE-IDENTICAL with the other three copies:
//   litmus-server/src/scoring/phScorer.ts
//   litmus-server/src/scoring/markExcerpt.ts
//   litmus-server/src/scoring/calibrate-run.ts
//   litmus-client/src/lib/loadedLexicon.ts
// Each one runs over a DIFFERENT string — the full rawText, the joined excerpt
// passage, and per-paragraph on the client — so any divergence silos different
// text in each scope, and the client drops a highlight the server allowed.
//
// The body excludes \n deliberately. Without it, one unpaired straight quote
// flips open/close pairing for the entire remainder of the string, and because
// the scopes differ that mispairing lands in a different place in each — which
// is how a stretch of plain narration got siloed server-side while the client
// disagreed. Forbidding a span from crossing a line break makes pairing restart
// per line, so all three scopes agree.
function quotedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const RE = /[“"][^”"\n]*[”"]/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

// Keep only markers whose category is valid, whose text appears VERBATIM in the
// article body, and which do not start inside quoted speech. A [P#] prefix (if
// the model copied it) is stripped first.
//
// The quote silo is enforced HERE rather than left to the prompt. It is stated
// three times in the instructions and the model still reaches into quotes when
// pushed for marker density — the 2026-08-02 smoke run more than doubled the
// violations. The client already refuses to render these, so an instruction-only
// silo produced markers that were silently discarded downstream: the stored data
// claimed a density the page never showed. Enforcing it in code makes the stored
// markers match what renders, and makes the density metric honest.
function sanitizeMarkers(raw: RawMarker[] | undefined, rawText: string): PHMarker[] {
  if (!Array.isArray(raw)) return [];
  const quotes = quotedSpans(rawText);
  const startsInQuote = (i: number) => quotes.some(([a, b]) => i >= a && i < b);
  const out: PHMarker[] = [];
  for (const m of raw) {
    if (typeof m?.text !== "string" || typeof m?.category !== "string") continue;
    if (!MARKER_CATEGORY_SET.has(m.category)) continue;
    const text = m.text.replace(STRIP_PTAG, "").trim();
    if (text.length === 0) continue;
    // Resolve the span the model MEANT, not merely its first occurrence.
    //
    // The old form took rawText.indexOf(text) and siloed on that one position.
    // A phrase that appears both in the reporter's narration and inside a
    // quotation was therefore adjudicated on whichever came first in the
    // article: a narration instance was dropped because an earlier quoted one
    // existed, and a quoted instance was published because an earlier narration
    // one did. Prefer an occurrence outside quoted speech; only when EVERY
    // occurrence sits inside a quote is the marker genuinely quoted speech and
    // dropped. Same reasoning as the silo itself — the instrument marks the
    // outlet's words, so if the outlet used the phrase in its own voice
    // anywhere, that is the instance being marked.
    if (!occursOutsideQuotes(rawText, text, startsInQuote)) continue;
    if (isPageFurniture(text)) continue;
    out.push({ text, category: m.category as MarkerCategory, intensity: clampIntensity(m.intensity), ...markerWhy(m.why) });
  }
  return out;
}



// Validate the LLM's excerpt paragraph indices against the real paragraph count.
function sanitizeExcerptIndices(raw: unknown[] | undefined, paragraphCount: number): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v)) continue;
    if (v < 0 || v >= paragraphCount) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length === 2) break; // anchor is 1–2 paragraphs; server grows it to a word window
  }
  return out;
}

// Overrides for a calibration run. Production callers pass nothing and get the
// shipped prompt + shipped scorer model; the calibration harness swaps either
// one so a candidate prompt and a candidate model can be measured against the
// live pair without touching the production path.
export interface ScoreBatchOptions {
  instructions?: string;
  model?: string;
  // Run the focused excerpt-marking pass after scoring (default true). See
  // markExcerpt.ts — it is what makes the reader's passage densely highlighted.
  markExcerpt?: boolean;
  // Called with the raw API token counts after each successful call, so a
  // caller can price a run. Never throws into the scoring path.
  onUsage?: (usage: { inputTokens: number; outputTokens: number; model: string }) => void;
  // Who judges the numbers. Defaults to env.P_H_JUDGE. See jevJudge.ts.
  judge?: "haiku" | "jev";
}

// Appended to the system prompt when Jev has judged some of the batch. Haiku
// still writes every text field; it is told the numbers so its rationale,
// highlights and summary explain the score that is published rather than a
// different one of its own.
export const JEV_SET_SCORES_NOTE = `

SCORES ALREADY SET FOR SOME ARTICLES:
Some articles in this batch carry a "set_scores" object. For those articles the five dimension scores, the band, the flags and (when present) political_lean have already been judged. Return exactly those values in your tool call, and write every other field (rationale, markers, excerpt_paragraphs, article_summary, reacting_to, section, content_type, and political_lean only when set_scores carries none) so that it explains and fits those scores. Do not re-score them and do not argue with them in the rationale. rationale.summary must still say WHY those scores fit, citing this article's own choices; a summary of the news is not a reason. set_scores.drivers names what pushed the score up and what held it down: rationale.summary must talk first about the top driver (the first dimension named). Articles without "set_scores" are scored by you exactly as instructed above.`;

function setScoresFor(j: JevJudgment) {
  // What set the number, in plain words, so the Why line can name it (Max,
  // 2026-10-02). Computed from the same composite the page publishes.
  const effective = computeComposite(j.dimensions, j.flags).effectiveDimensions;
  return {
    drivers: driversText(effective),
    ...j.dimensions,
    band: j.declaredBand,
    ...(j.politicalLean !== null ? { political_lean: j.politicalLean } : {}),
    flags: {
      emotional_lede: j.flags.emotionalLede,
      loaded_headline: j.flags.loadedHeadline,
      fallacy_count: j.flags.fallacyCount,
      one_sided_sourcing: j.flags.oneSidedSourcing,
      opinion_column: j.flags.opinionColumn,
      register: j.flags.register,
    },
  };
}

// Jev's judgement for each article it could judge. An article Jev fails on is
// simply absent, and Haiku judges it as before: a Jev outage degrades to the
// old scorer, it never stops scoring.
async function judgeBatchWithJev(articles: Article[], opts: ScoreBatchOptions): Promise<Map<number, JevJudgment>> {
  const out = new Map<number, JevJudgment>();
  if (!jevAvailable()) {
    logger.warn("P_H_JUDGE is jev but Jev is not available; Haiku judges this batch", { articles: articles.length });
    return out;
  }
  await Promise.all(articles.map(async (article) => {
    const p = buildArticlePayload(article);
    try {
      const j = await judgeWithJev(p.title, p.body, p.body_is_complete);
      out.set(article.id, j);
      try { opts.onUsage?.({ inputTokens: j.inputTokens, outputTokens: 0, model: JEV_MODEL }); } catch { /* accounting never fails scoring */ }
    } catch (err) {
      logger.warn("jev judgement failed; Haiku judges this article", { articleId: article.id, err: err instanceof Error ? err.message : String(err) });
    }
  }));
  return out;
}

// Send a batch (typically 10) to Haiku and get scores back. Throws on hard
// failure; caller is responsible for retry policy.
export async function scoreBatch(
  articles: Article[],
  opts: ScoreBatchOptions = {},
): Promise<PHScore[]> {
  if (articles.length === 0) return [];

  const model = opts.model ?? models.scorer;
  const judge = opts.judge ?? env.P_H_JUDGE;
  const jevJudged = judge === "jev" ? await judgeBatchWithJev(articles, opts) : new Map<number, JevJudgment>();
  const instructions = (opts.instructions ?? CALIBRATION_INSTRUCTIONS) + (jevJudged.size > 0 ? JEV_SET_SCORES_NOTE : "");

  const payload = articles.map((article) => {
    const p = buildArticlePayload(article);
    const j = jevJudged.get(article.id);
    return j ? { ...p, set_scores: setScoresFor(j) } : p;
  });
  const userMessage = `Score the following ${articles.length} article(s). Return one entry per article via the submit_scores tool, preserving article_id.

${JSON.stringify(payload, null, 2)}`;

  const client = anthropic();
  const response = await client.messages.create({
    model,
    max_tokens: 16384, // markers + excerpt add output; headroom prevents truncated tool JSON
    system: instructions,
    tools: [SCORE_TOOL],
    tool_choice: { type: "tool", name: "submit_scores" },
    messages: [{ role: "user", content: userMessage }],
  });

  if (opts.onUsage) {
    try {
      opts.onUsage({
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        model,
      });
    } catch {
      // A usage-accounting failure must never fail a paid scoring call.
    }
  }

  // A truncated response yields half-written tool JSON, which the SDK surfaces
  // as a partial input object. Fail loudly rather than persisting a batch whose
  // markers were cut off mid-array.
  if (response.stop_reason === "max_tokens") {
    logger.error("scorer response hit max_tokens", { model, articles: articles.length });
    throw new Error("scorer response truncated at max_tokens");
  }

  // Find the tool_use block
  const toolUse = response.content.find(
    (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use",
  );
  if (!toolUse) {
    logger.error("scorer returned no tool_use block", { stop_reason: response.stop_reason });
    throw new Error("Claude did not call submit_scores");
  }

  const input = toolUse.input as ToolUseScoreInput;
  if (!input?.scores || !Array.isArray(input.scores)) {
    throw new Error("submit_scores returned malformed input");
  }

  // Match what came back against what was asked for, BEFORE reading any of it.
  //
  // This was `new Map(scores.map(s => [s.article_id, s]))`, which is
  // last-write-wins in silence: two entries for one article meant the second
  // quietly won and nothing recorded that a first one existed. Neither answer is
  // trustworthy once they disagree, so a duplicated id is dropped and re-queued.
  // An id nobody asked for is worse than useless — it means the model has
  // transposed an article number, and using it would attach one article's score
  // to another article's body.
  const ids = reconcileIds(
    articles.map((a) => a.id),
    input.scores,
  );
  if (ids.duplicated.length > 0) {
    logger.warn("scorer returned duplicate entries for the same article", {
      articleIds: ids.duplicated,
      action: "both entries dropped; articles re-queued",
    });
  }
  if (ids.missing.length > 0) {
    logger.warn("scorer skipped articles", { articleIds: ids.missing });
  }
  if (ids.unrequested.length > 0) {
    logger.warn("scorer returned entries for articles it was not given", {
      articleIds: ids.unrequested,
      action: "ignored",
    });
  }

  const out: PHScore[] = [];
  // Articles the model returned but whose entry could not be published. They are
  // simply absent from the result: the caller re-queues them, exactly as it
  // already does for an article the model skipped entirely.
  const rejected: number[] = [];
  // Rejected specifically for not being an article. Counted separately because a
  // rise here is an INGEST problem — a feed serving index pages — not a scorer
  // problem, and conflating the two would hide it.
  const notArticles: number[] = [];
  for (const article of articles) {
    const raw = ids.usable.get(article.id) as ToolUseScoreInput["scores"][number] | undefined;
    if (!raw) continue; // already logged above as missing or duplicated
    const paragraphCount = splitParagraphs(article.rawText).length;

    // Is this an article at all? Two gates, either sufficient to refuse: the
    // model's required structured classification, and a deterministic check on
    // the body's SHAPE that needs no model. See contentType.ts — an NBC video
    // index page was published twice, once as 3.5 Running Hot and once as 1.0
    // Practical, and the model had said in its own rationale that it was not an
    // article both times.
    const jev = jevJudged.get(article.id);
    const content = admitContent(raw.content_type, article.rawText);
    // Either judge saying "not an article" refuses it.
    if (content.admit && jev?.contentType && !isPublishableType(jev.contentType)) {
      content.admit = false;
      content.reasons.push(`jev classified the page as ${jev.contentType}`);
    }
    if (!content.admit) {
      rejected.push(article.id);
      notArticles.push(article.id);
      logger.warn("article rejected: not publishable content", {
        articleId: article.id,
        url: article.url,
        contentType: content.contentType,
        reasons: content.reasons,
      });
      continue;
    }

    // Everything the model returned that carries a claim, parsed by something
    // that is allowed to say no. See admission.ts: a missing flag is not `false`,
    // an unreadable political_lean is not 0, and the declared band is required
    // rather than optional (a check the checked thing can switch off is not a
    // check).
    // Jev's numbers replace Haiku's wherever Jev judged the article, political
    // lean included (Max, 2026-10-02); Haiku's lean is used only when Jev
    // returned none.
    const flagsParsed = jev ? { ok: true as const, value: jev.flags } : parseFlags(raw.flags);
    const leanParsed = jev && jev.politicalLean !== null ? { ok: true as const, value: jev.politicalLean } : parsePoliticalLean(raw.political_lean);
    const bandParsed = jev ? { ok: true as const, value: jev.declaredBand } : parseDeclaredBand(raw.band);
    const parsed = jev ? { dimensions: jev.dimensions } : parseDimensions(raw as unknown as Record<string, unknown>);

    const problems: string[] = [];
    if (!flagsParsed.ok) problems.push(...flagsParsed.problems);
    if (!leanParsed.ok) problems.push(...leanParsed.problems);
    if (!bandParsed.ok) problems.push(...bandParsed.problems);
    if ("missing" in parsed) {
      problems.push(`dimensions did not parse: ${parsed.missing.join(", ")}`);
    }
    if (problems.length > 0) {
      rejected.push(article.id);
      logger.warn("article rejected: model output did not parse", {
        articleId: article.id,
        problems,
      });
      continue;
    }

    const declaredBand = (bandParsed as { ok: true; value: Label }).value;
    const politicalLean = (leanParsed as { ok: true; value: number }).value;
    // A source that only ever files one kind of piece PINS its register, and the
    // pin wins over the model's per-article guess. It is applied to a register
    // that already PARSED, so the pin corrects a valid answer rather than
    // papering over a missing one.
    //
    // Enforced here rather than in the prompt, for the same reason the quote
    // silo is: register is load-bearing in two places at once and the model's
    // answer was not stable. It selects the marker exemption, and inside
    // computeComposite a non-news register halves the language weight and
    // switches off the loaded-headline and emotional-lede floors. The same NPR
    // politics article came back "news" on one run and "feature" on the next,
    // which moves both the highlights and the score on a coin flip.
    const flags = applyRegisterPin(
      (flagsParsed as { ok: true; value: CompositeFlags }).value,
      article.sourceRegister ?? null,
    );
    const { dimensions } = parsed as { dimensions: CompositeDimensions };

    // The published number is computed, never reported. See composite.ts.
    const breakdown = computeComposite(dimensions, flags);
    const composite = breakdown.composite;

    // The gate. Contradictions between the flags and the dimensions, floors
    // that did not bind, and a holistic band too far from the computed one all
    // land here. See invariants.ts for why a contradiction is rejected rather
    // than repaired, and why adjacent band disagreement is not.
    const admission = admitScore({
      dimensions,
      effectiveDimensions: breakdown.effectiveDimensions,
      flags,
      composite,
      declaredBand,
    });
    // Jev answers the holistic band as its own question, not in the same breath
    // as its numbers, so a band two steps from its computed composite is not the
    // self-contradiction this gate was built to catch in one model's answer. It
    // is logged and published; every other violation still refuses the article.
    const jevBandOnly = !!jev && !admission.admit && admission.violations.every((v) => v.rule === "declared-band-distance");
    if (jevBandOnly) {
      logger.warn("jev declared band disagrees with its computed composite", { articleId: article.id, declaredBand, composite });
    }
    if (!admission.admit && !jevBandOnly) {
      rejected.push(article.id);
      logger.warn("article rejected: score failed its own invariants", {
        articleId: article.id,
        composite,
        declaredBand,
        violations: admission.violations.map((v) => `${v.rule}: ${v.detail}`),
      });
      continue;
    }
    if (admission.bandVerdict.verdict === "tolerated") {
      // Published, but counted. One of these is the known middle-hugging
      // behaviour; a run full of them means the dimensions are not capturing
      // what the model can see.
      logger.warn("holistic band disagrees with computed composite", {
        articleId: article.id,
        declaredBand,
        composite,
        computedBand: admission.bandVerdict.computed,
      });
    }

    out.push({
      articleId: article.id,
      ...dimensions,
      composite,
      breakdown,
      flags,
      label: bandFor(composite).label,
      rationale: sanitizeRationale(raw.rationale),
      markers: sanitizeMarkers(raw.markers, article.rawText),
      excerptIndices: sanitizeExcerptIndices(raw.excerpt_paragraphs, paragraphCount),
      politicalLean,
      articleSummary: typeof raw.article_summary === "string" ? raw.article_summary.trim() : "",
      reactingTo: sanitizeReactingTo(raw.reacting_to),
      section: sanitizeSection(raw.section),
      modelUsed: jev ? `${JEV_MODEL}+${model}` : model,
      declaredBand,
    });
  }

  if (rejected.length > 0) {
    logger.warn("batch published fewer scores than it was paid for", {
      requested: articles.length,
      published: out.length,
      rejected,
      notArticles,
    });
  }

  // The "Why" line must be a reason (reasonCheck.ts). Every failing one-liner
  // in the batch is retried once, in one call; a second failure stores null.
  const failing = out.filter((score) => !isDriverReason(score.rationale.summary, biggestDriver(score.breakdown.effectiveDimensions)));
  if (failing.length > 0) {
    const retried = await retryReasons(
      failing.map((score) => ({
        articleId: score.articleId,
        title: articles.find((a) => a.id === score.articleId)?.title ?? "",
        band: score.label,
        composite: score.composite,
        dimensionNotes: {
          headline: score.rationale.headline, language: score.rationale.language, sourcing: score.rationale.sourcing,
          fallacies: score.rationale.fallacies, structure: score.rationale.structure,
        },
        failedSummary: score.rationale.summary ?? "",
        driver: biggestDriver(score.breakdown.effectiveDimensions),
        drivers: driversText(score.breakdown.effectiveDimensions),
      })),
      { model, onUsage: opts.onUsage },
    );
    for (const score of failing) score.rationale.summary = retried.get(score.articleId) ?? null;
    logger.info("reason check", {
      batch: out.length, failedFirst: failing.length,
      fixedByRetry: failing.filter((s) => s.rationale.summary !== null).length,
    });
  }

  // Second pass: mark the passage the reader will actually see. Run in parallel
  // across the batch — these are small, independent calls. A failure returns an
  // empty set and leaves the scoring pass's markers alone, so no article can
  // lose its score to a marking problem.
  if (opts.markExcerpt !== false) {
    await Promise.all(
      out.map(async (score) => {
        const article = articles.find((a) => a.id === score.articleId);
        if (!article) return;
        const windowMarkers = await markExcerpt(
          article.title,
          article.rawText,
          score.excerptIndices,
          // The register the scoring pass already judged. Without it the marking
          // pass cannot apply the sports/culture exemption and marks a match
          // report as hard as a political story.
          { model, onUsage: opts.onUsage, register: score.flags.register },
        );
        if (windowMarkers.length > 0) {
          score.markers = mergeMarkers(score.markers, windowMarkers);
        }
      }),
    );
  }

  // Last, on the merged set from both passes: a transcript guest's words are
  // quoted speech, and a mark too weak to claim loaded wording is not drawn.
  for (const score of out) {
    const article = articles.find((a) => a.id === score.articleId);
    if (!article) continue;
    score.markers = dropNonStaffSpeech(score.markers, article.rawText).filter((m) => !isTooWeakToMark(m));
  }

  return out;
}
