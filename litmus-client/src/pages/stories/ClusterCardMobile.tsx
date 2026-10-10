// One grouped story, composed for a phone. Same facts as the shared
// ClusterCard.tsx and ClusterCardDesktop.tsx (topic, summary, article count, P/H
// range, lean spread with its legend, the member articles).
//
// The shared card's "Show articles" control is a bare line of 14px text with no
// minimum height, well under a thumb. Here the toggle is a full-width 44px
// button, and the member articles load through useClusterMembers so this card
// only lays them out.

import { Link } from "react-router-dom";
import type { ClusterDTO } from "../../lib/types.ts";
import { PHBadge } from "../../components/PHBadge.tsx";
import { CONTROL, FOCUS_RING, OutletBaseline, PaywallState } from "../../components/meta.tsx";
import { useClusterMembers } from "./useClusterMembers.ts";
import { LeanSpread } from "./LeanSpread.tsx";

export function ClusterCardMobile({ cluster }: { cluster: ClusterDTO }) {
  const { expanded, loading, error, articles, toggle } = useClusterMembers(cluster.id);

  return (
    <li className="border border-rule rounded-lg p-4 bg-surface">
      <button type="button" onClick={toggle} aria-expanded={expanded} className={`text-left w-full ${FOCUS_RING}`}>
        <h2 className="font-serif text-[21px] leading-[1.25] m-0">{cluster.topic}</h2>
      </button>
      <p className="font-sans text-[15px] leading-relaxed text-ink3 mt-1.5 mb-0">{cluster.summary}</p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[13px] text-ink3">
        {cluster.phAvg !== null && <PHBadge composite={cluster.phAvg} size="sm" />}
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
        <LeanSpread leanCounts={cluster.leanCounts} textClass="text-[13px]" />
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className={`mt-3 w-full border border-rule-strong font-sans text-sm ${CONTROL}`}
      >
        {loading ? "Loading…" : expanded ? "Collapse" : "Show articles"}
      </button>

      {error && (
        <p className="font-sans text-[13px] text-ink3 mt-2 mb-0" role="status">
          The articles for this story could not be loaded. {error}
        </p>
      )}

      {expanded && articles.length > 0 && (
        <ul className="list-none p-0 m-0 mt-3 border-t border-rule">
          {articles.map((a) => (
            <li key={a.id} className="border-b border-rule last:border-0 pt-2.5 pb-3">
              <div className="font-sans text-[13px] text-ink3 flex flex-wrap items-center gap-x-1.5">
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
              {/* Fixed padding, not a centred 44px box: centring gave a one-line
                  headline 20px of air on each side and a three-line one none, so
                  the list read as irregular. Padding keeps the gap the same for
                  every length and still clears 44px on one line. */}
              <Link to={`/articles/${a.id}`} className={`block py-3 font-serif text-[17px] leading-snug ${FOCUS_RING}`}>
                {a.title}
              </Link>
              {a.score && <PHBadge composite={a.score.composite} size="sm" />}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
