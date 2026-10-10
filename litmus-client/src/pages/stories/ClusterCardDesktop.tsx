// One grouped story, composed for a desktop two-column grid. Same facts and
// order as the shared ClusterCard.tsx, which other pages may still use.
//
// Two reasons this page no longer uses that card. Its "Show articles" toggle was
// bare grey 14px text with no border and no height, so it read as a caption
// rather than a control. And its lean bar had no key. Here the toggle is a
// bordered button, the bar carries a legend, and the member articles load
// through useClusterMembers, which reports a failed fetch to the reader instead
// of only to the console.

import { Link } from "react-router-dom";
import type { ClusterDTO } from "../../lib/types.ts";
import { PHBadge } from "../../components/PHBadge.tsx";
import { CONTROL, FOCUS_RING, OutletBaseline, PaywallState } from "../../components/meta.tsx";
import { useClusterMembers } from "./useClusterMembers.ts";
import { LeanSpread } from "./LeanSpread.tsx";

export function ClusterCardDesktop({ cluster }: { cluster: ClusterDTO }) {
  const { expanded, loading, error, articles, toggle } = useClusterMembers(cluster.id);

  return (
    // Open, the card takes the full row of the two-column grid and lays its
    // articles out in two columns, so the list costs half the height and no
    // empty cell is left beside it.
    <div className={`border border-rule rounded-lg p-5 bg-surface ${expanded ? "col-span-2" : ""}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            className={`text-left w-full group ${FOCUS_RING}`}
          >
            <h2 className="font-serif text-h3 m-0 group-hover:underline decoration-1 underline-offset-4">
              {cluster.topic}
            </h2>
          </button>
          <p className="font-sans text-sm text-ink3 mt-1.5 mb-0 max-w-prose">{cluster.summary}</p>
        </div>
        {cluster.phAvg !== null && (
          <div className="shrink-0 pt-0.5">
            <PHBadge composite={cluster.phAvg} size="sm" />
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-4 font-sans text-xs text-ink3">
        <span>
          {cluster.articleCount} article{cluster.articleCount === 1 ? "" : "s"}
        </span>
        {cluster.phMin !== null && cluster.phMax !== null && (
          <span>
            P/H range: {cluster.phMin.toFixed(1)} – {cluster.phMax.toFixed(1)}
          </span>
        )}
      </div>

      <div className="mt-3">
        <LeanSpread leanCounts={cluster.leanCounts} textClass="text-xs" />
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className={`mt-4 inline-flex items-center gap-2 border border-rule-strong px-4 font-sans text-sm hover:border-ink hover:bg-ink hover:text-ground transition-colors ${CONTROL}`}
      >
        <span aria-hidden className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>
          ›
        </span>
        {loading ? "Loading…" : expanded ? "Collapse" : "Show articles"}
      </button>

      {error && (
        <p className="font-sans text-xs text-ink3 mt-2 mb-0" role="status">
          The articles for this story could not be loaded. {error}
        </p>
      )}

      {expanded && articles.length > 0 && (
        <ul className="list-none p-0 m-0 mt-4 border-t border-rule pt-4 grid grid-cols-2 gap-x-8 gap-y-3">
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
                  // block py-1: a bare inline link was a 20px strip.
                  className={`block py-1 font-serif text-base hover:underline decoration-1 underline-offset-4 ${FOCUS_RING}`}
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
