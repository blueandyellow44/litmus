// The story-first front page's data. Mirrors useWire.ts's shape exactly so
// the desktop and mobile pages share one fetch and can never disagree about
// what is in the edition.

import { useEffect, useState } from "react";
import { fetchStories, fetchEditionStatus, ApiHttpError } from "./api.ts";
import type { StoryDTO } from "./storyTypes.ts";
import { inPoliticalScope, inThisWeeksPaper, orderStories, withScoredReport } from "./storyModel.ts";

export interface StoriesState {
  stories: StoryDTO[] | null;
  error: string;
}

export function useStories(): StoriesState {
  const [state, setState] = useState<StoriesState>({ stories: null, error: "" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [allStories, edition] = await Promise.all([fetchStories(), fetchEditionStatus()]);
        const inScope = withScoredReport(inPoliticalScope(allStories));
        if (cancelled) return;
        if (!edition.compiledAt) {
          setState({ stories: orderStories(inScope), error: "" });
          return;
        }
        // The weekly edition is on the page whole from the moment it is
        // published (Max, 2026-10-11); nothing is released through the day.
        const week = inThisWeeksPaper(inScope, edition.compiledAt.toISOString());
        setState({ stories: orderStories(week), error: "" });
      } catch (err) {
        if (!cancelled) {
          setState((s) => ({ ...s, error: err instanceof ApiHttpError ? err.message : String(err) }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
