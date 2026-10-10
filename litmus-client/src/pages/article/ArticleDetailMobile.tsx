// The mobile article page: one reading column, verdict first, then evidence.
// The meta line is compacted to two short lines, the two political readings
// sit as a labelled pair a thumb-width wide, the highlight key comes BEFORE the
// excerpt (a phone reader meets the colours before they need to decode them),
// and the link out to the outlet is a full-width bar pinned to the bottom of the
// screen while the article is in view. Data and derived values come from
// useArticleDetail, so this and ArticleDetailDesktop.tsx always agree.
//
// Legal posture (the excerpt policy): no full-article view and no full-article
// translation view exist here. The reader goes to the outlet for the whole piece.

import { Link } from "react-router-dom";
import { PHBadge } from "../../components/PHBadge.tsx";
import { ExcerptBlock } from "../../components/ExcerptBlock.tsx";
import { ArticleFraming, CONTROL, OutletBaseline, PaywallState, PublishedAt } from "../../components/meta.tsx";
import { useArticleDetail } from "./useArticleDetail.ts";
import { ARTICLE_COPY, readAtSourceLabel } from "./articleView.ts";
import { ArticleHighlightKeyMobile } from "./ArticleHighlightKeyMobile.tsx";

const BACK = `font-sans text-[15px] text-ink3 inline-flex items-center ${CONTROL}`;
const LABEL = "font-sans text-[11px] uppercase tracking-[0.18em] text-ink3 mb-1.5";

export function ArticleDetailMobile() {
  const state = useArticleDetail();

  if (state.status === "loading") return <p className="text-ink3 pt-4">{ARTICLE_COPY.loading}</p>;
  if (state.status === "error") {
    return (
      <div className="pt-2">
        <Link to="/" className={BACK}>
          {ARTICLE_COPY.back}
        </Link>
        <p className="mt-3">
          {ARTICLE_COPY.loadError} <span className="text-ink3">{state.message}</span>
        </p>
      </div>
    );
  }

  const { article, score, section, showPaywall, why, facts, excerpt } = state.view;

  return (
    <article className="pt-1">
      <Link to="/" className={BACK}>
        {ARTICLE_COPY.back}
      </Link>

      {/* Compact meta: where it sits and when on one line, who wrote it on the
          next. Every field the desktop line carries is still here. */}
      <div className="font-sans text-[13px] text-ink3 mt-2 mb-2 leading-snug break-words">
        <div className="flex items-center gap-1.5 flex-wrap">
          {section && (
            <>
              <span className="uppercase tracking-[0.1em] text-[11px]">{section}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <PublishedAt iso={article.publishedAt} />
          {showPaywall && (
            <>
              <span aria-hidden>·</span>
              <PaywallState paywallFlag={article.paywallFlag} extractionStatus={article.extractionStatus} />
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-ink">{article.sourceName}</span>
          {article.author && (
            <>
              <span aria-hidden>·</span>
              <span>{article.author}</span>
            </>
          )}
        </div>
      </div>

      <h1 className="font-serif text-[27px] leading-[1.2] tracking-[-0.015em] mb-5 break-words">{article.title}</h1>

      {/* THE VERDICT */}
      <section aria-label="Verdict" className="border-t border-rule pt-4">
        {score && (
          <div className="mb-4">
            <PHBadge composite={score.composite} size="lg" />
            <p className="font-sans text-[15px] text-ink3 mt-3 mb-0 italic">
              <span className="not-italic text-ink font-semibold">{ARTICLE_COPY.why}</span>
              {why}
            </p>
          </div>
        )}

        {/* Both political readings, each named, on the page where a reader has
            come to look at one article closely. This is the surface where the
            two are most likely to disagree visibly, so it is the one where
            leaving them unlabelled did the most damage. Stacked, so neither
            label wraps into the other on a narrow screen. */}
        <div className="font-sans text-[15px] flex flex-col gap-1 mb-5">
          <OutletBaseline lean={article.sourceLean} />
          <ArticleFraming politicalLean={score?.politicalLean ?? null} />
        </div>

        {/* THE FACTS: the scorer's just-the-facts summary, above the excerpt. */}
        {facts && (
          <div className="border-t border-b border-ink py-2.5 mb-6">
            <div className={LABEL}>{ARTICLE_COPY.facts}</div>
            <p className="font-serif text-base m-0">{facts}</p>
          </div>
        )}
      </section>

      {/* THE EVIDENCE */}
      <section aria-label="Evidence" className="mb-4">
        {excerpt ? (
          <>
            <div className={LABEL}>{ARTICLE_COPY.excerptLabel}</div>
            <div className="mb-4">
              <ArticleHighlightKeyMobile />
            </div>
            <ExcerptBlock paragraphs={excerpt.paragraphs} markers={excerpt.markers} className="break-words" />
          </>
        ) : (
          <div className="border border-rule p-4">
            <p className="font-sans text-[15px] text-ink3 m-0">{ARTICLE_COPY.noExcerpt}</p>
          </div>
        )}
      </section>

      {/* The link out, pinned to the bottom while the article is on screen and
          released above the footer. It is the one way to the whole piece, so on
          a phone it is always within thumb reach, in both the excerpt and the
          no-excerpt state. The negative side margin spans the shell's side
          padding. Kept to the 44px tap floor with no top padding: the shell
          header is also sticky, and every pixel of pinned chrome comes out of the
          excerpt. The bar's top edge is a fade into paper rather than a hairline
          rule, so the excerpt line passing under it dissolves instead of reading
          as a line sliced in half.
          -mb-8 cancels LayoutMobile's main pb-8 so that when the bar releases at
          the end of the page it sits on the shell's footer spacing, not on a
          stray band of empty paper; if that padding changes, change this too. */}
      <div className="sticky bottom-0 z-10 -mx-4 -mb-8 px-4 pb-[max(0.25rem,env(safe-area-inset-bottom))] bg-ground">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-full h-5 bg-gradient-to-t from-ground to-ground/0" />
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`w-full justify-center text-center border border-ink font-sans text-[15px] text-ink underline decoration-1 underline-offset-4 inline-flex items-center px-3 break-words ${CONTROL}`}
        >
          {readAtSourceLabel(article.sourceName)}
        </a>
      </div>
    </article>
  );
}
