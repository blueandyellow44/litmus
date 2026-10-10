// The story-first front page's data. Mirrors useWire.ts's shape exactly so
// the desktop and mobile pages share one fetch and can never disagree about
// what is in the edition.

import { useEffect, useState } from "react";
import { fetchStories, fetchEditionStatus, ApiHttpError } from "./api.ts";
import type { StoryDTO } from "./storyTypes.ts";
import { inPoliticalScope, inTodaysPaper, orderStories, scheduleStoryReveal, withScoredReport } from "./storyModel.ts";

export interface StoriesState {
  stories: StoryDTO[] | null;
  error: string;
}

// How often an open page re-applies the drip. The edition is fetched once;
// only the reveal is re-computed, so a reader who leaves the tab open still
// sees the day's stories arrive (scheduleStoryReveal spreads them over the day).
const REVEAL_TICK_MS = 5 * 60 * 1000;

export function useStories(): StoriesState {
  const [state, setState] = useState<StoriesState>({ stories: null, error: "" });

  useEffect(() => {
    let cancelled = false;
    let tick: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        const [allStories, edition] = await Promise.all([fetchStories(), fetchEditionStatus()]);
        const inScope = withScoredReport(inPoliticalScope(allStories));
        if (cancelled) return;
        if (!edition.compiledAt) {
          setState({ stories: orderStories(inScope), error: "" });
          return;
        }
        const compiledAt = edition.compiledAt.toISOString();
        const stories = inTodaysPaper(inScope, compiledAt);
        const reveal = () => setState({ stories: scheduleStoryReveal(stories, compiledAt), error: "" });
        reveal();
        tick = setInterval(reveal, REVEAL_TICK_MS);
      } catch (err) {
        if (!cancelled) {
          setState((s) => ({ ...s, error: err instanceof ApiHttpError ? err.message : String(err) }));
        }
      }
    })();
    return () => {
      cancelled = true;
      if (tick !== undefined) clearInterval(tick);
    };
  }, []);

  return state;
}
