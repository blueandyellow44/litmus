// The articles inside one story cluster, fetched the first time a reader opens
// it. Used by ClusterCardDesktop.tsx and ClusterCardMobile.tsx so both cards lay
// out data rather than fetching it. The shared ClusterCard.tsx still carries its
// own copy of this toggle; it is a shared component this page no longer uses.
//
// One difference from that copy, on purpose: a failed fetch is reported to the
// reader instead of only reaching the console, so "Show articles" never looks
// like a button that did nothing.

import { useEffect, useRef, useState } from "react";
import { fetchClusterArticles, ApiHttpError } from "../../lib/api.ts";
import type { ClusterArticleDTO } from "../../lib/types.ts";

export interface ClusterMembers {
  expanded: boolean;
  loading: boolean;
  error: string;
  articles: ClusterArticleDTO[];
  toggle: () => void;
}

export function useClusterMembers(clusterId: number): ClusterMembers {
  const [expanded, setExpanded] = useState(false);
  const [articles, setArticles] = useState<ClusterArticleDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const toggle = () => {
    if (loading) return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (articles.length > 0) {
      setExpanded(true);
      return;
    }
    setLoading(true);
    setError("");
    fetchClusterArticles(clusterId)
      .then((data) => {
        if (!mounted.current) return;
        setArticles(data);
        setExpanded(true);
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        setError(err instanceof ApiHttpError ? err.message : String(err));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  };

  return { expanded, loading, error, articles, toggle };
}
