// The front page's data, shared by its desktop and mobile versions. Neither
// version fetches or builds anything itself; they only lay out what this hook
// returns, so the two can never disagree about what is in the edition.

import { useEffect, useState } from "react";
import { fetchClusterArticles, fetchClusters, fetchEntireEdition, ApiHttpError } from "./api.ts";
import type { ArticleSummaryDTO, ClusterArticleDTO } from "./types.ts";
import { buildWire, type WireItem } from "./wire.ts";

export interface WireState {
  items: WireItem[] | null;
  articles: ArticleSummaryDTO[];
  // False when the edition stopped loading part way; the page says so.
  complete: boolean;
  error: string;
}

export function useWire(): WireState {
  const [state, setState] = useState<WireState>({ items: null, articles: [], complete: true, error: "" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [edition, clusters] = await Promise.all([fetchEntireEdition(), fetchClusters()]);
        const members: Record<number, ClusterArticleDTO[]> = {};
        await Promise.all(
          clusters.map(async (c) => {
            members[c.id] = await fetchClusterArticles(c.id);
          }),
        );
        if (cancelled) return;
        setState({
          items: buildWire(edition.articles, clusters, members),
          articles: edition.articles,
          complete: edition.complete,
          error: "",
        });
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
