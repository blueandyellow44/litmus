// How many days back the Story Ledger looks for unassigned articles.
//
// The default is a SAFETY CAP, not a dial, mirroring scoring/scoreLimit.ts:
// STORY_LOOKBACK_DAYS can only lower the ceiling for an experiment; it cannot
// raise it. Raising the real ceiling is a code change to MAX_LOOKBACK_DAYS,
// reviewed like any other.
//
// Found 2026-09-21: the Story Ledger's first-ever production run defaulted to
// a hardcoded 14 days with no cap. Since it had never run before, EVERY
// article ingested over the prior 14 days (twice-daily, 66 sources) counted
// as "unassigned" - a backlog large enough that candidate retrieval alone ran
// silently past the funnel's 25-minute step timeout with zero progress
// logged, and with no cost watchdog on this path (only story-replay.mjs has
// one), for an unknown but real amount of spend. A 2-day default and then a
// 200-article-per-run cap (storyCron.ts's MAX_ARTICLES_PER_RUN) both helped
// but still could not clear that backlog inside the step's time budget - the
// verification runs that same day still timed out on messy, reconciliation-
// heavy real backlog even at 200 articles.
//
// Max, 2026-09-21: stop trying to catch up on the historical backlog at all.
// DEFAULT_DAYS=1 means the window itself abandons anything older than a day
// with no code needed beyond this constant - `published_at >= NOW() - N
// days` simply stops matching it on the next run. The backlog does not get
// processed; it ages out. This is a deliberate reset, not a bug: steady
// state is "today's fresh ingest, once a day," not "eventually clear
// everything that piled up before the ledger could run."

// ONE window, for articles AND stories (2026-09-22). The 09-21 fix above
// narrowed only which articles a run offers. Which existing stories those
// articles are compared against stayed a hard-coded 14 days in four places
// (candidate retrieval, sweep, critic load, merge review), so each day's
// articles were still checked against two weeks of leftover stories, and the
// merge review compared every such pair one call at a time: the timeouts
// (docs/run-failures/inventory-2026-09-22.md). storyCron passes this one
// value to all of them; none of those functions has a default any more, and
// lookbackLimit.test.ts fails if a literal 14-day window comes back.
//
// Cost of one day: a story that runs across days (a trial, a war) becomes one
// story per day, since today's article cannot attach to yesterday's story.
// That matches the SAME_EVENT_RULE framing (one triggering moment plus its
// reactions within a news cycle, not an ongoing beat). If a cross-day story
// ever needs to hold together, raise DEFAULT_DAYS to 2 here, not a literal
// somewhere else.
//
// Two days since 2026-10-06 (Max). The one-day cost above showed on the page:
// the 10-02 edition carried the Iowa steel plant as two stories, two outlets
// on 09-28 and seven on 09-29, and about half the front page was two-source
// stories. With a 5 AM run, one day also meant yesterday morning's stories sat
// right at the window's edge. The sweep is the phase that grows with the
// window (open stories roughly double); it ran 3.5 minutes and $0.50 of Jev on
// 10-06 inside a 45-minute step. The front page now shows only stories with a
// report in the last 36 hours (client, storyModel.ts inTodaysPaper), so a
// story that stops gathering reports leaves the page even though it stays
// open here for a second day.

export class StoryLookbackError extends Error {}

export const DEFAULT_DAYS = 2;
export const MAX_LOOKBACK_DAYS = 14;

export function resolveStoryLookbackDays(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_DAYS;

  // Reject before Number() so "5abc", "1e3" and " " do not become plausible
  // numbers by coercion.
  if (!/^\d+$/.test(value)) {
    throw new StoryLookbackError(
      `STORY_LOOKBACK_DAYS must be a positive whole number; got "${raw}". ` +
        "Fractions, negatives and anything non-numeric are refused rather than rounded.",
    );
  }

  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new StoryLookbackError(`STORY_LOOKBACK_DAYS must be at least 1; got "${raw}".`);
  }
  if (n > MAX_LOOKBACK_DAYS) {
    throw new StoryLookbackError(
      `STORY_LOOKBACK_DAYS=${n} exceeds MAX_LOOKBACK_DAYS=${MAX_LOOKBACK_DAYS}. It is a cap ` +
        "that can only lower the window. Raising it is a code change to MAX_LOOKBACK_DAYS, not an env var.",
    );
  }
  return n;
}
