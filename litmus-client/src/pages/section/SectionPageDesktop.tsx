// The desktop section front: the section's trending story as the full LITMUS
// spread (StorySpread): The Facts and the Map side by side, then the calmest and
// hottest tellings in two columns. Below it, The Coverage and More in <section>
// as ruled multi-column grids, because a wide screen can hold every outlet's take
// at a glance. "Reading as" reorders the coverage; it never hides any of it. Data
// and every derived value come from useSectionPage, shared with the mobile version.

import { Link } from "react-router-dom";
import type { SectionArticleDTO } from "../../lib/types.ts";
import { StorySpread } from "../../components/StorySpread.tsx";
import { ArticleFraming, FOCUS_RING, OutletBaseline, PublishedAt } from "../../components/meta.tsx";
import { useSectionPage } from "./useSectionPage.ts";
import { SectionArticleScore } from "./SectionArticleScore.tsx";
import { EMPTY_BODY, EMPTY_TITLE, LEAD_NOTE, articleCount, coverageDirection, leadEyebrow } from "./sectionModel.ts";

const RULE_HEAD = "font-sans text-xs uppercase tracking-[0.2em] border-b-2 border-ink pb-1";

export function SectionPageDesktop() {
  const state = useSectionPage();

  if (state.status === "loading") return <p className="text-ink3">Loading…</p>;
  if (state.status === "error") {
    return (
      <div>
        <Link to="/" className={`font-sans text-sm text-ink3 hover:text-ink ${FOCUS_RING}`}>
          ← Top stories
        </Link>
        <p className="mt-4">
          Could not load this section. <span className="text-ink3">{state.message}</span>
        </p>
      </div>
    );
  }

  const { data, section, readingAs, hasLead, coverage, rest, totalInSection } = state.model;

  return (
    <div>
      <div className="flex items-baseline justify-between border-b-2 border-ink pb-1.5 mb-5">
        {/* h1, not h2: the section is the page's subject, and a desk with no
            lead story would otherwise have no h1 at all. StorySpread's own title
            is also an h1 (shared component, left as is), so the order is never
            inverted, only doubled when a lead exists. */}
        <h1 className="font-serif text-h2 font-bold m-0">{section}</h1>
        <span className="font-sans text-xs uppercase tracking-[0.16em] text-ink3">
          {totalInSection > 0 ? articleCount(totalInSection) : "No coverage yet"}
        </span>
      </div>

      {/* The desk's lead: the section's trending story as the full spread. Only
          renders when several outlets covered the same story here. */}
      {hasLead && <StorySpread data={data} eyebrow={leadEyebrow(section)} eyebrowNote={LEAD_NOTE} />}

      {/* The trending story's outlets, sorted across the spectrum. */}
      {hasLead && coverage.length > 0 && (
        <section className="mt-8">
          <div className={RULE_HEAD}>
            The Coverage · {articleCount(coverage.length)}, sorted {coverageDirection(readingAs)}
          </div>
          <ArticleGrid articles={coverage} />
        </section>
      )}

      {/* The rest of the desk. With a lead story this is "more in the section";
          without one it IS the section, and it is what keeps a desk with real
          coverage from showing an empty page. */}
      {/* Without a lead, the page header above already names the section and its
          count, so repeating them as a rule head would say the same thing twice. */}
      {rest.length > 0 && (
        <section className={hasLead ? "mt-8" : ""} aria-label={hasLead ? undefined : `${section} coverage`}>
          {hasLead && (
            <div className={RULE_HEAD}>
              More in {section} · {articleCount(rest.length)}
            </div>
          )}
          {/* With a lead, the rule head's border sits flush above the grid. Without
              one the grid starts below the page header's gap, so it draws its own
              top rule or the first row hangs open. */}
          <ArticleGrid articles={rest} ruledTop={!hasLead} />
        </section>
      )}

      {/* Genuinely empty: no lead story and nothing scored in the section. */}
      {!hasLead && totalInSection === 0 && (
        <div className="border border-rule px-8 py-10 text-center max-w-prose mx-auto my-10">
          <p className="font-serif text-h3 font-bold mb-1">{EMPTY_TITLE}</p>
          <p className="font-sans text-sm text-ink3 m-0">{EMPTY_BODY}</p>
        </div>
      )}
    </div>
  );
}

// A ruled grid of section stories, each linking to its full analysis. Shared by
// "The Coverage" (the lead story's outlets) and "More in {Section}" (the desk).
// The ruling is drawn by each card's own right and bottom borders, not by a
// gap-px over a rule-coloured background: that trick paints every unused tail
// cell solid rule colour whenever the count is not a multiple of the columns,
// which reads as a missing card. With per-card borders the tail is plain paper.
function ArticleGrid({ articles, ruledTop = false }: { articles: SectionArticleDTO[]; ruledTop?: boolean }) {
  return (
    <div className={`grid grid-cols-2 lg:grid-cols-3 border-l border-rule ${ruledTop ? "border-t" : ""}`}>
      {articles.map((a) => (
        <div key={a.id} className="bg-ground px-4 py-3 border-r border-b border-rule">
          <div className="font-sans text-[11px] text-ink3 flex justify-between gap-2 flex-wrap">
            <span className="uppercase tracking-[0.06em]">{a.sourceName}</span>
            <PublishedAt iso={a.publishedAt} />
          </div>
          <h4 className="font-serif text-h3 font-bold leading-snug my-1.5">
            <Link to={`/articles/${a.id}`} className={`hover:underline ${FOCUS_RING}`}>
              {a.title}
            </Link>
          </h4>
          {a.articleSummary && (
            <p className="font-sans text-sm text-ink3 line-clamp-2 m-0 mb-1.5" title={a.articleSummary}>
              {a.articleSummary}
            </p>
          )}
          {/* Both political readings, each named. They disagree often, and a
              reader shown two unlabelled words reads that as a contradiction. */}
          <div className="font-sans text-xs flex flex-col gap-0.5">
            <OutletBaseline lean={a.sourceLean} />
            <div className="flex justify-between gap-2">
              <ArticleFraming politicalLean={a.politicalLean} />
              <SectionArticleScore composite={a.composite} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
