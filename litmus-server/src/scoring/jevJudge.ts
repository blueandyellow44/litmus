// Jev as the P/H judge (Max, 2026-09-27, "yes build it"). Jev answers the five
// dimensions on the production anchors, the flags, the register, the content
// type and the holistic band, over the SAME body window Haiku sees. Production
// code (computeComposite, the floors, admission) turns that into the published
// number, exactly as it does for Haiku. Haiku still writes every text field.
//
// Measured before building (experiments on branch experiment/two-way-scale-trial):
// against Max's 30 blind ratings Jev ranked articles closer to him than Haiku
// (Spearman 0.79 vs 0.66) and put 8 of his 10 hot articles at Running Hot or
// above (Haiku 4); on 645 human-labeled SemEval-2019 articles its AUC was 0.93.
import { askJev, type JevAnswer, type JevQuestion } from "../lib/jev.js";
import { LABELS, type Label } from "./calibration.js";
import { REGISTERS, type CompositeDimensions, type CompositeFlags, type Register } from "./composite.js";
import { CONTENT_TYPES, type ContentType } from "./contentType.js";

const WRITER = "Judge only the outlet's own words: headline, narration, paraphrase, structure and sourcing decisions. Words inside quotation marks that belong to a named speaker are siloed out entirely: they neither raise nor lower anything.";

// The anchors are the production prompt's (calibration.ts), one line per level.
export const JEV_QUESTIONS: Record<string, JevQuestion> = {
  content_type: { type: "choice", instructions: "What is this page?", criteria: {
    article: "A news article, report, analysis or opinion column", transcript: "A transcript of a broadcast or speech",
    listing: "An index, video list, or list of links to other stories", navigation: "Site navigation or a section front", other: "Anything else that is not an article" } },
  headline: { type: "score", instructions: `Headline framing. ${WRITER}`, criteria: [
    "1: states what happened, neutral verb ('Senate passes bill')",
    "2: states what happened with a mild angle or a slightly warm verb",
    "3: carries a verdict noun, a judging adjective, a catastrophizing phrase, or scare quotes",
    "4: tells the reader how to feel before they read the story, or frames the event as a win or a rout",
    "5: an alarm; the headline IS the argument"] },
  language: { type: "score", instructions: `Language intensity throughout the body, in the outlet's own words. ${WRITER}`, criteria: [
    "1: plain reporting verbs, no modifier doing emotional work",
    "2: occasional warm verb or adjective, nothing sustained",
    "3: recurring loaded modifiers, emotional attribution ('blasted', 'fired back'), violence or war metaphor applied to politics",
    "4: contempt or alarm carried in the narration itself, epithets for one side, absolutist language",
    "5: the prose is an argument; almost every sentence carries a charge"] },
  sourcing: { type: "score", instructions: "Source balance ON A CONTESTED CLAIM. If the piece makes no contested claim (an event report, an announcement, a court filing), it is fully sourced when it attributes what it reports: score 1. Only a piece that had an opposing side available and left it out scores 4 or 5.", criteria: [
    "1: no contested claim, or both sides identified and given comparable space",
    "2: both sides present, one thinner",
    "3: a counterpoint buried at the bottom, or an 80/20 split on a genuinely contested question",
    "4: a contested claim with one side absent, or represented only by a line the piece then rebuts",
    "5: a single side of a contested claim, plus anonymous inflammatory claims"] },
  fallacies: { type: "score", instructions: `How much does the piece's own reasoning depend on logical fallacies (appeal to fear, ad hominem, false dilemma, slippery slope, straw man, whataboutism, cherry-picking, anecdote as evidence)? ${WRITER}`, criteria: [
    "1: no fallacy in the outlet's reasoning", "2: a minor lapse", "3: the argument leans on a fallacy",
    "4: several fallacies stacked", "5: the reasoning is mostly fallacy"] },
  structure: { type: "score", instructions: "Structural manipulation: emotional anecdote ledes, buried context, cliffhanger anxiety, repeated restatement of alarming points.", criteria: [
    "1: inverted pyramid, the lede is the news", "2: mostly straight with one structural choice that steers",
    "3: an anecdote before the facts, or context pushed into the last third", "4: structure built to produce alarm or outrage",
    "5: the whole piece is arranged for effect"] },
  // Political lean (Max, 2026-10-02, audit 3.1 option A). Haiku was told to
  // "stay within ±20" when unsure and put 130 of 342 tellings at exactly 0, with
  // right-baseline outlets averaging +8.7, so the chart's x-axis was dead. Jev
  // judges it on five anchors instead; leanFrom maps the 0-4 answer to -100..+100.
  political_lean: { type: "score", instructions: `Where does the article's FRAMING sit politically? Judge word choice, which facts are emphasized or left out, whose voices lead, and whose side the framing takes. Not the topic: a story about a right-wing policy is not right-leaning because of its subject. ${WRITER}`, criteria: [
    "-100 far left: framed as the left's own activists would frame it; the right is presented as illegitimate or malicious",
    "-50 left: leans left in emphasis, sympathy and whose voices lead, while still reporting",
    "0 centre: the framing favours neither side, as in a neutral wire report",
    "+50 right: leans right in emphasis, sympathy and whose voices lead, while still reporting",
    "+100 far right: framed as the right's own activists would frame it; the left is presented as illegitimate or malicious"] },
  fallacy_count: { type: "choice", instructions: `How many DISTINCT logical fallacies appear in the outlet's own reasoning? ${WRITER}`, criteria: { n0: "None", n1: "One", n2: "Two", n3: "Three or more" } },
  loaded_headline: { type: "noul", instructions: "Does the headline use a loaded verb, catastrophizing, scare quotes, or victory/defeat framing?", criteria: { true: "Loaded headline", false: "Plain headline" } },
  emotional_lede: { type: "noul", instructions: "Does the piece make the reader FEEL something before giving them facts?", criteria: { true: "Emotion before facts", false: "Facts first" } },
  opinion_column: { type: "noul", instructions: "Is this an opinion column, editorial, or review rather than reporting?", criteria: { true: "Opinion", false: "Reporting" } },
  register: { type: "choice", instructions: "Which register is this piece? All politics, world, business, technology, science and health reporting is news.", criteria: {
    news: "News: everything that is not sports, culture, or an explicit feature", sports: "A match report or sports news",
    culture: "A review, arts criticism, or entertainment coverage", feature: "An explicitly framed profile, essay, or long-form human-interest piece" } },
  band: { type: "choice", instructions: `Holistic read: which description does the article match as a whole? ${WRITER}`, criteria: {
    Proportionate: "Wire-service register. Neutral headline verb, the lede is the news, sources given comparable space, no adjective in the outlet's voice tells the reader how to feel",
    Grounded: "Reported straight with a mild tilt: one warm verb, one framing decision, a counterpoint present but thinner. Informs first, steers second",
    "Mixed Signals": "The framing is doing visible work: a loaded headline verb, an anecdote before the facts, one side's characterization in the narration, the counterpoint pushed late",
    "Running Hot": "Manipulation is the dominant mode: catastrophizing or victory-defeat headline, emotional lede, one-sided sourcing, editorializing epithets, stacked fallacies",
    Hyperbolic: "Exists to produce a reaction. The headline is an alarm, the narration carries contempt or panic, opposing evidence absent" } },
};

// The dimension ceiling a "no" flag commits to (invariants.ts NEGATIVE_FLAG_CEILING).
const NO_FLAG_CEILING = 2.0;

export interface JevJudgment {
  dimensions: CompositeDimensions;
  flags: CompositeFlags;
  declaredBand: Label | null;
  contentType: ContentType | null;
  // -100..+100, or null when Jev returned no lean (Haiku's lean is used then).
  politicalLean: number | null;
  inputTokens: number;
}

// Jev's 0-4 score index to the 1.0-5.0 scale, one decimal.
function toScale(a: JevAnswer | undefined): number | null {
  if (typeof a?.score !== "number" || !Number.isFinite(a.score)) return null;
  return Math.max(1, Math.min(5, Math.round((a.score + 1) * 10) / 10));
}
const yes = (a: JevAnswer | undefined) => (a?.noul ?? 0) >= 0.5;

// Jev's 0-4 lean answer (an expected value, so it can fall between anchors) to
// -100..+100: 0 is far left, 2 centre, 4 far right.
export function leanFrom(a: JevAnswer | undefined): number | null {
  if (typeof a?.score !== "number" || !Number.isFinite(a.score)) return null;
  return Math.max(-100, Math.min(100, Math.round((a.score - 2) * 50)));
}

// Sourcing and fallacies are each judged ONCE. The one-sided flag and the
// fallacy count are read off the same answer rather than asked separately: asked
// twice, Jev answered the two halves independently and contradicted itself on
// 19% of LITMUS's feed (sourcing 2.6 beside "no side suppressed"), which the
// coherence gate rightly rejects. The sourcing anchors already define 3+ as a
// buried or absent side, which is exactly what the flag means.
export function deriveFlags(dims: CompositeDimensions, a: Record<string, JevAnswer>): CompositeFlags {
  const askedCount = Number((a.fallacy_count?.choice ?? "n0").slice(1)) || 0;
  const fromScore = dims.fallacies > 4.4 ? 3 : dims.fallacies > 3.4 ? 2 : dims.fallacies > NO_FLAG_CEILING ? 1 : 0;
  const register = (REGISTERS as readonly string[]).includes(a.register?.choice ?? "") ? (a.register!.choice as Register) : "news";
  return {
    emotionalLede: yes(a.emotional_lede),
    loadedHeadline: yes(a.loaded_headline),
    fallacyCount: Math.max(askedCount, fromScore),
    oneSidedSourcing: dims.sourcing > NO_FLAG_CEILING,
    opinionColumn: yes(a.opinion_column),
    register,
  };
}

export async function judgeWithJev(title: string, body: string, bodyIsComplete: boolean): Promise<JevJudgment> {
  const { answers, inputTokens } = await askJev({ title, body_is_complete: bodyIsComplete, body }, JEV_QUESTIONS);
  const d = { headline: toScale(answers.headline), language: toScale(answers.language), sourcing: toScale(answers.sourcing), fallacies: toScale(answers.fallacies), structure: toScale(answers.structure) };
  const missing = Object.entries(d).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) throw new Error(`Jev returned no score for: ${missing.join(", ")}`);
  const dimensions = d as CompositeDimensions;
  const band = answers.band?.choice;
  const ct = answers.content_type?.choice;
  return {
    dimensions,
    flags: deriveFlags(dimensions, answers),
    declaredBand: (LABELS as readonly string[]).includes(band ?? "") ? (band as Label) : null,
    contentType: (CONTENT_TYPES as readonly string[]).includes(ct ?? "") ? (ct as ContentType) : null,
    politicalLean: leanFrom(answers.political_lean),
    inputTokens,
  };
}
