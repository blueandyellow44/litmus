// One All Stories row, composed for a phone. Same facts and the same two
// expanders as the shared ArticleFeedRow.tsx, which the desktop version keeps.
//
// Why a separate row rather than the shared one: that row switches its tap
// targets off and its type down at Tailwind's `sm` (640px), but the mobile
// version runs up to 767px and also for any reader who picks it from the footer,
// so between those widths it drew 20px buttons and 14px body text. Here every
// control is 44px and the reading text is 15px at every width.
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
  CONTROL,
  OutletBaseline,
  PaywallState,
  PublishedAt,
  paywallText,
} from "../../components/meta.tsx";

const ACTION = `font-sans text-[15px] text-ink3 inline-flex items-center ${CONTROL}`;

export function ArticleFeedRowMobile({ article }: { article: ArticleSummaryDTO }) {
  const [why, setWhy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hasExcerpt = !!article.excerpt && article.excerpt.paragraphs.length > 0;
  const verdict = article.score?.rationale?.summary;

  return (
    <li className="border-b border-rule py-4 last:border-0">
      <div className="font-sans text-[13px] text-ink3 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {article.score?.section && (
          <>
            <span className="uppercase tracking-[0.1em] text-[12px]">{article.score.section}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <PublishedAt iso={article.publishedAt} />
        <span aria-hidden>·</span>
        <span className="break-words">{article.sourceName}</span>
        {paywallText(article.paywallFlag, article.extractionStatus) && (
          <>
            <span aria-hidden>·</span>
            <PaywallState paywallFlag={article.paywallFlag} extractionStatus={article.extractionStatus} />
          </>
        )}
      </div>

      <Link to={`/articles/${article.id}`} className={`flex items-center mt-1 ${CONTROL}`}>
        {/* Full column width and never clamped: a clamp cut long headlines
            mid-title, and the whole title was only reachable by opening the
            article. The 44px floor matters for one-line headlines, which were a
            26px target. */}
        <h2 className="font-serif text-[21px] leading-[1.25] m-0">{article.title}</h2>
      </Link>

      {/* The link out shares the badge's line. Three actions in one row did not
          fit 343px at 15px, so "Original source" wrapped onto its own 44px line
          in every row, about 90px of mostly empty height per article. */}
      <div className="mt-1 flex items-center justify-between gap-3">
        {article.score ? (
          <PHBadge composite={article.score.composite} />
        ) : (
          <span className="font-sans text-[13px] text-ink3">unscored</span>
        )}
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`${ACTION} shrink-0 underline decoration-1 underline-offset-2`}
        >
          Original source ↗
        </a>
      </div>

      {/* The NEUTRAL summary of what the article reports, not the scorer's
          verdict on it. The verdict stays under "Why this score", labelled as a
          verdict, so the position a newspaper gives the story never carries
          LITMUS's opinion of it. */}
      {article.score?.articleSummary ? (
        <p className="font-sans text-[15px] leading-relaxed mt-2 mb-0">{article.score.articleSummary}</p>
      ) : article.score ? (
        <p className="font-sans text-[15px] text-ink3 italic mt-2 mb-0">No neutral summary was recorded for this article.</p>
      ) : null}

      <div className="mt-2 font-sans text-[13px] flex flex-wrap gap-x-4 gap-y-0.5">
        <OutletBaseline lean={article.sourceLean} />
        <ArticleFraming politicalLean={article.score?.politicalLean ?? null} />
      </div>

      {(verdict || hasExcerpt) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-5">
          {verdict && (
            <button type="button" onClick={() => setWhy((v) => !v)} className={ACTION} aria-expanded={why}>
              {why ? "Hide why this score" : "Why this score"}
            </button>
          )}
          {hasExcerpt && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className={ACTION} aria-expanded={expanded}>
              {expanded ? "Hide excerpt" : "Show excerpt"}
            </button>
          )}
        </div>
      )}

      {why && verdict && (
        <p className="mt-1 mb-0 font-sans text-[15px] text-ink3 italic border-l-2 border-rule pl-3">
          <span className="not-italic text-ink font-semibold">Why this score: </span>
          {verdict}
        </p>
      )}

      {expanded && hasExcerpt && (
        <div className="mt-2 border-l-2 border-rule pl-3">
          <ExcerptBlock paragraphs={article.excerpt!.paragraphs} markers={article.excerpt!.markers} />
          <div className="mt-3">
            <HighlightLegend />
          </div>
        </div>
      )}
    </li>
  );
}
