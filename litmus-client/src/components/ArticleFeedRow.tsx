// One row in the "All Stories" feed. Section and time, source, paywall state,
// headline, the NEUTRAL facts summary, both political readings, and the P/H
// badge. Two expanders: the scorer's verdict ("Why this score") and the
// highlighted excerpt — rendered from the excerpt the server prebuilt into the
// summary, so expansion needs no extra request.

import { useState } from "react";
import { Link } from "react-router-dom";
import type { ArticleSummaryDTO } from "../lib/types.ts";
import { PHBadge } from "./PHBadge.tsx";
import { ExcerptBlock, HighlightLegend } from "./ExcerptBlock.tsx";
import { ArticleFraming, FOCUS_RING, OutletBaseline, PaywallState, PublishedAt, paywallText } from "./meta.tsx";

interface Props {
  article: ArticleSummaryDTO;
}

export function ArticleFeedRow({ article }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [why, setWhy] = useState(false);
  const hasExcerpt = !!article.excerpt && article.excerpt.paragraphs.length > 0;

  return (
    <li className="border-b border-rule pb-6 last:border-0">
      {/* Meta line carries the P/H badge, so the headline below spans the full
          column width instead of being squeezed by a side column. On a phone a
          side badge left the headline breaking one or two words per line. */}
      {/* Stacked on a phone, one row from sm up. Side by side at 375px the meta
          line wrapped AROUND the badge and stranded a separator dot on its own
          line. */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-x-3 gap-y-1.5 mb-1.5">
        <div className="font-sans text-sm text-ink3 flex items-center gap-2 flex-wrap min-w-0">
          {article.score?.section && (
            <>
              <span className="uppercase tracking-[0.1em] text-[12px]">{article.score.section}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <PublishedAt iso={article.publishedAt} />
          <span aria-hidden>·</span>
          <span>{article.sourceName}</span>
          {paywallText(article.paywallFlag, article.extractionStatus) && (
            <>
              <span aria-hidden>·</span>
              <PaywallState paywallFlag={article.paywallFlag} extractionStatus={article.extractionStatus} />
            </>
          )}
        </div>
        <div className="shrink-0 self-start">
          {article.score ? (
            <PHBadge composite={article.score.composite} />
          ) : (
            <span className="font-sans text-xs text-ink3">unscored</span>
          )}
        </div>
      </div>

      <Link to={`/articles/${article.id}`} className="block group">
        {/* Steps down to 22px on phones so a long headline reads as a headline,
            not a stack of single words; full 28px from sm up. Capped at two
            lines so a row keeps a predictable height in a long feed. */}
        <h2 className="font-serif text-h3 sm:text-h2 line-clamp-2 group-hover:underline decoration-1 underline-offset-4">
          {article.title}
        </h2>
      </Link>

      {/* The NEUTRAL summary of what the article reports, not the scorer's
          verdict on it.

          This row used to preview `rationale.summary`, which is the one-sentence
          judgement explaining the P/H score — evaluative by construction. A
          reader scanning the feed was therefore reading LITMUS's opinion of each
          story in the position where a newspaper puts the story. The verdict is
          still here, under "Why this score", where it is labelled as a verdict. */}
      {article.score?.articleSummary ? (
        <p className="font-sans text-sm mt-1.5">{article.score.articleSummary}</p>
      ) : article.score ? (
        <p className="font-sans text-sm text-ink3 mt-1.5 italic">No neutral summary was recorded for this article.</p>
      ) : null}

      <div className="mt-2 font-sans text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
        <OutletBaseline lean={article.sourceLean} />
        <ArticleFraming politicalLean={article.score?.politicalLean ?? null} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {article.score?.rationale?.summary && (
          <button
            onClick={() => setWhy((v) => !v)}
            className={`font-sans text-sm text-ink3 hover:text-ink transition-colors min-h-[44px] sm:min-h-0 py-2 sm:py-0 ${FOCUS_RING}`}
            aria-expanded={why}
          >
            {why ? "Hide why this score" : "Why this score"}
          </button>
        )}
        {hasExcerpt && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className={`font-sans text-sm text-ink3 hover:text-ink transition-colors min-h-[44px] sm:min-h-0 py-2 sm:py-0 ${FOCUS_RING}`}
            aria-expanded={expanded}
          >
            {expanded ? "Hide excerpt" : "Show excerpt"}
          </button>
        )}
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`font-sans text-sm text-ink3 hover:text-ink underline decoration-1 underline-offset-2 min-h-[44px] sm:min-h-0 py-2 sm:py-0 inline-flex items-center ${FOCUS_RING}`}
        >
          Original source ↗
        </a>
      </div>

      {why && article.score?.rationale?.summary && (
        <p className="mt-2 font-sans text-sm text-ink3 italic border-l-2 border-rule pl-4">
          <span className="not-italic text-ink font-semibold">Why this score: </span>
          {article.score.rationale.summary}
        </p>
      )}

      {expanded && hasExcerpt && (
        <div className="mt-3 border-l-2 border-rule pl-4">
          <ExcerptBlock paragraphs={article.excerpt!.paragraphs} markers={article.excerpt!.markers} />
          <div className="mt-3">
            <HighlightLegend />
          </div>
        </div>
      )}
    </li>
  );
}
