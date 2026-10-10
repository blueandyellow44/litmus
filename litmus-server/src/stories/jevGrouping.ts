// Jev makes the Story Ledger's same-event decisions (Max, 2026-10-02: "use
// haiku and jev, not sonnet", then "Story ledger grouping too"). Jev answers
// typed questions and writes no text, so the split is:
//   - Jev decides: does this article belong to that existing story (assignment
//     pre-pass and the exhaustive sweep), and are these two stories one event
//     (merge review).
//   - Haiku still writes: a new story's headline and event statement, and the
//     split review's partition, which needs groups named rather than picked.
// Every function here falls back rather than guesses: an article Jev is not
// confident about goes to Haiku exactly as it did before, and a failed Jev
// call reads as "not decided", never as "not the same event".
import { askJev, JEV_MODEL, type JevAnswer, type JevQuestion } from "../lib/jev.js";
import { logger } from "../lib/logger.js";
import { pool } from "../db/client.js";
import type { ModelUsage, StoryDecision } from "./assignment.js";
import type { MergeReview } from "./critic.js";
import { SAME_EVENT_RULE } from "./prompts.js";
import type { StoryArticle, StoryCard } from "./retrieval.js";
import type { SweepCheck, SweepDecision, SweepOptions, SweepResult } from "./sweep.js";

// A match is acted on only at this probability or above; below it, the
// decision goes back to Haiku (assignment) or stands as "no match" (sweep).
export const MATCH_AT = 0.8;
// Merge review: yes at or above MATCH_AT, no at or below this, unsure between.
export const NO_MERGE_AT = 0.2;
// Jev is asked about several articles per call over one shared list of cards,
// the same economy that cut the Haiku sweep's tokens (sweep.ts, 2026-09-26).
export const ARTICLES_PER_CALL = 8;
export const CARDS_PER_SHARD = 50;
// What production asks (2026-10-02 side-by-side, src/workers/evalJevGrouping.ts):
// the sharp question, the moment-or-reaction check on every pick, and one
// article per call, the only setting that gave the same answers twice.
export const PRODUCTION_PROMPT = { style: "sharp", verify: "moment", perCall: 1 } as const;

// Three guards from the last wrong joins of the 2026-10-02 side-by-side (Max:
// "make the last three fixes"), each enforced in code, not left to Jev:
// 1. Too little to judge: "The Sen. Collins Firewall" reached the ledger as
//    three words ("Choose wisely, Maine.") and no summary. Jev does not decide
//    an article with no summary and fewer than MIN_EVIDENCE_WORDS of text.
export const MIN_EVIDENCE_WORDS = 40;
// 2. The window: a story is one moment plus "hours to a few days"
//    (SAME_EVENT_RULE). Man City's appeal article came six days after the
//    verdict story was first seen. Jev never attaches past this window; the
//    article goes to Haiku (assignment) or stays unmatched (sweep).
export const SAME_EVENT_WINDOW_MS = 72 * 3_600_000;
// 3. Bundle cards: "AI Legal and Regulatory Crisis Intensifies" was built from
//    a roundup and names four developments, so anything about AI matched it.
//    Jev screens each card once; a card that bundles several developments is
//    never offered as a target (screenCards).
export function hasEvidence(a: StoryArticle): boolean {
  if (a.articleSummary && a.articleSummary.trim() !== "") return true;
  const lede = (a as JevArticle).lede;
  return !!lede && lede.trim().split(/\s+/).length >= MIN_EVIDENCE_WORDS;
}
export function outsideWindow(a: StoryArticle, card: StoryCard): boolean {
  return !!a.publishedAt && a.publishedAt.getTime() - card.firstSeenAt.getTime() > SAME_EVENT_WINDOW_MS;
}

// Jev's one-moment probability runs low even for real single moments (the CNN
// press-pool card scored 0.48, a Texas poll 0.22); below 0.15 the 2026-10-02
// copy's flagged cards were all bundles, roundups or ongoing beats. Only
// those are held back.
export const BUNDLE_BELOW = 0.15;
const BUNDLE_QUESTION: JevQuestion = {
  type: "noul",
  instructions: "Does this story describe ONE triggering moment (a single act, statement or incident, with reports on it and reactions to it), rather than bundling several separate developments or an ongoing situation into one card?",
  criteria: { true: "One triggering moment", false: "Several separate developments, or an ongoing situation" },
};
// Screened once per card text in a process (one run), shared by the
// assignment rounds and the sweep.
const screened = new Map<string, boolean>();
const screenKey = (c: StoryCard) => `${c.id}\u0000${c.headline}\u0000${c.eventStatement}`;
export function resetCardScreen(): void { screened.clear(); }
// Returns the ids of bundle cards. A card whose screen call fails is kept:
// failing to check a card is not evidence that it is a bundle.
export async function screenCards(cards: readonly StoryCard[], usage: { sink?: UsageSink; next: () => number }): Promise<Set<string>> {
  const todo = [...new Map(cards.filter((c) => !screened.has(screenKey(c))).map((c) => [screenKey(c), c])).values()];
  await Promise.all(todo.map(async (card) => {
    const callIndex = usage.next();
    const startedAt = Date.now();
    try {
      const { answers, inputTokens } = await askJev({ story: cardState(card) }, { one: BUNDLE_QUESTION });
      await usage.sink?.({ inputTokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: JEV_MODEL, callIndex, wallMs: Date.now() - startedAt, status: "succeeded", error: null });
      const p = answers.one?.noul;
      screened.set(screenKey(card), typeof p === "number" && p < BUNDLE_BELOW);
      if (typeof p === "number" && p < BUNDLE_BELOW) logger.info("jev: story card bundles several developments; not offered as a match", { storyId: card.id, headline: card.headline, oneMoment: p });
    } catch (error) {
      await usage.sink?.({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: JEV_MODEL, callIndex, wallMs: Date.now() - startedAt, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }));
  return new Set(cards.filter((c) => screened.get(screenKey(c)) === true).map((c) => c.id));
}
const NONE = "none";

type UsageSink = (usage: ModelUsage & { model: string; callIndex: number; wallMs: number; status: "succeeded" | "failed"; error: string | null }) => void | Promise<void>;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Optional extra context (2026-10-02, Max: "maybe we need to improve the
// context we are feeding jev"). When a loader supplies them, Jev also sees the
// article's opening paragraphs and whether it is an opinion piece, and each
// story's member summaries and date span. Absent fields are simply left out.
export type JevArticle = StoryArticle & { lede?: string | null; opinion?: boolean | null };
export type JevCard = StoryCard & { memberSummaries?: string[] };

function articleState(a: JevArticle) {
  return {
    title: cleanTitle(a.title), outlet: a.outletName, published_at: a.publishedAt?.toISOString() ?? null, summary: a.articleSummary, reacting_to: a.reactingTo,
    ...(a.opinion != null ? { kind: a.opinion ? "opinion column" : "news report" } : {}),
    ...(a.lede ? { opening: a.lede } : {}),
  };
}

function cardState(card: JevCard) {
  return {
    headline: card.headline, event_statement: card.eventStatement, first_seen_at: card.firstSeenAt.toISOString(),
    last_updated_at: card.updatedAt.toISOString(), member_headlines: card.memberHeadlines.slice(0, 3).map(cleanTitle),
    ...(card.memberSummaries?.length ? { member_summaries: card.memberSummaries.slice(0, 3) } : {}),
  };
}

// Most articles reach the ledger before they are scored, so they have no
// summary and Jev would judge them on the headline alone ("The Sen. Collins
// Firewall"). Those get their opening 120 words instead (2026-10-02 side-by-side:
// the gap-filled sweep dropped the opinion pieces it had joined on headline
// alone). Articles that have a summary are left as they are.
export const OPENING_WORDS = 120;
export async function withOpenings(articles: readonly StoryArticle[], db: Pick<typeof pool, "query"> = pool): Promise<JevArticle[]> {
  const ids = articles.filter((a) => !a.articleSummary).map((a) => a.id);
  if (ids.length === 0) return [...articles];
  const { rows } = await db.query<{ id: number; lede: string | null }>(
    `SELECT id, array_to_string((regexp_split_to_array(btrim(COALESCE(clean_text, raw_text)), '\\s+'))[1:$2::int], ' ') AS lede
       FROM articles WHERE id = ANY($1::int[])`, [ids, OPENING_WORDS]);
  const lede = new Map(rows.map((r) => [r.id, r.lede]));
  return articles.map((a) => (lede.get(a.id) ? { ...a, lede: lede.get(a.id) } : a));
}

// An opinion piece or analysis about an actor or topic is not thereby about a
// story on that actor or topic. Restates SAME_EVENT_RULE's "similar topics are
// not enough" for the case that produced most wrong joins on 2026-10-02.
export const OPINION_NOTE = "An opinion column, analysis or explainer joins a story only when it is about that story's specific triggering moment. Writing about the same person, policy or topic in general is not enough. Two different organizations' figures (two fundraising totals, two polls) are different events.";
// verify: a second Jev call on each confident pick, with typed yes/no checks
// on that one pair (2026-10-02, Max: "jev runs on context and questions... we
// need to improve both"). A pick that fails a check goes back to Haiku.
// style "sharp" (2026-10-02, Max: "i didnt say more...i said better"): each
// option IS the story's triggering moment and date, and the question is one
// plain test, instead of the long rule prose and another edition's examples.
// verify "moment" asks only the moment-or-direct-reaction check; "both" adds
// the different-development check, which also rejected real reactions.
// perCall: how many articles share one Jev call. Packing 8 saved little and,
// on 2026-10-02, the same article got different verdicts depending on which
// others shared its call; 1 gives Jev only the article and its own options.
export interface GroupingPromptOptions { opinionNote?: boolean; verify?: boolean | "moment" | "both"; style?: "rule" | "sharp"; perCall?: number }

export const SHARP_INSTRUCTIONS = "A story is one triggering moment (a single act, statement or incident) plus reports on it and direct reactions to it within a few days. Each option names one story's triggering moment. Which moment does this article report on or directly react to? Answer none if the article is about a different act, statement, figure or development, even one involving the same people, organizations or topic. An opinion or analysis piece counts only when it is about that specific moment.";

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&rsquo;": "\u2019", "&lsquo;": "\u2018", "&ldquo;": "\u201c", "&rdquo;": "\u201d", "&mdash;": "\u2014", "&ndash;": "\u2013" };
export function cleanTitle(t: string): string {
  return t.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ").replace(/^\s*(WATCH|LIVE|VIDEO|Watch live)\s*:\s*/i, "").replace(/\s+/g, " ").trim();
}

export const VERIFY_QUESTIONS = (k: string): Record<string, JevQuestion> => ({
  [`m${k}`]: { type: "noul", instructions: `Pair ${k}: is the article about the story's own triggering moment (the specific act, statement or incident in its event_statement), or a direct reaction to that moment?`,
    criteria: { true: "About that moment, or a direct reaction to it", false: "About something else, even if the same people or topic" } },
  [`d${k}`]: { type: "noul", instructions: `Pair ${k}: does the article report a DIFFERENT act, statement, figure or development from the story's, involving the same people, organizations or topic?`,
    criteria: { true: "A different development on the same people or topic", false: "The same development" } },
});

// Returns the pair keys that passed. A failed call passes nothing: the picks
// go back to Haiku, never get attached on an unchecked guess.
async function verifyPairs(pairs: ReadonlyArray<{ key: string; article: StoryArticle; card: StoryCard }>, usage: { sink?: UsageSink; next: () => number }, momentOnly = false, perCall = ARTICLES_PER_CALL): Promise<Set<string>> {
  const passed = new Set<string>();
  await Promise.all(chunks(pairs, perCall).map(async (group) => {
    const state = { pairs: Object.fromEntries(group.map((g) => [g.key, { article: articleState(g.article), story: cardState(g.card) }])) };
    const questions = Object.assign({}, ...group.map((g) => {
      const q = VERIFY_QUESTIONS(g.key);
      if (momentOnly) delete q[`d${g.key}`];
      return q;
    })) as Record<string, JevQuestion>;
    const callIndex = usage.next();
    const startedAt = Date.now();
    try {
      const { answers, inputTokens } = await askJev(state, questions);
      await usage.sink?.({ inputTokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: JEV_MODEL, callIndex, wallMs: Date.now() - startedAt, status: "succeeded", error: null });
      for (const g of group) {
        const moment = answers[`m${g.key}`]?.noul;
        const different = answers[`d${g.key}`]?.noul;
        if (typeof moment === "number" && moment >= 0.5 && (momentOnly || (typeof different === "number" && different < 0.5))) passed.add(g.key);
      }
    } catch (error) {
      await usage.sink?.({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: JEV_MODEL, callIndex, wallMs: Date.now() - startedAt, status: "failed", error: error instanceof Error ? error.message : String(error) });
      logger.warn("jev verification call failed; these picks go back to Haiku", { pairs: group.map((g) => g.key), error: error instanceof Error ? error.message : String(error) });
    }
  }));
  return passed;
}

// Short keys ("s1") stand in for story ids inside the question; the map back is
// kept here, so an id Jev never saw cannot come back as an answer.
function matchQuestion(article: StoryArticle, keys: readonly string[], cardsByKey: ReadonlyMap<string, StoryCard>, prompt: GroupingPromptOptions = {}): JevQuestion {
  const criteria: Record<string, string> = {};
  if (prompt.style === "sharp") {
    for (const key of keys) {
      const card = cardsByKey.get(key)!;
      criteria[key] = `${card.headline}: ${card.eventStatement} (first reported ${card.firstSeenAt.toISOString().slice(0, 10)})`;
    }
    criteria[NONE] = "None: the article is about a different act, statement, figure or development";
    const published = article.publishedAt ? ` Published ${article.publishedAt.toISOString().slice(0, 10)}.` : "";
    return {
      type: "choice",
      instructions: `${SHARP_INSTRUCTIONS}\n\nArticle: "${cleanTitle(article.title)}" (${article.outletName}).${published} Summary: ${article.articleSummary ?? "(none)"}${article.reactingTo ? ` It says it is reacting to: ${article.reactingTo}` : ""}`,
      criteria,
    };
  }
  for (const key of keys) {
    const card = cardsByKey.get(key)!;
    criteria[key] = `${card.headline}: ${card.eventStatement}`;
  }
  criteria[NONE] = "None of these stories is the same event as this article";
  return {
    type: "choice",
    instructions: `${SAME_EVENT_RULE}${prompt.opinionNote ? `\n\n${OPINION_NOTE}` : ""}\n\nThe stories are listed under "stories" by key. Which one is the SAME EVENT as the article "${article.title}" (${article.outletName})? Its summary: ${article.articleSummary ?? "(none)"}${article.reactingTo ? ` It says it is reacting to: ${article.reactingTo}` : ""}`,
    criteria,
  };
}

const roundupQuestion = (article: StoryArticle): JevQuestion => ({
  type: "noul",
  instructions: `Is the article "${article.title}" a roundup or digest that covers several unrelated events, rather than a report on one?`,
  criteria: { true: "Roundup of several events", false: "A report on one event" },
});

export interface Match {
  storyId: string | null;
  probability: number;
  noneProbability: number;
  roundup: boolean;
}

function readMatch(answer: JevAnswer | undefined, cardsByKey: ReadonlyMap<string, StoryCard>, roundup: JevAnswer | undefined): Match | null {
  const probabilities = answer?.probabilities;
  if (!probabilities) return null;
  let bestKey: string | null = null;
  let best = 0;
  for (const [key, p] of Object.entries(probabilities)) {
    if (key === NONE || !cardsByKey.has(key)) continue;
    if (p > best) { best = p; bestKey = key; }
  }
  return {
    storyId: bestKey ? cardsByKey.get(bestKey)!.id : null,
    probability: best,
    noneProbability: probabilities[NONE] ?? 0,
    roundup: (roundup?.noul ?? 0) >= 0.5,
  };
}

interface Ask {
  article: StoryArticle;
  cards: readonly StoryCard[];
}

// One Jev call answers ARTICLES_PER_CALL articles, each against its own cards,
// over the union of those cards listed once in the state. Returns null for an
// article whose answer could not be read; throws only when the call fails.
async function askMatches(asks: readonly Ask[], withRoundup: boolean, usage: { sink?: UsageSink; next: () => number }, prompt: GroupingPromptOptions = {}): Promise<Map<number, Match | null>> {
  const keyById = new Map<string, string>();
  const cardsByKey = new Map<string, StoryCard>();
  for (const { cards } of asks) {
    for (const card of cards) {
      if (keyById.has(card.id)) continue;
      const key = `s${keyById.size + 1}`;
      keyById.set(card.id, key);
      cardsByKey.set(key, card);
    }
  }
  const questions: Record<string, JevQuestion> = {};
  for (const { article, cards } of asks) {
    questions[`a${article.id}`] = matchQuestion(article, cards.map((card) => keyById.get(card.id)!), cardsByKey, prompt);
    if (withRoundup) questions[`r${article.id}`] = roundupQuestion(article);
  }
  const state = {
    stories: Object.fromEntries([...cardsByKey].map(([key, card]) => [key, cardState(card)])),
    articles: Object.fromEntries(asks.map(({ article }) => [`a${article.id}`, articleState(article)])),
  };
  const callIndex = usage.next();
  const startedAt = Date.now();
  try {
    const { answers, inputTokens } = await askJev(state, questions);
    await usage.sink?.({ inputTokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: JEV_MODEL, callIndex, wallMs: Date.now() - startedAt, status: "succeeded", error: null });
    return new Map(asks.map(({ article, cards }) => {
      const own = new Map(cards.map((card) => [keyById.get(card.id)!, card]));
      return [article.id, readMatch(answers[`a${article.id}`], own, answers[`r${article.id}`])];
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await usage.sink?.({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: JEV_MODEL, callIndex, wallMs: Date.now() - startedAt, status: "failed", error: message });
    throw error;
  }
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export interface JevPrepass {
  // Attach decisions Jev was confident about; these skip Haiku.
  decided: StoryDecision[];
  // Everything else, for Haiku's assignment.
  forHaiku: StoryArticle[];
  // Candidates for Haiku: an article Jev was confident matches NO candidate is
  // offered none, so Haiku can only start a new story, flag, or call it not
  // news; Haiku cannot overrule Jev's "no match".
  candidatesForHaiku: Map<number, readonly StoryCard[]>;
  stats: { attached: number; noMatch: number; undecided: number; failed: number; verifyRejected: number; outsideWindow: number; thinEvidence: number; bundleCards: number };
  // Confident picks held back by the same-event window, for the run log.
  windowed: Array<{ articleId: number; storyId: string }>;
}

// Assignment pre-pass. Roundups always go to Haiku, because a roundup may
// attach to several stories and Jev's choice names one.
export async function jevAssignmentPrepass(
  articles: readonly StoryArticle[],
  candidates: ReadonlyMap<number, readonly StoryCard[]>,
  onUsage?: UsageSink,
  prompt: GroupingPromptOptions = PRODUCTION_PROMPT,
): Promise<JevPrepass> {
  let call = 0;
  const usage = { sink: onUsage, next: () => ++call };
  const bundles = await screenCards([...new Set(articles.flatMap((a) => (candidates.get(a.id) ?? []).slice(0, 20)))], usage);
  const judgeable = articles.filter(hasEvidence);
  const asks = judgeable
    .map((a) => ({ article: a, cards: (candidates.get(a.id) ?? []).slice(0, 20).filter((c) => !bundles.has(c.id)) }))
    .filter((ask) => ask.cards.length > 0);
  const matches = new Map<number, Match | null>();
  let failed = 0;
  await Promise.all(chunks(asks, prompt.perCall ?? ARTICLES_PER_CALL).map(async (group) => {
    try {
      for (const [id, m] of await askMatches(group, true, usage, prompt)) matches.set(id, m);
    } catch (error) {
      failed += group.length;
      logger.warn("jev assignment pre-pass call failed; these articles go to Haiku", { articleIds: group.map((g) => g.article.id), error: error instanceof Error ? error.message : String(error) });
    }
  }));

  // A confident, non-roundup pick, before the window and the check.
  const pickOf = (article: StoryArticle): StoryCard | undefined => {
    const m = matches.get(article.id);
    return m && !m.roundup && m.storyId && m.probability >= MATCH_AT ? (candidates.get(article.id) ?? []).find((c) => c.id === m.storyId) : undefined;
  };
  let verified: Set<string> | null = null;
  if (prompt.verify) {
    const pairs = articles.flatMap((article) => {
      const card = pickOf(article);
      return card && !outsideWindow(article, card) ? [{ key: String(article.id), article, card }] : [];
    });
    verified = await verifyPairs(pairs, usage, prompt.verify === "moment", prompt.perCall);
  }

  const decided: StoryDecision[] = [];
  const forHaiku: StoryArticle[] = [];
  const windowed: Array<{ articleId: number; storyId: string }> = [];
  const candidatesForHaiku = new Map<number, readonly StoryCard[]>(candidates);
  const stats = { attached: 0, noMatch: 0, undecided: 0, failed, verifyRejected: 0, outsideWindow: 0, thinEvidence: articles.length - judgeable.length, bundleCards: bundles.size };
  for (const article of articles) {
    const m = matches.get(article.id);
    const pick = pickOf(article);
    if (pick && outsideWindow(article, pick)) { stats.outsideWindow++; stats.undecided++; windowed.push({ articleId: article.id, storyId: pick.id }); forHaiku.push(article); continue; }
    if (pick && verified && !verified.has(String(article.id))) { stats.verifyRejected++; stats.undecided++; forHaiku.push(article); continue; }
    if (m && pick) {
      const headline = pick.headline;
      decided.push({ articleId: article.id, action: "attach", storyIds: [pick.id], role: "primary", confidence: m.probability >= 0.9 ? "high" : "medium", reason: `Jev: same event as "${headline}" (${pct(m.probability)}).`.slice(0, 160) });
      stats.attached++;
      continue;
    }
    if (m && !m.roundup && m.noneProbability >= MATCH_AT) {
      candidatesForHaiku.set(article.id, []);
      stats.noMatch++;
    } else if (m) {
      stats.undecided++;
    }
    forHaiku.push(article);
  }
  return { decided, forHaiku, candidatesForHaiku, stats, windowed };
}

// The exhaustive sweep, decided by Jev. Same contract as sweepArticles: one
// decision per article, a check row for every card the article was compared
// with, and an unfinished article keeps its assignment decision.
export async function jevSweepArticles(
  articles: readonly StoryArticle[],
  stories: readonly StoryCard[],
  options: Pick<SweepOptions, "seededStoryIds" | "onValidatedBatch"> & { onUsage?: UsageSink } = {},
): Promise<SweepResult> {
  const zero = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  if (articles.length === 0) return { decisions: [], checks: [], incompleteArticleIds: [], usage: zero, calls: 0 };
  if (stories.length === 0) {
    return { decisions: articles.map((a) => ({ articleId: a.id, action: "none", reason: "No open story existed to check." })), checks: [], incompleteArticleIds: [], usage: zero, calls: 0 };
  }
  const seeded = options.seededStoryIds ?? new Map<number, string>();
  let call = 0;
  let inputTokens = 0;
  const usage = {
    next: () => ++call,
    sink: async (u: Parameters<UsageSink>[0]) => { inputTokens += u.inputTokens; await options.onUsage?.(u); },
  };
  const incomplete = new Set<number>();
  const best = new Map<number, { storyId: string; probability: number }>();
  const checks: SweepCheck[] = [];
  // Too little text to judge: deliberately not checked, so the assignment
  // decision stands. Not "unfinished": that would mark every run's sweep
  // incomplete for articles it chose to skip.
  const thin = new Set(articles.filter((a) => !hasEvidence(a)).map((a) => a.id));
  const bundles = await screenCards(stories, usage);
  const targets = stories.filter((c) => !bundles.has(c.id));

  await Promise.all(chunks(targets, CARDS_PER_SHARD).flatMap((shardCards, shard) =>
    chunks(articles.filter((a) => !thin.has(a.id)), PRODUCTION_PROMPT.perCall).map(async (group) => {
      // Only stories inside the same-event window are options for an article.
      const asks = group.map((article) => ({ article, cards: shardCards.filter((c) => c.id !== seeded.get(article.id) && !outsideWindow(article, c)) })).filter((a) => a.cards.length > 0);
      if (asks.length === 0) return;
      let matches: Map<number, Match | null>;
      try {
        matches = await askMatches(asks, false, usage, PRODUCTION_PROMPT);
      } catch (error) {
        for (const { article } of asks) incomplete.add(article.id);
        logger.warn("jev sweep call failed; these articles keep their assignment decision", { shard, articleIds: asks.map((a) => a.article.id), error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const batchChecks: SweepCheck[] = [];
      const validIds: number[] = [];
      for (const { article, cards } of asks) {
        const m = matches.get(article.id);
        if (!m) { incomplete.add(article.id); continue; }
        validIds.push(article.id);
        const hit = m.storyId && m.probability >= MATCH_AT ? m.storyId : null;
        if (hit && m.probability > (best.get(article.id)?.probability ?? 0)) best.set(article.id, { storyId: hit, probability: m.probability });
        for (const card of cards) {
          batchChecks.push({
            articleId: article.id,
            storyId: card.id,
            outcome: card.id === hit ? "match" : "excluded",
            reason: card.id === hit ? `Jev: same event (${pct(m.probability)}).` : "Jev found this card was not the same event.",
          });
        }
      }
      checks.push(...batchChecks);
      if (options.onValidatedBatch && validIds.length > 0) {
        await options.onValidatedBatch({
          shard,
          articleIds: validIds,
          checkedByArticle: new Map(asks.filter((a) => validIds.includes(a.article.id)).map((a) => [a.article.id, a.cards.length])),
          checks: batchChecks,
        });
      }
    }),
  ));

  // The best pick across shards gets the same moment-or-reaction check as
  // assignment; a pick that fails it is no match, and its check row says so.
  const picks = [...best].map(([articleId, b]) => ({ key: String(articleId), article: articles.find((a) => a.id === articleId)!, card: stories.find((c) => c.id === b.storyId)! }));
  const passed = await verifyPairs(picks, usage, true, PRODUCTION_PROMPT.perCall);
  for (const pick of picks) {
    if (passed.has(pick.key)) continue;
    best.delete(pick.article.id);
    for (const check of checks) {
      if (check.articleId === pick.article.id && check.storyId === pick.card.id) { check.outcome = "excluded"; check.reason = "Jev's check: not this story's moment or a direct reaction to it."; }
    }
  }
  const decisions = articles.map<SweepDecision>((article) => {
    if (thin.has(article.id)) return { articleId: article.id, action: "none", reason: "Too little text for Jev to judge; assignment decision kept." };
    if (incomplete.has(article.id)) return { articleId: article.id, action: "none", reason: "Exhaustive sweep did not finish; assignment decision kept." };
    const hit = best.get(article.id);
    if (hit) return { articleId: article.id, action: "attach", storyIds: [hit.storyId], role: "primary", reason: `Jev: same event (${pct(hit.probability)}).` };
    return { articleId: article.id, action: "none", reason: "No open story was the same event." };
  });
  return { decisions, checks, incompleteArticleIds: [...incomplete].sort((a, b) => a - b), usage: { ...zero, inputTokens }, calls: call };
}

// Merge review: one yes/no, read as a probability. A call that fails throws,
// as reviewMerge does, and the caller records it as a review error.
export async function jevReviewMerge(left: StoryCard, right: StoryCard, onUsage?: UsageSink, callIndex = 1): Promise<MergeReview> {
  const startedAt = Date.now();
  const question: JevQuestion = {
    type: "noul",
    instructions: `${SAME_EVENT_RULE}\n\nAre stories "left" and "right" the SAME EVENT, so they should be one story? Yes only when both describe the same actors, act, and occasion.`,
    criteria: { true: "The same event: one story", false: "Different events" },
  };
  try {
    const { answers, inputTokens } = await askJev({ left: cardState(left), right: cardState(right) }, { same: question });
    await onUsage?.({ inputTokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: JEV_MODEL, callIndex, wallMs: Date.now() - startedAt, status: "succeeded", error: null });
    const p = answers.same?.noul;
    if (typeof p !== "number" || !Number.isFinite(p)) return { leftStoryId: left.id, rightStoryId: right.id, decision: "unsure", reason: "Jev gave no merge answer." };
    const decision = p >= MATCH_AT ? "yes" : p <= NO_MERGE_AT ? "no" : "unsure";
    return { leftStoryId: left.id, rightStoryId: right.id, decision, reason: `Jev: ${decision === "yes" ? "same event" : decision === "no" ? "different events" : "uncertain"} (${pct(p)}).` };
  } catch (error) {
    await onUsage?.({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: JEV_MODEL, callIndex, wallMs: Date.now() - startedAt, status: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
