// One All Stories row, composed for the desktop feed column. Same facts and the
// same two expanders as the shared ArticleFeedRow.tsx and ArticleFeedRowMobile.tsx.
//
// Why a separate row rather than the shared one: that row's actions were bare
// 24px grey text whose only hover cue was a colour shift, so "Why this score"
// and "Show excerpt" read as captions rather than controls (the same problem
// ClusterCardDesktop fixed for "Show articles"). And it clamped the headline to
// two lines, cutting long titles mid-word with the full title reachable only by
// opening the article. Here the actions are bordered 36px pills, a mouse-sized
// target that still looks pressable, and the headline is never clamped.
//
// Legal: the row shows the capped excerpt the snapshot carries, never article
// text beyond it, and always links out to the outlet's own page.

import { useState } from "react";
import { Link } from "react-router-dom";
import type { ArticleSummaryDTO } from "../../lib/types.ts";
import { PHBadge } from "../../components/PHBadge.tsx";
import { ExcerptBlock, HighlightLegend } from "../../components/ExcerptBlock.tsx";
import {
  ArticleFraming,
  FOCUS_RING,
  OutletBaseline,
  PaywallState,
  PublishedAt,
  paywallText,
} from "../../components/meta.tsx";

const ACTION = `inline-flex items-center gap-1.5 min-h-9 px-3.5 rounded-full border border-rule-strong font-sans text-sm text-ink hover:border-ink hover:bg-ink hover:text-ground transition-colors ${FOCUS_RING}`;

function Chevron({ open }: { open: boolean }) {
  return (
    <span aria-hidden className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
      ›
    </span>
  );
}

export function ArticleFeedRowDesktop({ article }: { article: ArticleSummaryDTO }) {
  const [why, setWhy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hasExcerpt = !!article.excerpt && article.excerpt.paragraphs.length > 0;
  const verdict = article.score?.rationale?.summary;

  return (
    <li className="border-b border-rule pb-6 last:border-0">
      {/* The badge sits on the meta line so the headline below spans the whole
          column instead of being squeezed by a side column. */}
      <div className="flex items-center justify-between gap-4 mb-1.5">
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
        <div className="shrink-0">
          {article.score ? (
            <PHBadge composite={article.score.composite} />
          ) : (
            <span className="font-sans text-xs text-ink3">unscored</span>
          )}
        </div>
      </div>

      <Link to={`/articles/${article.id}`} className={`block group ${FOCUS_RING}`}>
        <h2 className="font-serif text-h2 m-0 group-hover:underline decoration-1 underline-offset-4">{article.title}</h2>
      </Link>

      {/* The NEUTRAL summary of what the article reports, not the scorer's
          verdict on it. The verdict stays under "Why this score", labelled as a
          verdict, so the position a newspaper gives the story never carries
          LITMUS's opinion of it. */}
      {article.score?.articleSummary ? (
        <p className="font-sans text-base leading-relaxed mt-2 mb-0 max-w-prose">{article.score.articleSummary}</p>
      ) : article.score ? (
        <p className="font-sans text-sm text-ink3 italic mt-2 mb-0">No neutral summary was recorded for this article.</p>
      ) : null}

      <div className="mt-2 font-sans text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
        <OutletBaseline lean={article.sourceLean} />
        <ArticleFraming politicalLean={article.score?.politicalLean ?? null} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {verdict && (
          <button type="button" onClick={() => setWhy((v) => !v)} className={ACTION} aria-expanded={why}>
            <Chevron open={why} />
            {why ? "Hide why this score" : "Why this score"}
          </button>
        )}
        {hasExcerpt && (
          <button type="button" onClick={() => setExpanded((v) => !v)} className={ACTION} aria-expanded={expanded}>
            <Chevron open={expanded} />
            {expanded ? "Hide excerpt" : "Show excerpt"}
          </button>
        )}
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center min-h-9 px-2 font-sans text-sm text-ink underline decoration-1 underline-offset-2 hover:decoration-2 ${FOCUS_RING}`}
        >
          Original source ↗
        </a>
      </div>

      {why && verdict && (
        <p className="mt-3 mb-0 font-sans text-sm text-ink3 italic border-l-2 border-rule pl-4 max-w-prose">
          <span className="not-italic text-ink font-semibold">Why this score: </span>
          {verdict}
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
