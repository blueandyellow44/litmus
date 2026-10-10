// The desktop article page: the headline across the full width, then the
// verdict beside its evidence. The left column holds what LITMUS concluded (the
// P/H badge, why, both political readings, the facts); the right column holds
// what it concluded from (the capped excerpt, its highlight key, the link out).
// The verdict column is sticky so it stays beside the passage a reader is
// checking it against. Data and derived values come from useArticleDetail.
//
// Legal posture (the excerpt policy): no full-article view and no full-article
// translation view exist here. The reader goes to the outlet for the whole piece.

import { Link } from "react-router-dom";
import { PHBadge } from "../../components/PHBadge.tsx";
import { ExcerptBlock } from "../../components/ExcerptBlock.tsx";
import { ArticleHighlightKeyDesktop } from "./ArticleHighlightKeyDesktop.tsx";
import { ArticleFraming, CONTROL, OutletBaseline, PaywallState, PublishedAt } from "../../components/meta.tsx";
import { useArticleDetail } from "./useArticleDetail.ts";
import { ARTICLE_COPY, readAtSourceLabel, type ArticleView } from "./articleView.ts";

const BACK = `font-sans text-sm text-ink3 hover:text-ink inline-flex items-center ${CONTROL}`;
const COLUMN_LABEL = "font-sans text-[11px] uppercase tracking-[0.2em] text-ink3 mb-2";

export function ArticleDetailDesktop() {
  const state = useArticleDetail();

  if (state.status === "loading") return <p className="text-ink3">{ARTICLE_COPY.loading}</p>;
  if (state.status === "error") {
    return (
      <div>
        <Link to="/" className={BACK}>
          {ARTICLE_COPY.back}
        </Link>
        <p className="mt-4">
          {ARTICLE_COPY.loadError} <span className="text-ink3">{state.message}</span>
        </p>
      </div>
    );
  }

  const { article, score, section, showPaywall, why, facts } = state.view;

  return (
    <article>
      <Link to="/" className={BACK}>
        {ARTICLE_COPY.back}
      </Link>

      <header className="mt-6 mb-8 border-b border-rule pb-6">
        <div className="font-sans text-sm text-ink3 mb-2 flex items-center gap-2 flex-wrap">
          {section && (
            <>
              <span className="uppercase tracking-[0.1em] text-[12px]">{section}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <PublishedAt iso={article.publishedAt} />
          <span aria-hidden>·</span>
          <span>{article.sourceName}</span>
          {article.author && (
            <>
              <span aria-hidden>·</span>
              <span>{article.author}</span>
            </>
          )}
          {showPaywall && (
            <>
              <span aria-hidden>·</span>
              <PaywallState paywallFlag={article.paywallFlag} extractionStatus={article.extractionStatus} />
            </>
          )}
        </div>
        <h1 className="font-serif text-[42px] leading-[1.15] tracking-[-0.02em] m-0 max-w-4xl">{article.title}</h1>
      </header>

      <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-12 items-start">
        {/* THE VERDICT */}
        <section aria-label="Verdict" className="sticky top-4 space-y-6">
          {score && (
            <div>
              <PHBadge composite={score.composite} size="lg" />
              <p className="font-sans text-sm text-ink3 mt-3 mb-0 italic">
                <span className="not-italic text-ink font-semibold">{ARTICLE_COPY.why}</span>
                {why}
              </p>
            </div>
          )}

          {/* Both political readings, each named, on the page where a reader has
              come to look at one article closely. This is the surface where the
              two are most likely to disagree visibly, so it is the one where
              leaving them unlabelled did the most damage. */}
          <div className="font-sans text-sm flex flex-col gap-1 border-t border-rule pt-4">
            <OutletBaseline lean={article.sourceLean} />
            <ArticleFraming politicalLean={score?.politicalLean ?? null} />
          </div>

          {/* THE FACTS: the scorer's just-the-facts summary. */}
          {facts && (
            <div className="border-t border-b border-ink py-2.5">
              <div className={COLUMN_LABEL}>{ARTICLE_COPY.facts}</div>
              <p className="font-serif text-base m-0">{facts}</p>
            </div>
          )}
        </section>

        {/* THE EVIDENCE */}
        <section aria-label="Evidence" className="border-l border-rule pl-12 min-w-0">
          <Evidence view={state.view} />
        </section>
      </div>
    </article>
  );
}

function Evidence({ view }: { view: ArticleView }) {
  const { article, excerpt } = view;

  // The link out is the only way to the whole piece, so it reads as the
  // column's closing action (a bordered bar in ink) rather than a muted footnote
  // a reader can scroll past after a long excerpt.
  const readAtSource = (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`w-full justify-center text-center border border-ink px-4 font-sans text-[15px] text-ink underline decoration-1 underline-offset-4 hover:bg-ink hover:text-ground inline-flex items-center ${CONTROL}`}
    >
      {readAtSourceLabel(article.sourceName)}
    </a>
  );

  if (!excerpt) {
    return (
      <div className="border border-rule p-5 max-w-prose">
        <p className="font-sans text-sm text-ink3 m-0 mb-3">{ARTICLE_COPY.noExcerpt}</p>
        {readAtSource}
      </div>
    );
  }

  return (
    <div className="max-w-prose">
      <div className="flex items-baseline justify-between gap-4 flex-wrap mb-3">
        <div className="font-sans text-xs uppercase tracking-wider text-ink3">{ARTICLE_COPY.excerptLabel}</div>
        <ArticleHighlightKeyDesktop />
      </div>
      <ExcerptBlock paragraphs={excerpt.paragraphs} markers={excerpt.markers} />
      <div className="mt-6">{readAtSource}</div>
    </div>
  );
}
