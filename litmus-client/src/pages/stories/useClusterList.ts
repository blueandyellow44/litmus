// All Stories: the page's data and state, shared by its desktop and mobile
// versions. Neither version fetches, filters, sorts or counts anything itself;
// they lay out what this hook returns, so the two always agree about the edition.
//
// The server keeps its keyset pagination, which is the right shape for an API;
// the client walks it once on mount. In the published build there is nothing to
// walk — the entire snapshot ships inside the bundle already, so this costs a
// slice of an array that is in memory either way.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchClusters, fetchEntireEdition, ApiHttpError } from "../../lib/api.ts";
import type { ArticleSummaryDTO, ClusterDTO } from "../../lib/types.ts";
import {
  NO_FILTERS,
  RENDER_STEP,
  activeFilterCount,
  applyFilters,
  applySort,
  clusterCountLine,
  countLine,
  endOfListNote,
  filterScopeNote,
  filtersFromParams,
  groupedFilterNote,
  isPaywallKey,
  isSortKey,
  modeFromParams,
  paramsFrom,
  remainingNote,
  sectionsIn,
  selectFields,
  showMoreLabel,
  showResultsLabel,
  sortFromParams,
  sourcesIn,
  type FieldKey,
  type Filters,
  type Load,
  type Mode,
  type SelectField,
  type SortKey,
} from "./clusterListLogic.ts";

export interface FeedState {
  load: Load;
  err: string;
  // The complete edition as loaded.
  articles: ArticleSummaryDTO[];
  editionComplete: boolean;
  // Every article the filters match, sorted. The count describes this.
  matched: ArticleSummaryDTO[];
  // The rows actually drawn. The DOM describes this.
  shown: ArticleSummaryDTO[];
  remaining: number;
  filtering: boolean;
  countLine: string;
  scopeNote: string;
  showMoreLabel: string;
  showResultsLabel: string;
  remainingNote: string;
  endNote: string | null;
}

export interface ClusterState {
  load: Load | "idle";
  err: string;
  clusters: ClusterDTO[];
  countLine: (verb: "Click" | "Tap") => string;
  // Set when feed filters are active: grouping ignores them, and says so.
  filterNote: string | null;
}

export interface ClusterListState {
  mode: Mode;
  sort: SortKey;
  filters: Filters;
  fields: SelectField[];
  activeCount: number;
  setMode: (mode: Mode) => void;
  setField: (key: FieldKey, value: string) => void;
  clearFilters: () => void;
  renderMore: () => void;
  feed: FeedState;
  grouped: ClusterState;
}

function errorText(err: unknown): string {
  return err instanceof ApiHttpError ? err.message : String(err);
}

export function useClusterList(): ClusterListState {
  const [params, setParams] = useSearchParams();

  const mode = modeFromParams(params);
  const sort = sortFromParams(params);
  const filters = useMemo(() => filtersFromParams(params), [params]);

  const setState = (next: { filters?: Filters; sort?: SortKey; mode?: Mode }) => {
    setParams(paramsFrom(next.filters ?? filters, next.sort ?? sort, next.mode ?? mode), { replace: true });
  };

  // The complete edition, loaded once.
  const [articles, setArticles] = useState<ArticleSummaryDTO[]>([]);
  const [editionTotal, setEditionTotal] = useState(0);
  const [editionComplete, setEditionComplete] = useState(false);
  const [feedLoad, setFeedLoad] = useState<Load>("loading");
  const [feedErr, setFeedErr] = useState("");
  const [rendered, setRendered] = useState(RENDER_STEP);

  // Clusters, loaded lazily the first time the grouped view is shown.
  const [clusters, setClusters] = useState<ClusterDTO[]>([]);
  const [clusterLoad, setClusterLoad] = useState<Load | "idle">("idle");
  const [clusterErr, setClusterErr] = useState("");

  const mounted = useRef(true);
  const clustersRequested = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchEntireEdition()
      .then((load) => {
        if (cancelled) return;
        setArticles(load.articles);
        setEditionTotal(load.total);
        setEditionComplete(load.complete);
        if (load.articles.length === 0 && load.error) {
          setFeedErr(load.error);
          setFeedLoad("error");
          return;
        }
        // A partial load is not an error state: the articles that arrived are
        // real and worth reading. It is a caveat, carried into the counts.
        if (load.error) setFeedErr(load.error);
        setFeedLoad("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFeedErr(errorText(err));
        setFeedLoad("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The grouped view loads whenever it is SHOWN, not only when its button is
  // pressed. The earlier page fetched inside the button handler, so a shared
  // link or a reload on ?view=clusters sat on "Grouping stories…" forever. That
  // path is now common rather than rare: switching between the desktop and
  // mobile versions mounts the other version with the view already in the URL.
  // A ref, not the load state, guards the single request, so the state change
  // it causes cannot cancel it.
  useEffect(() => {
    if (mode !== "clusters" || clustersRequested.current) return;
    clustersRequested.current = true;
    setClusterLoad("loading");
    fetchClusters()
      .then((data) => {
        if (!mounted.current) return;
        setClusters(data);
        setClusterLoad("ready");
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        setClusterErr(errorText(err));
        setClusterLoad("error");
      });
  }, [mode]);

  // Narrowing the view starts the rendering budget over, so a filter that
  // matches 3 articles does not need a "Show more" click to reveal them.
  useEffect(() => {
    setRendered(RENDER_STEP);
  }, [filters, sort]);

  const sections = useMemo(() => sectionsIn(articles), [articles]);
  const sources = useMemo(() => sourcesIn(articles), [articles]);
  const matched = useMemo(() => applySort(applyFilters(articles, filters), sort), [articles, filters, sort]);
  const shown = matched.slice(0, rendered);
  const filtering = matched.length !== articles.length;
  const remaining = matched.length - shown.length;

  const setField = (key: FieldKey, value: string) => {
    if (key === "sort") {
      // The select only offers real keys; the guard keeps a stray value from
      // reaching the URL as a sort the page cannot apply.
      if (isSortKey(value)) setState({ sort: value });
      return;
    }
    if (key === "paywall") {
      if (isPaywallKey(value)) setState({ filters: { ...filters, paywall: value } });
      return;
    }
    setState({ filters: { ...filters, [key]: value } });
  };

  return {
    mode,
    sort,
    filters,
    fields: selectFields(filters, sort, sections, sources),
    activeCount: activeFilterCount(filters),
    setMode: (next) => setState({ mode: next }),
    setField,
    clearFilters: () => setState({ filters: NO_FILTERS }),
    renderMore: () => setRendered((n) => n + RENDER_STEP),
    feed: {
      load: feedLoad,
      err: feedErr,
      articles,
      editionComplete,
      matched,
      shown,
      remaining,
      filtering,
      countLine: countLine({
        loaded: articles.length,
        editionTotal,
        editionComplete,
        matched: matched.length,
        shown: shown.length,
      }),
      scopeNote: filterScopeNote(editionComplete),
      showMoreLabel: showMoreLabel(remaining),
      showResultsLabel: showResultsLabel(matched.length, filtering),
      remainingNote: remainingNote(remaining, filtering),
      endNote: endOfListNote(matched.length, shown.length, filtering),
    },
    grouped: {
      load: clusterLoad,
      err: clusterErr,
      clusters,
      countLine: (verb) => clusterCountLine(clusters.length, verb),
      filterNote: groupedFilterNote(activeFilterCount(filters)),
    },
  };
}
