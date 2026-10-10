// A single story cluster card. Shows topic, summary, source count, lean
// distribution bar, and P/H range. Clicking it navigates to the cluster
// expand view or toggles inline article list (depending on the page).

import { useState } from "react";
import { Link } from "react-router-dom";
import type { ClusterDTO, ClusterArticleDTO } from "../lib/types.ts";
import { fetchClusterArticles, ApiHttpError } from "../lib/api.ts";
import { PHBadge } from "./PHBadge.tsx";
import { LeanBar } from "./LeanBar.tsx";
import { OutletBaseline, PaywallState } from "./meta.tsx";

interface Props {
  cluster: ClusterDTO;
}

export function ClusterCard({ cluster }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [articles, setArticles] = useState<ClusterArticleDTO[]>([]);
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (articles.length > 0) {
      setExpanded(true);
      return;
    }
    setLoading(true);
    try {
      const data = await fetchClusterArticles(cluster.id);
      setArticles(data);
      setExpanded(true);
    } catch (err) {
      if (err instanceof ApiHttpError) {
        console.error(err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border border-rule rounded-lg p-5 bg-surface">
      {/* Header row: topic + P/H range */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <button
            onClick={handleToggle}
            className="text-left w-full group"
          >
            <h2 className="font-serif text-h3 group-hover:underline decoration-1 underline-offset-4">
              {cluster.topic}
            </h2>
          </button>
          <p className="font-sans text-sm text-ink3 mt-1.5">{cluster.summary}</p>
        </div>
        {cluster.phAvg !== null && (
          <div className="shrink-0 pt-0.5">
            <PHBadge composite={cluster.phAvg} size="sm" />
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="mt-4 flex items-center gap-4 font-sans text-xs text-ink3">
        <span>{cluster.articleCount} article{cluster.articleCount === 1 ? "" : "s"}</span>
        {cluster.phMin !== null && cluster.phMax !== null && (
          <span>P/H range: {cluster.phMin.toFixed(1)} – {cluster.phMax.toFixed(1)}</span>
        )}
      </div>

      {/* Lean bar */}
      <div className="mt-3">
        <LeanBar leanCounts={cluster.leanCounts} height="md" />
      </div>

      {/* Expand toggle */}
      <button
        onClick={handleToggle}
        className="mt-3 font-sans text-sm text-ink3 hover:text-ink transition-colors"
      >
        {loading ? "Loading…" : expanded ? "Collapse" : "Show articles"}
      </button>

      {/* Expanded article list */}
      {expanded && articles.length > 0 && (
        <ul className="mt-4 border-t border-rule pt-4 space-y-3">
          {articles.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-sans text-xs text-ink3 mb-0.5 flex flex-wrap items-center gap-x-1.5">
                  <span>{a.sourceName}</span>
                  <span aria-hidden>·</span>
                  <OutletBaseline lean={a.sourceLean} />
                  {a.paywallFlag && (
                    <>
                      <span aria-hidden>·</span>
                      <PaywallState paywallFlag={a.paywallFlag} />
                    </>
                  )}
                </div>
                <Link
                  to={`/articles/${a.id}`}
                  className="font-serif text-base hover:underline decoration-1 underline-offset-4"
                >
                  {a.title}
                </Link>
              </div>
              {a.score && (
                <span className="shrink-0">
                  <PHBadge composite={a.score.composite} size="sm" />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
