// A second, focused pass that marks ONLY the passage the reader is shown.
//
// Why this exists. The scoring call judges a whole article and picks the
// excerpt anchor, and asking it to also mark exhaustively does not work: the
// instruction has said "12-25 markers, never fewer than 6" through several
// revisions and the combined call kept returning four or five. It behaves like
// a model curating a highlight reel across a long input, which is a reasonable
// thing to do and the wrong thing here.
//
// Measured on 2026-08-02: the same model, given only the ~300 words the reader
// actually sees and one job to do, returned 23 verbatim markers on the same
// article the combined call marked four times. Roughly one marker every twelve
// words, which is the density the page was designed for.
//
// It is also the cheap pass, not the expensive one. Only markers inside the
// excerpt window ever reach the reader (see buildExcerptWindow), so marking the
// full body was mostly paying for output that gets filtered away. This call
// sends a few hundred words and gets back the markers that survive.

import { anthropic, models } from "../lib/anthropic.js";
import { MARKER_CATEGORIES, type MarkerCategory, type PHMarker } from "./calibration.js";
import type { Register } from "./composite.js";
// Shared with the scoring pass. One implementation, two callers — two copies
// would silo different text in each scope, the divergence the quotedSpans
// comment below already warns about.
import { occursOutsideQuotes, isPageFurniture, markerWhy } from "./markerGuards.js";
import { splitParagraphs, wordWindow } from "../lib/paragraphs.js";
import { logger } from "../lib/logger.js";

const MARKER_CATEGORY_SET = new Set<string>(MARKER_CATEGORIES);

export const MARK_INSTRUCTIONS = `
You mark phrase-level tone in ONE passage of a news article — the exact passage a reader will be shown, with the marks rendered as coloured highlights over the text.

MARK EVERY QUALIFYING SPAN. This is an exhaustive pass, not a highlight reel. A passage of roughly 300 words normally yields 12 to 25 markers, about one every dozen words. Returning four or five is a failure of the task, not evidence that the passage was plain. Walk it sentence by sentence: most sentences contain at least one markable span, and a sentence you skip renders as a flat grey gap on the page.

CATEGORIES.
GREEN, the writing doing its job:
- grounded — a CHECKABLE fact in the outlet's own voice: a number, a date, a place, an action someone took, a result that was recorded, a document that exists. The test is whether a reader could look it up and find it true or false. "44 people have been hospitalized" is grounded. "well-known" and "overwhelmingly backed" are not: they are the outlet's characterization, and if they lean they are RED.
- hedging — careful qualification that tells the reader how firm the claim is: "according to", "estimated", "may", "reportedly", "could last up to".

RED, the writing steering the reader:
- emotional_language — words doing emotional work ("terrifying", "outrageous", "glaring", "desperation").
- loaded_terms — slanted labels, epithets, and the outlet's own characterizations of a person, group, or position ("debacle", "sclerotic establishment", "so-called experts").
- headline_framing — catastrophizing, victory-or-defeat framing, scare quotes.
- language_intensity — loaded verbs and adverb stacking ("slams", "torched", "brutally"), violence or war metaphor applied to politics.
- logical_fallacy — appeal to fear, ad hominem, false dilemma, slippery slope, straw man, whataboutism, anecdote offered as evidence.
- structural_manipulation — an emotional anecdote used as a lede, buried context, cliffhanger anxiety.
- speculation — an unsupported prediction stated as fact ("this will destroy...").

SINGLE WORDS COUNT AND MUST BE MARKED ON THEIR OWN. One adjective, one adverb, or one verb doing emotional work is exactly the tell, and it does not need to be padded into a phrase to qualify.

RED IS AN ABSOLUTE JUDGEMENT, NOT A RANKING. Ask of each candidate: lifted out of this passage and read on its own, would this span steer a reader's civic judgement? Mark it only if the answer is yes. Do NOT mark the three most colourful phrases in a calm passage merely because they are the most colourful ones present — a flat piece of wire reporting is allowed to come back with no RED markers at all, and that is the correct answer for it rather than a failure of the task. The exhaustive instruction above is about not SKIPPING qualifying spans; it is not a quota, and it never licenses promoting an ordinary phrase to fill one.

A SOURCED SUPERLATIVE IS A FACT, NOT FRAMING. "the fastest-growing outbreak on record", "the largest single-day fall since 2008", "the first woman to hold the seat" are claims a reader can check against a record, and the qualifier ("on record", "since 2008") is what makes them checkable. They are GREEN (grounded). headline_framing is for catastrophizing with no factual basis and for victory-or-defeat framing, not for a superlative the piece has grounded. Mark a superlative RED only when nothing anchors it — "the worst crisis in living memory" with no record cited.

DESCRIBING IS NOT EDITORIALIZING. An accurate, checkable characterization of something that demonstrably happened is reporting, not loading. "a pattern of announcements the president has made", "the abrupt shifts", "the late Senator", "rejected the notion", "clashed" — these describe a verifiable record and are GREEN (grounded) or unmarked. The RED categories are for the outlet putting its thumb on the scale: contempt, an epithet, a verdict the facts have not earned, a motive assigned without evidence. The test is not whether a word carries colour, it is whether a reader could check the characterization against the record. If they could, it is not loaded_terms.

REGISTER. You are told the article's register. It changes what counts as loaded:
- sports — the genre is vivid by convention and it steers nobody's politics. In this register, describing PLAY and RESULT is never RED, however colourful the verb: "excellent", "thrilling", "a stunning collapse", "suffocated Leeds with their press", "threw away a two-goal lead", "looked sharp", "looked like a different team", "the best they have looked all pre-season". These are a reporter assessing a performance, which is the entire job of a match report, and they are GREEN (grounded) when they describe what observably happened on the pitch. RED in sports is reserved for the narrow case of the outlet turning on a person or group with real contempt — an epithet, a motive assigned without evidence, a moral verdict on someone's character. If your RED marks on a sports piece are all descriptions of play, you have marked none of them correctly: return no RED markers at all.
- culture — a review is allowed a strong opinion about the work it reviews. "clunky", "gorgeous", "a mess of a film" are criticism doing its job, not manipulation. Mark RED only where the piece steers civic judgement rather than aesthetic judgement.
- feature — an opening scene is the form, so do not mark a scene-setting lede as structural_manipulation.
- news — everything else, and the strict default. Every rule above applies at full strength.

NEVER MARK PAGE FURNITURE. The passage is extracted from a live web page and sometimes carries text that is not the article: advertising copy ("Unlimited Cashback Match"), newsletter or subscription prompts, photo credits, bylines, datelines, and a publication's standing section labels ("Why it matters:", "The big picture:", "Go deeper:", "Read more"). None of it is the reporter's prose. Emit no marker of either colour for it.

HARD SILO FOR QUOTED SPEECH. Emit NO marker for any span inside quotation marks attributed to a named speaker — not RED, and not GREEN either. A person's own words are invisible to this instrument. Only the outlet's own words are marked: the headline, the reporter's narration, paraphrase, characterization. The same sentence of fact gets a grounded marker in the reporter's voice and no marker at all inside a politician's quote.

INTENSITY, 1 to 5, sets how dark the highlight renders. Use the range.
- RED: 2 is a mild lean, 3 is clearly loaded, 4 is strong, 5 is extreme ("catastrophic", "destroy", "wreaking havoc"). Reserve 1 for a barely-there tilt.
- GREEN: higher means MORE cleanly factual. A hard number with a date is a 4 or 5. A soft general statement of fact is a 2. Do not flatten every green to 1; a passage of solid reporting should render as visibly green.

text must be an EXACT verbatim substring of the passage. Do not paraphrase, do not fix punctuation, do not include a [P#] tag. A span that is not an exact substring is discarded.
`.trim();

const MARK_TOOL = {
  name: "submit_markers",
  description: "Return every marker found in the passage.",
  input_schema: {
    type: "object" as const,
    properties: {
      markers: {
        type: "array",
        description: "Every qualifying span in the passage, in order of appearance.",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "Exact verbatim substring of the passage." },
            category: { type: "string", enum: [...MARKER_CATEGORIES] },
            intensity: { type: "integer", description: "1-5. See the intensity rule." },
            why: { type: "string", description: "Twelve words or fewer, plain English, shown to readers under the quote: what this exact wording does that makes it loaded (or grounded). Name the move, e.g. 'labels Trump's role as illegitimate without saying who appointed whom' or 'gives a checkable figure and its source'. Never restate the category name." },
          },
          required: ["text", "category", "intensity", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["markers"],
    additionalProperties: false,
  },
};

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

export interface MarkExcerptOptions {
  model?: string;
  onUsage?: (u: { inputTokens: number; outputTokens: number; model: string }) => void;
  // The article's register, from the scoring pass's flags. Without it this pass
  // marked a match report exactly as hard as a political story: measured across
  // 304 scored articles, Sports averaged 6.8 RED markers and Culture 7.3 against
  // Politics' 7.4, while their composites correctly fell away (1.99 and 2.25 vs
  // 2.43). The register exemption was reaching the five dimensions and never
  // reaching the markers, because this call was only ever given a headline and a
  // passage and so could not tell a sports recap from a war report. That is how
  // BBC Sport's "excellent" and "suffocated Leeds with their press" — the exact
  // phrases the rubric names as genre convention — came back tagged RED.
  register?: Register;
}

// Mark the excerpt window for one article. Returns markers validated against the
// PASSAGE, which is what the reader sees; callers merge them into the article's
// marker set. Never throws — a failed marking pass leaves the scoring pass's own
// markers in place rather than losing the article.
export async function markExcerpt(
  title: string,
  rawText: string,
  excerptIndices: number[],
  opts: MarkExcerptOptions = {},
): Promise<PHMarker[]> {
  const paragraphs = splitParagraphs(rawText);
  if (paragraphs.length === 0) return [];
  const indices = wordWindow(paragraphs, excerptIndices, []);
  const passage = indices
    .map((i) => paragraphs[i])
    .filter((p): p is string => !!p)
    .join("\n\n");
  if (passage.trim().length === 0) return [];

  const model = opts.model ?? models.scorer;

  try {
    const response = await anthropic().messages.create({
      model,
      max_tokens: 4096,
      system: MARK_INSTRUCTIONS,
      tools: [MARK_TOOL],
      tool_choice: { type: "tool", name: "submit_markers" },
      messages: [
        {
          role: "user",
          // Register is stated before the passage so the exemption is in hand
          // before the model reads a word of it. Defaults to the strict case.
          content:
            `Register: ${opts.register ?? "news"}\n` +
            `Headline: ${title}\n\nPassage:\n${passage}`,
        },
      ],
    });

    if (opts.onUsage) {
      try {
        opts.onUsage({
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
          model,
        });
      } catch {
        // Usage accounting must never fail the pass.
      }
    }

    const toolUse = response.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (!toolUse) {
      logger.warn("mark pass returned no tool_use", { model });
      return [];
    }
    const raw = (toolUse.input as { markers?: unknown }).markers;
    if (!Array.isArray(raw)) return [];

    // Validate against the PASSAGE. A span the model invented, or one sitting
    // inside quoted speech, is dropped here rather than shipped to the page.
    const quotes = quotedSpans(passage);
    const startsInQuote = (i: number) => quotes.some(([a, b]) => i >= a && i < b);
    const seen = new Set<string>();
    const out: PHMarker[] = [];
    for (const m of raw as Array<Record<string, unknown>>) {
      if (typeof m?.text !== "string" || typeof m?.category !== "string") continue;
      if (!MARKER_CATEGORY_SET.has(m.category)) continue;
      const text = m.text.trim();
      if (text.length === 0 || seen.has(text)) continue;
      // Same two guards as the scoring pass, and they matter more here: these
      // are the markers the reader actually sees. Resolve the instance the model
      // meant rather than the first occurrence (a phrase used both in narration
      // and in a quote was being adjudicated on whichever came first), and drop
      // extraction chrome such as "Why it matters:" outright.
      if (!occursOutsideQuotes(passage, text, startsInQuote)) continue;
      if (isPageFurniture(text)) continue;
      seen.add(text);
      const intensity =
        typeof m.intensity === "number" && Number.isFinite(m.intensity)
          ? Math.max(1, Math.min(5, Math.round(m.intensity)))
          : 3;
      out.push({ text, category: m.category as MarkerCategory, intensity, ...markerWhy(m.why) });
    }
    return out;
  } catch (err) {
    // A marking failure degrades to the scoring pass's markers. It must never
    // cost the article its score.
    logger.warn("mark pass failed", {
      model,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// Merge the dense window markers with the scoring pass's whole-article markers.
// Window markers win on overlap: they were produced by a pass that saw only the
// reader's passage, so they are the better read of it, and duplicates would just
// compete for the same span at render time.
export function mergeMarkers(articleMarkers: PHMarker[], windowMarkers: PHMarker[]): PHMarker[] {
  const windowTexts = new Set(windowMarkers.map((m) => m.text));
  const kept = articleMarkers.filter(
    (m) => !windowTexts.has(m.text) && !windowMarkers.some((w) => w.text.includes(m.text) || m.text.includes(w.text)),
  );
  return [...windowMarkers, ...kept];
}
