// All Stories, desktop. The feed reads in a wide column beside a sticky filter
// rail, so all seven controls stay in reach while the reader scrolls a long
// edition instead of sitting above the first row and scrolling away. Grouped
// stories use the width as two columns of cards. Every number, filter and list
// comes from useClusterList, shared with ClusterListMobile.tsx.

import type { ReactNode } from "react";
import { CONTROL } from "../../components/meta.tsx";
import { GROUPING_STORIES, LOADING_EDITION, clearFiltersLabel } from "./clusterListLogic.ts";
import { useClusterList, type ClusterListState } from "./useClusterList.ts";
import { StoriesEmpty, StoriesNoClusters, StoriesNoMatches, StoriesServerError } from "./StoriesStatus.tsx";
import { ClusterCardDesktop } from "./ClusterCardDesktop.tsx";
import { ArticleFeedRowDesktop } from "./ArticleFeedRowDesktop.tsx";

const RAIL_LABEL = "font-sans text-[11px] uppercase tracking-[0.16em] text-ink3";

export function ClusterListDesktop() {
  const state = useClusterList();
  const { mode, setMode } = state;

  return (
    <div>
      <div className="flex items-end justify-between gap-6 pb-3 mb-6 border-b border-rule">
        <h1 className="font-serif text-h1 m-0">All Stories</h1>
        <div role="group" aria-label="View" className="flex items-center gap-2 font-sans text-sm">
          <ViewToggle active={mode === "feed"} onClick={() => setMode("feed")}>
            Feed
          </ViewToggle>
          <ViewToggle active={mode === "clusters"} onClick={() => setMode("clusters")}>
            Group by story
          </ViewToggle>
        </div>
      </div>

      {mode === "feed" ? <Feed state={state} /> : <Grouped state={state} />}
    </div>
  );
}

function Feed({ state }: { state: ClusterListState }) {
  const { feed, fields, activeCount, setField, clearFilters, renderMore } = state;

  if (feed.load === "loading") return <p className="text-ink3">{LOADING_EDITION}</p>;
  if (feed.load === "error") return <StoriesServerError msg={feed.err} />;
  if (feed.articles.length === 0) return <StoriesEmpty />;

  return (
    <div className="grid grid-cols-[15rem_minmax(0,1fr)] gap-10 items-start">
      <aside aria-label="Filter and sort" className="sticky top-4 font-sans">
        <div className={`${RAIL_LABEL} mb-3`}>Filter and sort</div>
        <div className="space-y-3">
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-xs">
              <span className="uppercase tracking-[0.12em] text-ink3">{f.label}</span>
              <select
                name={`stories-${f.key}`}
                value={f.value}
                onChange={(e) => setField(f.key, e.target.value)}
                className={`w-full text-sm border border-rule-strong bg-ground px-2 ${CONTROL}`}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className={`mt-3 text-sm underline decoration-1 underline-offset-2 text-ink3 hover:text-ink ${CONTROL}`}
          >
            {clearFiltersLabel(activeCount)}
          </button>
        )}
        <p className="text-xs text-ink3 mt-3 mb-0">{feed.scopeNote}</p>
      </aside>

      <div className="min-w-0">
        <p className="font-sans text-sm text-ink3 mt-0 mb-6" role="status">
          {feed.countLine}
        </p>

        {feed.matched.length === 0 ? (
          <StoriesNoMatches onClear={clearFilters} editionComplete={feed.editionComplete} total={feed.articles.length} />
        ) : (
          <ul className="space-y-6 list-none p-0 m-0">
            {feed.shown.map((a) => (
              <ArticleFeedRowDesktop key={a.id} article={a} />
            ))}
          </ul>
        )}

        {feed.remaining > 0 && (
          <div className="mt-8 flex items-center gap-4 font-sans text-sm">
            <button
              type="button"
              onClick={renderMore}
              className={`border border-ink px-6 hover:bg-ink hover:text-ground transition-colors ${CONTROL}`}
            >
              {feed.showMoreLabel}
            </button>
            <span className="text-ink3">{feed.remainingNote}</span>
          </div>
        )}
        {feed.endNote && (
          <p className="font-sans text-sm text-ink3 mt-8 border-t border-rule pt-4">{feed.endNote}</p>
        )}
      </div>
    </div>
  );
}

function Grouped({ state }: { state: ClusterListState }) {
  const { grouped, setMode } = state;

  // The note sits above every grouped state, loading and empty included: the
  // filters are ignored whatever the clusters turn out to be.
  const note = grouped.filterNote && (
    <p className="font-sans text-sm text-ink3 mt-0 mb-4 flex flex-wrap items-center gap-x-3" role="note">
      <span>{grouped.filterNote}</span>
      <button
        type="button"
        onClick={() => setMode("feed")}
        className={`underline decoration-1 underline-offset-2 text-ink ${CONTROL}`}
      >
        Back to the filtered feed
      </button>
    </p>
  );

  if (grouped.load === "loading" || grouped.load === "idle")
    return (
      <>
        {note}
        <p className="text-ink3">{GROUPING_STORIES}</p>
      </>
    );
  if (grouped.load === "error")
    return (
      <>
        {note}
        <StoriesServerError msg={grouped.err} />
      </>
    );
  if (grouped.clusters.length === 0)
    return (
      <>
        {note}
        <StoriesNoClusters />
      </>
    );

  return (
    <>
      {note}
      <p className="font-sans text-sm text-ink3 mt-0 mb-6">{grouped.countLine("Click")}</p>
      {/* items-start so a card never stretches to its neighbour's height. An
          opened card spans both columns (ClusterCardDesktop), because a half-width
          card growing to 900px beside a 340px neighbour left a tall empty block
          and pushed the next story far below the fold. */}
      <div className="grid grid-cols-2 gap-6 items-start">
        {grouped.clusters.map((c) => (
          <ClusterCardDesktop key={c.id} cluster={c} />
        ))}
      </div>
    </>
  );
}

function ViewToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-4 rounded-full transition-colors ${CONTROL} ${
        active ? "bg-ink text-ground" : "bg-ink/5 text-ink3 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
