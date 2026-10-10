// The Sources page's data, shared by its desktop and mobile versions. Neither
// version fetches or derives anything itself; they only lay out what this hook
// returns, so the two can never disagree about who is in the roster.

import { useEffect, useMemo, useState } from "react";
import { fetchSources, ApiHttpError } from "../../lib/api.ts";
import type { SourceDTO } from "../../lib/types.ts";
import { summarizeRoster, type RosterSummary } from "./roster.ts";

export interface SourcesState {
  // Null while loading; set once the roster arrives.
  roster: RosterSummary | null;
  error: string;
}

export function useSources(): SourcesState {
  const [sources, setSources] = useState<SourceDTO[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchSources()
      .then((s) => {
        if (!cancelled) setSources(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiHttpError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const roster = useMemo(() => (sources ? summarizeRoster(sources) : null), [sources]);
  return { roster, error };
}
