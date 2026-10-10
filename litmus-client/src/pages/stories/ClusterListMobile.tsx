// All Stories, mobile. The first row inside the first screen: the view choice is
// one full-width segmented control, all seven filters and the sort fold into a
// single "Filter and sort" disclosure that says how many are active while
// closed, rows are the phone-composed ArticleFeedRowMobile, and "Show more" is a
// full-width thumb target. Every number, filter and list comes from
// useClusterList, shared with ClusterListDesktop.tsx.

import { useRef, type ReactNode } from "react";
import { CONTROL } from "../../components/meta.tsx";
import { GROUPING_STORIES, LOADING_EDITION, clearFiltersLabel } from "./clusterListLogic.ts";
import { useClusterList, type ClusterListState } from "./useClusterList.ts";
import { StoriesEmpty, StoriesNoClusters, StoriesNoMatches, StoriesServerError } from "./StoriesStatus.tsx";
import { ArticleFeedRowMobile } from "./ArticleFeedRowMobile.tsx";
import { ClusterCardMobile } from "./ClusterCardMobile.tsx";
import { MOBILE_SCROLL_MT } from "../../components/layout/shared.tsx";

export function ClusterListMobile() {
  const state = useClusterList();
  const { mode, setMode } = state;

  return (
    <div className="pt-3">
      <h1 className="font-serif text-[28px] leading-tight m-0">All Stories</h1>

      <div role="group" aria-label="View" className="grid grid-cols-2 mt-3 border border-ink font-sans text-[15px]">
        <Segment active={mode === "feed"} onClick={() => setMode("feed")}>
          Feed
        </Segment>
        <Segment active={mode === "clusters"} onClick={() => setMode("clusters")}>
          Group by story
        </Segment>
      </div>

      {mode === "feed" ? <Feed state={state} /> : <Grouped state={state} />}
    </div>
  );
}

function Feed({ state }: { state: ClusterListState }) {
  const { feed, fields, activeCount, setField, clearFilters, renderMore } = state;
  const disclosure = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);

  // Closing the panel is what shows the result: the count and the first rows sit
  // directly under the summary. Scroll and focus return there, because the
  // button that closed it was near the bottom of a long panel that no longer
  // exists.
  const showResults = () => {
    const d = disclosure.current;
    if (!d) return;
    d.open = false;
    d.scrollIntoView({ block: "start" });
    summary.current?.focus();
  };

  if (feed.load === "loading") return <p className="text-ink3 mt-4">{LOADING_EDITION}</p>;
  if (feed.load === "error") return <StoriesServerError msg={feed.err} compact />;
  if (feed.articles.length === 0) return <StoriesEmpty compact />;

  return (
    <>
      {/* Seven stacked selects would push the first headline below the fold.
          Folded, they cost one 44px row until they are wanted, and the summary
          still says when any are narrowing the list.
          MOBILE_SCROLL_MT clears the sticky mobile header: without
          it "Show N matching articles" scrolled the summary to y=0, under the
          header, hiding the very row and count line the button exists to reveal. */}
      <details ref={disclosure} className={`group mt-3 ${MOBILE_SCROLL_MT} border-y border-rule font-sans`}>
        <summary
          ref={summary}
          className={`list-none cursor-pointer select-none flex items-center justify-between gap-3 text-[15px] ${CONTROL}`}
        >
          <span className="flex items-center gap-2">
            <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
              ›
            </span>
            Filter and sort
            {activeCount > 0 && <span className="font-semibold">({activeCount} active)</span>}
          </span>
        </summary>
        <div className="pb-4 pt-1 space-y-3">
          {fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[12px] uppercase tracking-[0.12em] text-ink3">{f.label}</span>
              {/* 16px so iOS does not zoom the page when the select opens. */}
              <select
                name={`stories-${f.key}`}
                value={f.value}
                onChange={(e) => setField(f.key, e.target.value)}
                className={`w-full text-base border border-rule-strong bg-ground px-2 ${CONTROL}`}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {/* The result of the filters, stated at the control the reader just
              used. Without it the only feedback was the count line under all
              seven selects, about 700px up the page. */}
          <button
            type="button"
            onClick={showResults}
            className={`w-full bg-ink text-ground text-[15px] ${CONTROL}`}
          >
            {feed.showResultsLabel}
          </button>
          {activeCount > 0 && (
            <button
              type="button"
              onClick={clearFilters}
              className={`w-full border border-ink text-[15px] ${CONTROL}`}
            >
              {clearFiltersLabel(activeCount)}
            </button>
          )}
          <p className="text-[13px] text-ink3 m-0">{feed.scopeNote}</p>
        </div>
      </details>

      <p className="font-sans text-[13px] text-ink3 mt-3 mb-0" role="status">
        {feed.countLine}
      </p>

      {feed.matched.length === 0 ? (
        <StoriesNoMatches
          onClear={clearFilters}
          editionComplete={feed.editionComplete}
          total={feed.articles.length}
          compact
        />
      ) : (
        <ul className="list-none p-0 m-0">
          {feed.shown.map((a) => (
            <ArticleFeedRowMobile key={a.id} article={a} />
          ))}
        </ul>
      )}

      {feed.remaining > 0 && (
        <>
          <button
            type="button"
            onClick={renderMore}
            className="w-full min-h-[48px] mt-4 border border-rule-strong font-sans text-[15px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {feed.showMoreLabel}
          </button>
          <p className="font-sans text-[13px] text-ink3 text-center mt-2 mb-0">{feed.remainingNote}</p>
        </>
      )}
      {feed.endNote && (
        <p className="font-sans text-[13px] text-ink3 text-center mt-4 mb-0 border-t border-rule pt-3">{feed.endNote}</p>
      )}
    </>
  );
}

function Grouped({ state }: { state: ClusterListState }) {
  const { grouped, setMode } = state;

  // Above every grouped state: the filters are ignored whatever loads.
  const note = grouped.filterNote && (
    <div className="mt-3 border-l-2 border-rule-strong pl-3 font-sans" role="note">
      <p className="text-[15px] leading-snug m-0">{grouped.filterNote}</p>
      <button
        type="button"
        onClick={() => setMode("feed")}
        className={`text-[15px] underline decoration-1 underline-offset-2 ${CONTROL}`}
      >
        Back to the filtered feed
      </button>
    </div>
  );

  if (grouped.load === "loading" || grouped.load === "idle")
    return (
      <>
        {note}
        <p className="text-ink3 mt-4">{GROUPING_STORIES}</p>
      </>
    );
  if (grouped.load === "error")
    return (
      <>
        {note}
        <StoriesServerError msg={grouped.err} compact />
      </>
    );
  if (grouped.clusters.length === 0)
    return (
      <>
        {note}
        <StoriesNoClusters compact />
      </>
    );

  return (
    <>
      {note}
      <p className="font-sans text-[13px] text-ink3 mt-3 mb-3">{grouped.countLine("Tap")}</p>
      <ul className="list-none p-0 m-0 space-y-3">
        {grouped.clusters.map((c) => (
          <ClusterCardMobile key={c.id} cluster={c} />
        ))}
      </ul>
    </>
  );
}

function Segment({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-2 transition-colors ${CONTROL} ${active ? "bg-ink text-ground" : "bg-ground text-ink"}`}
    >
      {children}
    </button>
  );
}
