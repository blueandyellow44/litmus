// The mobile section front. Not the desktop spread squeezed down: the story's
// facts come first, the Map folds behind one line (its labels are unreadable at
// phone width, and every dot is also a row in The Coverage), the two tellings
// stack instead of sitting side by side, and the coverage and the rest of the
// desk are single-column lists that grow on request instead of a card grid.
// Every desktop feature is here, in a different order. Data and every derived
// value come from useSectionPage, shared with SectionPageDesktop.tsx.

import { useState } from "react";
import { Link } from "react-router-dom";
import type { SectionArticleDTO } from "../../lib/types.ts";
import { Telling } from "../../components/StorySpread.tsx";
import { TheMap } from "../../components/TheMap.tsx";
import { ClaimReceipts } from "../../components/ClaimReceipts.tsx";
import { colorForComposite } from "../../lib/phBand.ts";
import { ArticleFraming, CONTROL, FOCUS_RING, OutletBaseline, PublishedAt } from "../../components/meta.tsx";
import { useSectionPage } from "./useSectionPage.ts";
import { SectionArticleScore } from "./SectionArticleScore.tsx";
import { MOBILE_SCROLL_MT } from "../../components/layout/shared.tsx";
import {
  EMPTY_BODY,
  EMPTY_TITLE,
  LEAD_NOTE,
  PAIR_NOTE,
  articleCount,
  coverageDirection,
  leadEyebrow,
  type SectionModel,
  type SpreadModel,
} from "./sectionModel.ts";

// How many rows each list shows before "Show more". Small, because a phone
// reader scrolling past fifteen outlets to reach the rest of the desk is the
// giant grid problem in a different shape.
const COVERAGE_PAGE = 5;
const DESK_PAGE = 8;
const COVERAGE_ID = "section-coverage";

const KICKER = "font-sans text-[11px] uppercase tracking-[0.2em] text-ink3";
const RULE_HEAD = "font-sans text-[12px] uppercase tracking-[0.16em] border-b-2 border-ink pb-1";
const LINK = "underline decoration-1 underline-offset-2";

export function SectionPageMobile() {
  const state = useSectionPage();

  if (state.status === "loading") return <p className="text-ink3 pt-4">Loading…</p>;
  if (state.status === "error") {
    return (
      <div className="pt-2">
        <Link to="/" className={`font-sans text-sm text-ink3 inline-flex items-center ${CONTROL}`}>
          ← Top stories
        </Link>
        <p className="mt-2">
          Could not load this section. <span className="text-ink3">{state.message}</span>
        </p>
      </div>
    );
  }
  // Keyed by section so moving between desks resets the open Map and the
  // "show more" counts instead of carrying them to a different list.
  return <SectionBody key={state.model.section} model={state.model} />;
}

function SectionBody({ model }: { model: SectionModel }) {
  const { section, readingAs, hasLead, spread, coverage, rest, totalInSection, data } = model;

  return (
    <div className="pt-4">
      <div className="flex items-baseline justify-between gap-3 border-b-2 border-ink pb-1">
        <h1 className="font-serif text-[30px] leading-tight font-bold m-0 min-w-0">{section}</h1>
        <span className="font-sans text-[11px] uppercase tracking-[0.14em] text-ink3 shrink-0">
          {totalInSection > 0 ? articleCount(totalInSection) : "No coverage yet"}
        </span>
      </div>

      {spread && (
        <>
          <StorySummary spread={spread} section={section} />

          <MapDisclosure articles={data.articles} />

          <Tellings spread={spread} />
        </>
      )}

      {hasLead && coverage.length > 0 && (
        <section id={COVERAGE_ID} className={`mt-8 ${MOBILE_SCROLL_MT}`}>
          {/* The sort direction sits under the rule, not in it: at 375px the full
              uppercase head wrapped and orphaned "→ right" on a second line. */}
          <div className={RULE_HEAD}>The Coverage · {articleCount(coverage.length)}</div>
          <p className="font-sans text-[14px] text-ink3 mt-1.5 mb-0">Sorted {coverageDirection(readingAs)}</p>
          <ArticleList articles={coverage} pageSize={COVERAGE_PAGE} />
        </section>
      )}

      {/* Without a lead, the page header already names the section and its
          count; a second rule head saying the same would stack right under it. */}
      {rest.length > 0 && (
        <section className={hasLead ? "mt-8" : "mt-1"} aria-label={hasLead ? undefined : `${section} coverage`}>
          {hasLead && (
            <div className={RULE_HEAD}>
              More in {section} · {articleCount(rest.length)}
            </div>
          )}
          <ArticleList articles={rest} pageSize={DESK_PAGE} />
        </section>
      )}

      {!hasLead && totalInSection === 0 && (
        <div className="border border-rule px-4 py-8 text-center my-8">
          <p className="font-serif text-[22px] font-bold mb-1">{EMPTY_TITLE}</p>
          <p className="font-sans text-sm text-ink3 m-0">{EMPTY_BODY}</p>
        </div>
      )}
    </div>
  );
}

// The story first: what put it here, what happened, and the consensus reading.
function StorySummary({ spread, section }: { spread: SpreadModel; section: string }) {
  const { consensus } = spread;
  return (
    <div className="mt-4">
      <div className="font-sans text-[11px] uppercase tracking-[0.16em] text-ink2">{leadEyebrow(section)}</div>
      <h2 className="font-serif text-[26px] leading-[1.1] font-bold tracking-tight mt-1 mb-1.5">{spread.topic}</h2>
      <p className="font-sans text-[15px] leading-snug text-ink3 m-0">{LEAD_NOTE}</p>

      <div className="border-t border-b border-ink py-3 mt-4">
        <div className={`${KICKER} mb-1`}>The Facts</div>
        <p className="font-serif text-base m-0">{spread.summary}</p>
        <div className="font-sans text-[14px] text-ink3 mt-2">
          {/* "Outlets" means distinct sources; the article count is shown too
              when one publisher filed more than once. */}
          What happened, across {spread.outletCount} outlet{spread.outletCount === 1 ? "" : "s"}
          {spread.articleCount !== spread.outletCount ? ` (${spread.articleCount} articles)` : ""} covering this story
        </div>
        {/* Claim-level receipts, where this story has them. The summary above is
            a generated synthesis; these are source-linked and status-marked. */}
        <ClaimReceipts clusterId={spread.clusterId} members={spread.receiptMembers} />
      </div>

      {consensus && (
        <div className="mt-4">
          <div className="border border-rule px-3 py-2 flex items-center gap-x-2.5 gap-y-1 flex-wrap">
            <span className="font-sans text-[11px] uppercase tracking-[0.16em] text-ink3">Consensus reading</span>
            <span className="font-sans text-sm font-bold flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: colorForComposite(consensus.avg) }}
              />
              {consensus.avg.toFixed(1)} · {consensus.strip}
            </span>
          </div>
          <p className="font-serif text-sm italic border-l-2 border-rule pl-3 mt-3 mb-0 text-ink3">{consensus.reading}</p>
        </div>
      )}
    </div>
  );
}

// The Map behind a single line. At 375px the scatter's outlet labels render at
// roughly six pixels and its dots are well under a thumb, so it is offered, not
// imposed. It still draws the full chart when opened, including its own note
// about any article it could not plot.
function MapDisclosure({ articles }: { articles: SectionArticleDTO[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-5 border-y border-rule"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={`list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none flex items-center justify-between gap-3 font-sans text-[12px] uppercase tracking-[0.16em] ${CONTROL}`}
      >
        <span>The Map · This Story</span>
        <span className="normal-case tracking-normal text-[14px] text-ink3">{open ? "Hide" : "Show"}</span>
      </summary>
      <div className="pb-3">
        <p className="font-sans text-[15px] leading-snug text-ink3 mt-0 mb-2">
          Each outlet&rsquo;s coverage of this story: article framing left to right, proportionate at the bottom,
          hyperbolic at the top. Every dot is also a row in The Coverage below.
        </p>
        <TheMap articles={articles} />
      </div>
    </details>
  );
}

// The tellings, stacked. Same four cases and the same captions as the desktop
// spread; only the arrangement differs.
function Tellings({ spread }: { spread: SpreadModel }) {
  const t = spread.tellings;

  if (t.kind === "pair") {
    return (
      <div className="mt-6 pt-4 border-t border-ink">
        <div className="font-sans text-[12px] uppercase tracking-[0.18em] text-ink2 mb-1">
          Same story, two tellings
        </div>
        {/* Says what the pair IS chosen on, so the caption cannot be read as a
            promise of political breadth (Max's ruling, 2026-09-02, see
            docs/decisions/002-featured-pair-axis.md). */}
        <p className="font-sans text-[15px] leading-snug text-ink3 m-0 mb-4">{PAIR_NOTE}</p>

        <div className={`${KICKER} mb-1`}>{t.real ? "Calmest telling" : "One telling"}</div>
        <Telling a={t.left} />

        <div className="mt-6 pt-4 border-t border-rule">
          <div className={`${KICKER} mb-1`}>{t.real ? "Hottest telling" : "Another telling"}</div>
          <Telling a={t.right} />
        </div>

        {/* A pair that does not span both wings is only a coverage GAP when the
            story itself lacks a wing; otherwise the other side is in the
            coverage list, and the link takes the reader there. */}
        {t.breadthText && (
          <p className="font-sans text-[15px] leading-snug text-ink3 mt-4 mb-0 border-t border-rule pt-3">
            {t.breadthText}
            {t.breadth.kind === "pair-not-bilateral" && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() =>
                    document.getElementById(COVERAGE_ID)?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                  className={`${LINK} inline-flex items-center text-left ${CONTROL}`}
                >
                  See all coverage of this story
                </button>
              </>
            )}
          </p>
        )}
      </div>
    );
  }

  if (t.kind === "only-one") {
    // Mixed lens, but no pair exists. Say why rather than silently showing a
    // single telling that looks like the whole story.
    return (
      <div className="mt-6 pt-4 border-t border-ink">
        <div className={`${KICKER} mb-1`}>Only one telling</div>
        <p className="font-sans text-[15px] leading-snug text-ink3 mt-0 mb-4">{t.reason}</p>
        {t.lead && <Telling a={t.lead} />}
      </div>
    );
  }

  if (t.kind === "lead") {
    return (
      <div className="mt-6 pt-4 border-t border-ink">
        <Telling a={t.lead} />
      </div>
    );
  }

  return null;
}

// A single-column list of section articles that grows on request. Each row
// carries the same facts as a desktop grid card: outlet, age, headline linking
// to the full analysis, the summary, both named political readings, and P/H.
function ArticleList({ articles, pageSize }: { articles: SectionArticleDTO[]; pageSize: number }) {
  const [shown, setShown] = useState(pageSize);
  const remaining = articles.length - shown;

  return (
    <>
      <ul className="list-none p-0 m-0">
        {articles.slice(0, shown).map((a) => (
          <ArticleRow key={a.id} a={a} />
        ))}
      </ul>
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setShown((n) => n + pageSize)}
          className={`w-full min-h-[48px] mt-3 border border-rule-strong font-sans text-sm ${FOCUS_RING}`}
        >
          Show {Math.min(pageSize, remaining)} more
        </button>
      )}
      {articles.length > pageSize && (
        <p className="font-sans text-[14px] text-ink3 text-center mt-2 mb-0">
          {Math.min(shown, articles.length)} of {articles.length}
        </p>
      )}
    </>
  );
}

function ArticleRow({ a }: { a: SectionArticleDTO }) {
  return (
    <li className="py-2 border-b border-rule last:border-0">
      {/* The age sits on this line, beside the outlet, so it never wraps onto a
          second meta line in some rows and not others. */}
      <div className="font-sans text-[12px] flex items-center gap-3">
        <span className="uppercase tracking-[0.06em] text-ink3 truncate min-w-0">{a.sourceName}</span>
        <PublishedAt iso={a.publishedAt} className="text-ink3 shrink-0 whitespace-nowrap" />
        <SectionArticleScore composite={a.composite} className="shrink-0 ml-auto" />
      </div>
      {/* Fixed vertical padding rather than a centred 44px minimum: a one-line
          headline centred in 44px got more air than a two-line one, so rows had
          uneven rhythm. 10px above and below a 19px line still clears 44px. */}
      <h3 className="font-serif text-[19px] leading-snug font-bold m-0">
        <Link to={`/articles/${a.id}`} className={`block py-2.5 ${FOCUS_RING}`}>
          {a.title}
        </Link>
      </h3>
      {a.articleSummary && (
        <p className="font-sans text-[15px] leading-snug text-ink3 line-clamp-2 m-0 mb-1.5">{a.articleSummary}</p>
      )}
      {/* Both political readings, each named. They disagree often, and a reader
          shown two unlabelled words reads that as a contradiction. */}
      <div className="font-sans text-[13px] flex flex-wrap gap-x-3 gap-y-0.5">
        <OutletBaseline lean={a.sourceLean} />
        <ArticleFraming politicalLean={a.politicalLean} />
      </div>
    </li>
  );
}
