// The shared reading of a StoryDTO: which members count, what each member's
// state is called, how a P/H range is written, and the edition order. Every
// story surface (front, story page, section list) reads the story through
// these, so desktop and mobile cannot disagree about what a story contains.
//
// The contract itself is storyTypes.ts, identical to the server's copy. This
// file holds only the derivations the client needs and the server does not
// send.

import { highlightKind } from "./highlight.ts";
import { bandWord, isValidComposite } from "./phBand.ts";
import type { StoryDTO, StoryMemberDTO, HeatDimension } from "./storyTypes.ts";

export const STORY_PATH_PREFIX = "/story/";

export function storyPath(story: Pick<StoryDTO, "slug">): string {
  return `${STORY_PATH_PREFIX}${encodeURIComponent(story.slug)}`;
}

// Sister feeds ("Axios — Politics & Policy", "NPR — News") are one outlet. The
// server carries that identity as outletKey; the name shown is the part before
// the dash, so two feeds of one outlet never label two dots differently.
export function outletShortName(name: string): string {
  const short = name.split(" — ")[0]?.trim();
  return short && short.length > 0 ? short : name;
}

// ── Member states ───────────────────────────────────────────────────────────
//
// Every member is in exactly one state, and every state has public wording
// (docs/specs/story-analysis-engine-2026-09-13.md section 3.2). None is blank.
export type MemberState =
  // Read, scored, and counted as a telling.
  | "scored"
  // Read but not yet scored: shown as a row, neither plotted nor hollow.
  | "pending"
  // LITMUS could not read enough to assess it: a hollow dot and a headline link.
  | "headline_only"
  // A wire copy of another member: shown, never counted as an independent telling.
  | "syndicated"
  // A roundup: listed under the story, never counted as a telling.
  | "secondary"
  // An outlet's second or later filing on the story: listed, never counted, so
  // each outlet is one telling (server dedupePrimaries.ts).
  | "also_filed";

export function memberState(m: StoryMemberDTO): MemberState {
  if (m.role === "secondary") return m.alsoFiled ? "also_filed" : "secondary";
  if (m.kind === "headline_only") return "headline_only";
  if (m.kind === "syndicated") return "syndicated";
  return isValidComposite(m.composite) ? "scored" : "pending";
}

// The wording the spec fixes for each state. "cannot read", never "blocked"
// (aggregator audit section 3, thin and paywalled coverage).
export function memberStateText(state: MemberState, originName: string | null = null): string | null {
  switch (state) {
    case "scored":
      return null;
    case "pending":
      return "Analysis pending";
    case "headline_only":
      return "Headline only, not scored";
    case "syndicated":
      return originName ? `Carries ${originName}'s copy` : "Carries another outlet's copy";
    case "secondary":
      return "Roundup, listed but not counted as a telling";
    case "also_filed":
      return "Also filed";
  }
}

// The member a syndicated copy was copied from, when it is in the story.
export function originNameFor(story: Pick<StoryDTO, "members">, m: StoryMemberDTO): string | null {
  if (m.syndicatedOfArticleId === null) return null;
  const origin = story.members.find((o) => o.articleId === m.syndicatedOfArticleId);
  return origin ? origin.outletName : null;
}

// A telling is a primary member LITMUS read in full. Only tellings carry
// findings and only tellings are compared with one another.
export function isTelling(m: StoryMemberDTO): boolean {
  return m.role === "primary" && m.kind === "full";
}

export function isScored(m: StoryMemberDTO): boolean {
  return isValidComposite(m.composite);
}

// The members the matrix can place: primary, scored, and with a lean reading.
// Syndicated copies are plotted (the copy ran under that outlet's name) but
// labelled as copies; roundups are not, because a roundup is not a telling of
// this story.
export function plottedMembers(story: Pick<StoryDTO, "members">): StoryMemberDTO[] {
  return story.members.filter(
    (m) => m.role === "primary" && m.kind !== "headline_only" && isScored(m) && typeof m.politicalLean === "number" && Number.isFinite(m.politicalLean),
  );
}

// The hollow lane: primary members LITMUS could not read.
export function hollowMembers(story: Pick<StoryDTO, "members">): StoryMemberDTO[] {
  return story.members.filter((m) => m.role === "primary" && m.kind === "headline_only");
}

// Read but not yet scored, so neither plotted nor hollow. The caption names
// them so a reader never infers an analysis that has not happened.
export function pendingMembers(story: Pick<StoryDTO, "members">): StoryMemberDTO[] {
  return story.members.filter((m) => memberState(m) === "pending");
}

// ── Score wording ───────────────────────────────────────────────────────────
//
// The number and the band word always travel together (brand.md section 2).

export function scoreText(composite: unknown): string {
  if (!isValidComposite(composite)) return bandWord(composite);
  return `${composite.toFixed(1)} ${bandWord(composite)}`;
}

// "1.5 Grounded to 2.4 Grounded", or one score when the range is a point, or
// an honest "Not yet scored" when nothing in the story has a number.
export function phRangeText(min: number | null, max: number | null): string {
  if (!isValidComposite(min) || !isValidComposite(max)) return "Not yet scored";
  if (min === max) return scoreText(min);
  return `${scoreText(min)} to ${scoreText(max)}`;
}

// The two counts a story always shows, so "12 outlets covered this" is never
// read as "12 analysed" (aggregator audit section 3). The second count names
// its noun because it can exceed the first: two Axios feeds are one outlet
// but two reports, and both get analysed.
export function coverageLine(story: Pick<StoryDTO, "outletCount" | "members">): string {
  const analysed = story.members.filter((m) => isTelling(m) && isScored(m)).length;
  const outlets = story.outletCount;
  return `${outlets} outlet${outlets === 1 ? "" : "s"} covered this · ${analysed} report${analysed === 1 ? "" : "s"} analysed`;
}

// Every matrix caption states the read status, so the hollow-dot check is
// visible even when no dot is hollow (brand.md section 5).
export function readStatusCaption(story: Pick<StoryDTO, "members">): string {
  // Headline-only reports are left out of the site entirely (Max, 2026-09-26:
  // "we don't score just headlines"), so the caption counts only reports
  // LITMUS reads in full.
  const read = story.members.filter((m) => m.role === "primary" && m.kind !== "headline_only");
  const pending = pendingMembers(story).length;
  return pending > 0 ? `${read.length - pending} of ${read.length} scored so far` : `All ${read.length} scored`;
}

// ── Edition order ───────────────────────────────────────────────────────────
//
// Multi-outlet stories first, newest report first; single-outlet stories after
// (ruling 3: single-outlet stories publish lower, labelled as such). The
// order is total, so two builds of the same input agree. Pure: never mutates
// its input.

export function editionDay(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString().slice(0, 10);
}

export function phSpread(story: Pick<StoryDTO, "phMin" | "phMax">): number {
  if (!isValidComposite(story.phMin) || !isValidComposite(story.phMax)) return 0;
  return story.phMax - story.phMin;
}

// How much a story has to show: the day it was last touched, then the spread
// of its tellings. This was the page order until 2026-10-05; it now only picks
// which stories the drip releases first, so the morning opens on the widest.
export function compareByProminence(a: StoryDTO, b: StoryDTO): number {
  if (a.singleOutlet !== b.singleOutlet) return a.singleOutlet ? 1 : -1;
  const dayA = editionDay(a.updatedAt);
  const dayB = editionDay(b.updatedAt);
  if (dayA !== dayB) return dayA < dayB ? 1 : -1;
  const spread = phSpread(b) - phSpread(a);
  if (spread !== 0) return spread;
  if (a.outletCount !== b.outletCount) return b.outletCount - a.outletCount;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// When the story last moved: its newest report's publication time. A feed
// date later than the run that read it is a bad date, so the run time caps it;
// a story with no dated report falls back to when LITMUS first saw it.
export function storyTimeMs(story: Pick<StoryDTO, "members" | "firstSeenAt" | "updatedAt">): number {
  const cap = Date.parse(story.updatedAt);
  const times = story.members
    .map((m) => (m.publishedAt ? Date.parse(m.publishedAt) : NaN))
    .filter((t) => Number.isFinite(t) && (!Number.isFinite(cap) || t <= cap));
  if (times.length > 0) return Math.max(...times);
  const seen = Date.parse(story.firstSeenAt);
  return Number.isFinite(seen) ? seen : 0;
}

// What the instrument has to show on a story: a telling that ran hot, or
// tellings a point or more apart. A story with neither is coverage that ran
// calm and agreed with itself; still news, but not the front of the paper.
export const HEAT_THRESHOLD = 3;
export const SPREAD_THRESHOLD = 1;

export function hasSomethingToShow(story: Pick<StoryDTO, "members" | "phMin" | "phMax">): boolean {
  const hottest = hottestTelling(story);
  if (hottest && (hottest.composite as number) >= HEAT_THRESHOLD) return true;
  return phSpread(story) >= SPREAD_THRESHOLD;
}

// Every scored telling stayed under Running Hot: the card says the coverage
// ran grounded throughout instead of showing an empty "Most hyperbolic" slot
// (Max, 2026-10-06: "several of the top stories have no hyperbolic line").
export function coverageRanCalm(story: Pick<StoryDTO, "members">): boolean {
  const hottest = hottestTelling(story);
  return hottest !== null && (hottest.composite as number) < HEAT_THRESHOLD;
}

// ── What set the number (Max, 2026-10-06) ───────────────────────────────────
//
// A hot telling with no loaded span rated 3 or more used to read "No loaded
// line in the hottest telling": the card searching the body for heat the judge
// found elsewhere. The composite is five Jev dimensions, headline and language
// weighted double, with a floor that puts a loaded headline together with an
// emotional lede at 3.5 whatever the body says; 12 of the 25 such tellings on
// the 2026-10-06 edition sat exactly on that floor. So the slot shows the
// driver with its own evidence: the headline quoted, the lede quoted when the
// excerpt opens with it, or a plain statement when the heat is an absence
// (one side missing) or diffuse (language with no one phrase). Nothing here
// is written by a model at render time; the words are the judge's record.
export interface HotDriverEvidence {
  label: string;
  quote: string | null;
  statement: string;
  why: string | null;
}

const FALLACY_CATEGORY = "logical_fallacy";

export function hotDriverEvidence(member: StoryMemberDTO): HotDriverEvidence | null {
  const heat = member.heat;
  if (!heat || !isScored(member)) return null;
  const level = (d: HeatDimension) => `${heat.dimensions[d]} of 5`;
  const noteFor = (d: HeatDimension) => (heat.driver === d ? heat.note : null);
  if (heat.loadedHeadline || heat.driver === "headline") {
    return {
      label: "Hot headline",
      quote: member.title.trim() || null,
      statement: heat.loadedHeadline
        ? `Rated loaded: a verdict, scare quotes, or a win-or-loss frame before the story starts. Headline ${level("headline")}.`
        : `The headline set the number. Headline ${level("headline")}.`,
      why: noteFor("headline"),
    };
  }
  if (heat.emotionalLede || heat.driver === "structure") {
    return {
      label: "Emotion before facts",
      quote: heat.lede,
      statement: heat.emotionalLede
        ? `The piece opens on a feeling before it gives a fact. Structure ${level("structure")}.`
        : `The structure set the number: an anecdote before the facts, or context pushed to the end. Structure ${level("structure")}.`,
      why: noteFor("structure"),
    };
  }
  if (heat.driver === "sourcing") {
    return {
      label: heat.oneSidedSourcing ? "One side absent" : "Thin sourcing",
      quote: null,
      statement: heat.oneSidedSourcing
        ? `A contested claim with one side absent, or present only to be rebutted. Sourcing ${level("sourcing")}.`
        : `A counterpoint buried or thin on a contested claim. Sourcing ${level("sourcing")}.`,
      why: noteFor("sourcing"),
    };
  }
  if (heat.driver === "fallacies") {
    const marked = (member.excerpt?.markers ?? [])
      .filter((m) => m.category === FALLACY_CATEGORY)
      .sort((a, b) => b.intensity - a.intensity)[0];
    const count = heat.fallacyCount;
    return {
      label: "Reasoning",
      quote: marked?.text ?? null,
      statement: `${count > 0 ? `${count} fallac${count === 1 ? "y" : "ies"} in the outlet's own reasoning` : "The reasoning leans on a fallacy"}. Reasoning ${level("fallacies")}.`,
      why: noteFor("fallacies"),
    };
  }
  return {
    label: "Hot language",
    quote: null,
    statement: `Running hot in the outlet's own words, but no single phrase carries it. Language ${level("language")}.`,
    why: noteFor("language"),
  };
}

// The page order: newest first (Max, 2026-10-05: "order them chronologically,
// not from the most hyperbolic down"; the same stories sat at the top all day
// and the page felt static). Single-outlet stories still publish lower
// (ruling 3). Ties break on outlet count, then id, so the order is total.
//
// Two tiers since 2026-10-06 (Max, "do both"): stories with something to show
// (hasSomethingToShow) lead, the calm ones follow, newest first inside each
// tier. Chronological order alone had put calm two-outlet pairs at the top
// because they happened to be newest, each with an empty hyperbolic slot. The
// tiers refill every morning, so the page still moves.
export function compareStories(a: StoryDTO, b: StoryDTO): number {
  if (a.singleOutlet !== b.singleOutlet) return a.singleOutlet ? 1 : -1;
  const showA = hasSomethingToShow(a);
  const showB = hasSomethingToShow(b);
  if (showA !== showB) return showA ? -1 : 1;
  const time = storyTimeMs(b) - storyTimeMs(a);
  if (time !== 0) return time;
  if (a.outletCount !== b.outletCount) return b.outletCount - a.outletCount;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function orderStories(stories: readonly StoryDTO[]): StoryDTO[] {
  return [...stories].sort(compareStories);
}

// The Story Ledger runs once a day (5:15 AM Pacific), so every story it finds
// exists the instant the edition is built - there is no real "throughout the
// day" to reflect. This simulates one anyway (Max, 2026-09-19): readers see a
// solid base of stories from publish, then the rest of the "vetted, sufficient
// sources" stories become visible one at a time, purely by filtering what the
// snapshot already contains against the reader's own clock. No extra model
// call, no extra run - the data for the whole day is already here, only WHEN
// it appears differs. Single-outlet stories are not "sufficient sources" for
// this and are never part of the drip: they show immediately.
//
// Spread evenly across REVEAL_WINDOW_MS (Max, 2026-09-22: "run once a day then
// drip out stories the rest of the day"). The old fixed one-per-hour pace
// finished by mid-morning on a thin day and ran past the next edition on a
// busy one; an even spread lands the last story near the end of the day
// either way, and well before the next morning's edition replaces it.
const REVEAL_BASE_COUNT = 6;
export const REVEAL_WINDOW_MS = 16 * 60 * 60 * 1000;

// 5:00 AM Pacific on the Pacific calendar day of `ms`: when the one daily
// edition is due on the page (Max, 2026-10-05; the run starts at 4:15, see
// ops/edition-clock). Uses the Pacific offset of that moment, so daylight
// saving is handled.
export const EDITION_DAY_START = { hour: 5, minute: 0 };
export function editionDayStartMs(ms: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const offsetMs = asUtc - Math.floor(ms / 1000) * 1000;
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, EDITION_DAY_START.hour, EDITION_DAY_START.minute) - offsetMs;
}

export function scheduleStoryReveal(
  stories: readonly StoryDTO[],
  buildCompletedAt: string,
  now: Date = new Date(),
): StoryDTO[] {
  const ordered = [...stories].sort(compareByProminence);
  const parsedMs = Date.parse(buildCompletedAt);
  // No valid build time is a data problem, not a reason to withhold content
  // the snapshot actually has - show everything rather than hide it.
  if (!Number.isFinite(parsedMs)) return orderStories(stories);
  // The drip runs from the day's scheduled start, not the build time
  // (2026-09-27): a rebuild at noon restarted it and showed 6 stories.
  const builtMs = Math.min(parsedMs, editionDayStartMs(parsedMs));

  const nowMs = now.getTime();
  const qualified = ordered.filter((s) => !s.singleOutlet);
  const thin = ordered.filter((s) => s.singleOutlet);
  const dripCount = Math.max(qualified.length - REVEAL_BASE_COUNT, 0);
  const intervalMs = dripCount > 0 ? REVEAL_WINDOW_MS / dripCount : 0;
  const revealedQualified = qualified.filter((_story, i) => {
    if (i < REVEAL_BASE_COUNT) return true;
    const revealAt = builtMs + (i - REVEAL_BASE_COUNT + 1) * intervalMs;
    return nowMs >= revealAt;
  });

  return orderStories([...revealedQualified, ...thin]);
}

// ── The compact wire item (Max, 2026-09-26) ─────────────────────────────────
//
// The front page is one scroll of compact items: strip, headline, one lede,
// one line on how hot the coverage ran. Everything else is on the story page.

// The lede under the headline: the assessment's first paragraph when there is
// one, otherwise the ledger's one-sentence event statement, so an item is never
// just "Assessment pending".
export function wireLede(story: Pick<StoryDTO, "assessment" | "eventStatement">): string | null {
  const first = story.assessment?.text.split("\n\n")[0]?.trim();
  if (first) return first;
  const statement = story.eventStatement.trim();
  return statement.length > 0 ? statement : null;
}

// "14 outlets · Townhall ran hottest, Breitbart calmest". Only scored tellings
// are compared, and it says so when there are too few to compare.
export function wireCoverageLine(story: Pick<StoryDTO, "outletCount" | "members">): string {
  // Outlets LITMUS reads in full; headline-only reports are not counted.
  const count = new Set(story.members.filter((m) => m.role === "primary" && m.kind !== "headline_only").map((m) => m.outletKey)).size;
  const outlets = `${count} outlet${count === 1 ? "" : "s"}`;
  const scored = story.members.filter((m) => isTelling(m) && isScored(m));
  if (scored.length === 0) return `${outlets} · none scored yet`;
  // The same two tellings the Calmest and Hottest blocks show.
  const hottest = hottestTelling(story)!;
  const calmest = calmestTelling(story)!;
  const hotName = outletShortName(hottest.outletName);
  const calmName = outletShortName(calmest.outletName);
  if (scored.length === 1 || hotName === calmName || hottest.composite === calmest.composite) {
    return `${outlets} · ${scored.length === 1 ? "1 scored so far" : `${scored.length} scored, all ${scoreText(hottest.composite)}`}`;
  }
  return `${outlets} · ${hotName} ran hottest, ${calmName} calmest`;
}

// ── The full front-page item (Max, 2026-09-26, same day as the compact item) ─
//
// Under the AI summary: the strongest practical line and the most hysterical
// line in the coverage, each with its outlet; then the tellings' own excerpts,
// highlighted, each with why it scored the way it did. Every line quoted here
// is a marker span inside an excerpt the server already capped at the legal
// maximum (200 words or 25% of the article, the excerpt policy), so nothing
// here can show more than the excerpts do.

export interface ExtremeLine {
  text: string;
  member: StoryMemberDTO;
  // The whole sentence the span sits in, from the published excerpt, so a
  // one-word mark ("self-appointed") is read in context. Equal to text when
  // the sentence cannot be found.
  sentence: string;
  // Why the span was marked: the scorer's own reason when it gave one, or what
  // the category means.
  why: string;
}

type ExcerptMarker = NonNullable<StoryMemberDTO["excerpt"]>["markers"][number];

function scoredTellings(story: Pick<StoryDTO, "members">): StoryMemberDTO[] {
  return story.members.filter((m) => isTelling(m) && isScored(m) && m.excerpt !== null);
}

// What each category means, for a mark stored before the scorer gave reasons
// (2026-10-02). Worded as what the category means, never as a claim about this
// particular line, because no one judged this line beyond its category.
const CATEGORY_REASON: Record<string, string> = {
  loaded_terms: "Marked as a loaded term: a word that carries its own judgment.",
  emotional_language: "Marked as emotional wording: it reaches for a feeling.",
  language_intensity: "Marked as heightened wording: stronger than the facts require.",
  headline_framing: "Marked as framing: it steers how the facts are read.",
  logical_fallacy: "Marked as a leap in reasoning.",
  structural_manipulation: "Marked for placement that steers the reader.",
  speculation: "Marked as speculation.",
  grounded: "Marked as grounded: a specific, checkable fact or named source.",
  hedging: "Marked as careful attribution: it says who claims this.",
};

export function markerReason(marker: Pick<ExcerptMarker, "category"> & { why?: string }): string {
  const own = marker.why?.trim();
  if (own) return own;
  return CATEGORY_REASON[marker.category] ?? "Marked by the scorer.";
}

const SENTENCE_MAX_WORDS = 40;
const SENTENCE_SIDE_WORDS = 15;

// The sentence of the excerpt that contains `span`. A sentence ends at . ! or ?
// followed by a space and a capital or an opening quote. A very long sentence
// is cut to about fifteen words either side of the span, marked with ellipses,
// so the context never outgrows the line it explains.
export function sentenceAround(paragraphs: readonly string[], span: string): string {
  const para = paragraphs.find((p) => p.includes(span));
  if (!para) return span;
  const at = para.indexOf(span);
  const ends = [...para.matchAll(/[.!?]["”’)]?\s+(?=["“‘(]?[A-Z0-9])/g)].map((m) => m.index! + m[0].length);
  const start = Math.max(0, ...ends.filter((e) => e <= at));
  const nextEnd = ends.find((e) => e >= at + span.length);
  const sentence = para.slice(start, nextEnd ?? para.length).trim();
  if (wordCount(sentence) <= SENTENCE_MAX_WORDS) return sentence;
  const local = sentence.indexOf(span);
  const before = sentence.slice(0, local).split(/\s+/).filter(Boolean);
  const after = sentence.slice(local + span.length).split(/\s+/).filter(Boolean);
  const head = before.slice(-SENTENCE_SIDE_WORDS).join(" ");
  const tail = after.slice(0, SENTENCE_SIDE_WORDS).join(" ");
  return `${before.length > SENTENCE_SIDE_WORDS ? "… " : ""}${head}${head ? " " : ""}${span}${tail && !/^[,.;:!?]/.test(tail) ? " " : ""}${tail}${after.length > SENTENCE_SIDE_WORDS ? " …" : ""}`.trim();
}

function extreme(marker: ExcerptMarker & { why?: string }, member: StoryMemberDTO): ExtremeLine {
  return { text: marker.text, member, sentence: sentenceAround(member.excerpt!.paragraphs, marker.text), why: markerReason(marker) };
}

// The most hysterical line comes from the HOTTEST scored telling only, the one
// the card names as having "ran hottest" (audit 2026-10-02, section 3.2): the
// Hormuz card said The American Conservative ran hottest at 3.5, then quoted
// "terrorist hijacking" from a 1.5 Grounded piece. Within that telling, its
// most intense loaded span, rated 3 or more; ties go to the longer span. When
// the hottest telling has no such span, there is no line, and the card says so
// rather than headlining a mild sentence (the cartel card quoted "The exact
// size and duration of the unit deployment remain undisclosed").
export const MIN_HYSTERICAL_INTENSITY = 3;

// A tie on the score is settled by the marks already shown on the card (Max,
// 2026-10-10, after a card's summary said "Daily Wire calmest" over a block
// that showed BBC News: three tellings at 1.6, and the two places broke the
// tie in opposite directions, in 24 of 344 stories). Among tellings with the
// same score the calmer is the one with fewer loaded marks, then more
// grounded ones; then member order. hottestTelling, calmestTelling and
// wireCoverageLine all use this, so the summary and the blocks always name the
// same outlet.
function markCounts(member: StoryMemberDTO): { loaded: number; grounded: number } {
  const marks = member.excerpt?.markers ?? [];
  return {
    loaded: marks.filter((m) => highlightKind(m.category) === "loaded").length,
    grounded: marks.filter((m) => m.category === "grounded").length,
  };
}

// Negative when a is the calmer telling.
function calmerFirst(a: StoryMemberDTO, b: StoryMemberDTO): number {
  const byScore = (a.composite as number) - (b.composite as number);
  if (byScore !== 0) return byScore;
  const ma = markCounts(a), mb = markCounts(b);
  return ma.loaded - mb.loaded || mb.grounded - ma.grounded;
}

// The highest composite among scored tellings; ties as above.
export function hottestTelling(story: Pick<StoryDTO, "members">): StoryMemberDTO | null {
  const scored = story.members.filter((m) => isTelling(m) && isScored(m));
  if (scored.length === 0) return null;
  return scored.reduce((hot, m) => (calmerFirst(m, hot) > 0 ? m : hot));
}

export function mostHystericalLine(story: Pick<StoryDTO, "members">): ExtremeLine | null {
  const hottest = hottestTelling(story);
  if (!hottest?.excerpt) return null;
  const best = hottest.excerpt!.markers
    .filter((marker) => highlightKind(marker.category) === "loaded" && marker.intensity >= MIN_HYSTERICAL_INTENSITY)
    .sort((a, b) => b.intensity - a.intensity || wordCount(b.text) - wordCount(a.text))[0];
  return best ? extreme(best, hottest) : null;
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
const MIN_PRACTICAL_WORDS = 3;
// A loaded mark the scorer rated 1 of 5 is not drawn (the server drops it too,
// markerGuards.ts); kept here so a snapshot built before that guard agrees.
export const MIN_LOADED_INTENSITY = 2;
const MIN_PRACTICAL_INTENSITY = 2;

// The strongest practical line: a GROUNDED phrase (a checkable fact or named
// source), never a hedge. "Trump has said in social media posts" is careful
// attribution, not the coverage's most practical line, and it was shown as one
// (2026-10-02). From the calmest telling that has one; within it, the most
// intense, then the fullest. A phrase of three words or more wins over a bare
// date or number whenever the coverage has one, and a mark the scorer rated 1
// is not strong enough to headline.
export function mostPracticalLine(story: Pick<StoryDTO, "members">): ExtremeLine | null {
  const candidates = scoredTellings(story).flatMap((member) =>
    member.excerpt!.markers
      .filter((marker) => marker.category === "grounded" && marker.intensity >= MIN_PRACTICAL_INTENSITY)
      .map((marker) => ({ marker, member, words: wordCount(marker.text) })),
  );
  const pool = candidates.some((c) => c.words >= MIN_PRACTICAL_WORDS)
    ? candidates.filter((c) => c.words >= MIN_PRACTICAL_WORDS)
    : candidates;
  const best = [...pool].sort((a, b) =>
    (a.member.composite as number) - (b.member.composite as number)
    || b.marker.intensity - a.marker.intensity
    || b.words - a.words,
  )[0];
  return best ? extreme(best.marker, best.member) : null;
}

// ── The calmest and the hottest telling (Max, 2026-10-08) ───────────────────
//
// "how does a story with so many sources only have a hot headline and no
// hottest telling read? I want every story to have the summary, calmest
// telling, hottest telling, matrix, then show the x tellings button." The two
// slots above were picked by line, not by telling: the proportionate line
// could come from an outlet that was not the calmest (Fort Hood quoted
// American Greatness while BBC sat at 1.3), and a hot telling with no span
// rated 3 showed only its headline (Foreign Policy at 3.1 on the 8-outlet
// diesel story, whose body carried "robbing Peter to pay Paul" at 2). Each
// block now belongs to one outlet, the one the coverage line names, and always
// carries something of that telling to read: its own strongest line of the
// matching kind, or, when it has none, the opening of its excerpt. A line is
// shown under the outlet's name with the scorer's reason, never as the
// coverage's "most hyperbolic", so a 2-of-5 line is not overclaimed.
export interface TellingRead {
  member: StoryMemberDTO;
  line: ExtremeLine | null;
  // The excerpt's first sentences, when the telling has no line to quote.
  opening: string | null;
}

export const OPENING_WORDS = 45;

// The calmest scored telling: the lowest composite; ties as in hottestTelling.
export function calmestTelling(story: Pick<StoryDTO, "members">): StoryMemberDTO | null {
  const scored = story.members.filter((m) => isTelling(m) && isScored(m));
  if (scored.length === 0) return null;
  return scored.reduce((calm, m) => (calmerFirst(m, calm) < 0 ? m : calm));
}

// The telling's own strongest line of one kind: a grounded phrase for the
// calmest (three words or more when it has one), a loaded span for the hottest
// at the drawing floor (2), most intense first, then the fullest.
export function tellingLine(member: StoryMemberDTO, kind: "grounded" | "loaded"): ExtremeLine | null {
  if (!member.excerpt) return null;
  const marks = member.excerpt.markers.filter((marker) =>
    kind === "grounded"
      ? marker.category === "grounded" && marker.intensity >= MIN_PRACTICAL_INTENSITY
      : highlightKind(marker.category) === "loaded" && marker.intensity >= MIN_LOADED_INTENSITY,
  );
  const pool = kind === "grounded" && marks.some((m) => wordCount(m.text) >= MIN_PRACTICAL_WORDS)
    ? marks.filter((m) => wordCount(m.text) >= MIN_PRACTICAL_WORDS)
    : marks;
  const best = [...pool].sort((a, b) => b.intensity - a.intensity || wordCount(b.text) - wordCount(a.text))[0];
  return best ? extreme(best, member) : null;
}

// The first whole sentences of the excerpt, up to about OPENING_WORDS; a first
// sentence longer than that is cut at a word with an ellipsis.
export function excerptOpening(member: StoryMemberDTO): string | null {
  const para = member.excerpt?.paragraphs.find((p) => p.trim());
  if (!para) return null;
  const ends = [...para.matchAll(/[.!?]["”’)]?\s+(?=["“‘(]?[A-Z0-9])/g)].map((m) => m.index! + m[0].length);
  let cut = 0;
  for (const end of [...ends, para.length]) {
    if (cut > 0 && wordCount(para.slice(0, end)) > OPENING_WORDS) break;
    cut = end;
  }
  const opening = para.slice(0, cut).trim();
  if (wordCount(opening) <= OPENING_WORDS) return opening;
  return `${opening.split(/\s+/).slice(0, OPENING_WORDS).join(" ")} …`;
}

function tellingRead(member: StoryMemberDTO, kind: "grounded" | "loaded"): TellingRead {
  const line = tellingLine(member, kind);
  return { member, line, opening: line ? null : excerptOpening(member) };
}

// Both blocks, or only the calmest when a single telling is scored (the
// calmest and the hottest are then the same member).
export function calmAndHot(story: Pick<StoryDTO, "members">): { calm: TellingRead | null; hot: TellingRead | null } {
  const calm = calmestTelling(story);
  const hot = hottestTelling(story);
  if (!calm || !hot) return { calm: null, hot: null };
  if (calm === hot) return { calm: tellingRead(calm, "grounded"), hot: null };
  return { calm: tellingRead(calm, "grounded"), hot: tellingRead(hot, "loaded") };
}

function excerptWords(member: StoryMemberDTO): number {
  return (member.excerpt?.paragraphs ?? []).join(" ").split(/\s+/).filter(Boolean).length;
}

export const FRONT_EXCERPT_WORDS = 500;

// Which tellings' excerpts the item shows: the calmest and the hottest, then
// the one nearest the middle while the total is under about 500 words. Each
// excerpt is shown whole; the server's cap is the per-article limit.
export function frontExcerpts(story: Pick<StoryDTO, "members">): StoryMemberDTO[] {
  // Same order as calmestTelling and hottestTelling, ties included.
  const byScore = scoredTellings(story).sort(calmerFirst);
  if (byScore.length === 0) return [];
  const chosen = [byScore[0]!];
  if (byScore.length > 1) chosen.push(byScore[byScore.length - 1]!);
  const middle = byScore.slice(1, -1);
  if (middle.length > 0 && chosen.reduce((sum, m) => sum + excerptWords(m), 0) < FRONT_EXCERPT_WORDS) {
    const mid = (chosen[0]!.composite as number + (chosen[1]!.composite as number)) / 2;
    middle.sort((a, b) => Math.abs((a.composite as number) - mid) - Math.abs((b.composite as number) - mid));
    chosen.splice(1, 0, middle[0]!);
  }
  return chosen;
}

// A story with no scored report has no strip, no quotes and nothing to plot,
// so it waits off the page until one is scored (Max, 2026-10-05). Since
// 2026-10-07 it waits until two outlets are scored (Max: "do it"): LITMUS
// compares tellings, and on the 10-07 edition 26 of 51 cards showed one graded
// outlet beside others the member-scoring cap had not reached.
export const MIN_SCORED_OUTLETS = 2;

export function withScoredReport(stories: readonly StoryDTO[]): StoryDTO[] {
  return stories.filter((s) => {
    const scoredOutlets = new Set(
      s.members.filter((m) => m.role === "primary" && m.kind !== "headline_only" && isScored(m)).map((m) => m.outletKey),
    );
    return scoredOutlets.size >= MIN_SCORED_OUTLETS;
  });
}

// The front page's scope (Max, 2026-09-26): what Political Wire covers,
// politics plus economy, national and world stories that touch politics. Only
// stories the assessment judged in scope are shown; unjudged ones wait for
// the next run. An edition built before the check existed carries no verdict
// on any story, and then everything shows rather than an empty page.
export function inPoliticalScope(stories: readonly StoryDTO[]): StoryDTO[] {
  const judged = stories.some((s) => typeof s.touchesPolitics === "boolean");
  if (!judged) return [...stories];
  return stories.filter((s) => s.touchesPolitics === true);
}

// Today's paper (Max, 2026-10-06). The ledger keeps a story open for seven
// days without a new report, and the edition served every open story, so on
// 2026-10-02 77 of the 108 front-page stories had no report in the last day:
// a week of stories on a page that reads as one morning's. The front page now
// carries only stories with a report inside this window, measured from when
// the edition was built, never from the reader's clock, so the paper does not
// shrink through the day. 36 hours: a 5 AM edition covers yesterday afternoon
// and evening, and a run that starts hours late still keeps the day's own
// stories. Story pages look a story up in the full list (api.ts fetchStory),
// so a shared link to an older story still opens.
export const TODAYS_PAPER_HOURS = 36;

export function inTodaysPaper(stories: readonly StoryDTO[], buildCompletedAt: string): StoryDTO[] {
  const builtMs = Date.parse(buildCompletedAt);
  // No valid build time is a data problem, not a reason to hide the edition.
  if (!Number.isFinite(builtMs)) return [...stories];
  const cutoff = builtMs - TODAYS_PAPER_HOURS * 60 * 60 * 1000;
  return stories.filter((s) => storyTimeMs(s) >= cutoff);
}

// Evidence under every outlet (Max, 2026-09-26: "under each outlet evidence of
// why we rated their article the way we did"; paraphrase and split quotes are
// fine). The quotes are the scorer's own marked spans, which the server keeps
// inside the article's published excerpt window, so splitting them never shows
// more of an article than the excerpt does. A hot telling leads with its
// loaded wording, a calm one with its grounded wording.
export const EVIDENCE_QUOTES_PER_OUTLET = 4;

export interface EvidenceQuote {
  text: string;
  kind: "loaded" | "grounded";
}

export function evidenceQuotes(member: StoryMemberDTO, limit = EVIDENCE_QUOTES_PER_OUTLET): EvidenceQuote[] {
  if (!isScored(member) || !member.excerpt) return [];
  const hot = (member.composite as number) >= 3;
  const seen = new Set<string>();
  const quotes = member.excerpt.markers
    .map((marker) => ({ text: marker.text.trim(), kind: highlightKind(marker.category), intensity: marker.intensity }))
    .filter((q): q is { text: string; kind: "loaded" | "grounded"; intensity: number } => q.kind !== null && q.text.length > 0)
    .filter((q) => q.kind !== "loaded" || q.intensity >= MIN_LOADED_INTENSITY)
    // A bare date or number ("Friday", "2022") is not evidence of grounded
    // writing; a grounded quote must be a phrase. Loaded wording can be one word.
    .filter((q) => q.kind === "loaded" || wordCount(q.text) >= MIN_PRACTICAL_WORDS)
    .filter((q) => (seen.has(q.text.toLowerCase()) ? false : (seen.add(q.text.toLowerCase()), true)))
    .sort((a, b) => {
      const lead = hot ? "loaded" : "grounded";
      if (a.kind !== b.kind) return a.kind === lead ? -1 : 1;
      return b.intensity - a.intensity || wordCount(b.text) - wordCount(a.text);
    });
  return quotes.slice(0, limit).map(({ text, kind }) => ({ text, kind }));
}

// Every member the story lists, calmest scored first, then the ones LITMUS
// has not scored (they still get a row that says so).
// How many tellings the card's expand control opens: one row per outlet.
export function tellingCount(story: Pick<StoryDTO, "members">): number {
  return outletRows(story).length;
}

export function outletRows(story: Pick<StoryDTO, "members">): StoryMemberDTO[] {
  const primary = story.members.filter((m) => m.role === "primary" && m.kind !== "headline_only");
  const scored = primary.filter(isScored).sort((a, b) => (a.composite as number) - (b.composite as number));
  const rest = primary.filter((m) => !isScored(m));
  return [...scored, ...rest];
}
