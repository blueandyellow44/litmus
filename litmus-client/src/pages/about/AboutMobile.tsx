// The mobile About page: one column, a jump menu of thumb-sized buttons under
// the title, and the band table as stacked rows (a four-column table does not
// fit 375px without shrinking the description below a readable size). The
// floor arithmetic in "What gets scored" folds behind a disclosure because it is
// the longest paragraph on the page and the reference a reader goes to on
// purpose; it is folded, not dropped. The "rating, not a measurement" paragraph
// is never folded. Words come from AboutCopy.tsx and bands from aboutContent.ts,
// shared with AboutDesktop.tsx.

import { CONTROL } from "../../components/meta.tsx";
import { ABOUT_SECTIONS, ABOUT_TITLE, aboutBandRows } from "./aboutContent.ts";
import { MOBILE_SCROLL_MT } from "../../components/layout/shared.tsx";
import { MARK_STROKE } from "../../lib/phBand.ts";
import {
  LEDE,
  NOT_A_FACT_CHECKER,
  RATING_NOT_MEASUREMENT,
  READINGS,
  READINGS_INTRO,
  SCORED_CALCULATION,
  SCORED_CALCULATION_SUMMARY,
  SCORED_DIMENSIONS,
  SCORED_HOLISTIC_CHECK,
} from "./AboutCopy.tsx";

// scroll-mt clears the sticky mobile header (wordmark row plus section strip) so
// a jumped-to heading is not hidden under it. The number lives with the header.
const H2 = `font-serif font-bold text-h3 border-b border-rule pb-2 mt-8 mb-3 ${MOBILE_SCROLL_MT}`;
// Running prose on the public explainer. The size is written out rather than
// inherited from the body default: this is reference prose, which brand.md
// section 3 sets at 15-16 sans, and a page's copy should not silently resize
// when the document default moves.
const P = "font-sans text-[16px] leading-[1.55] mb-4";

// The jump menu's anchor. Desktop keeps its "On this page" index sticky beside
// the article; a sticky menu would eat too much of a 375px screen, so mobile
// instead ends each section with a link back to the menu. Same feature, folded.
const SECTIONS_ANCHOR = "about-sections";

function sectionTitle(id: string): string {
  return ABOUT_SECTIONS.find((s) => s.id === id)?.title ?? "";
}

function BackToSections() {
  return (
    <p className="mb-2 -mt-1">
      <a
        href={`#${SECTIONS_ANCHOR}`}
        className={`inline-flex items-center gap-1 font-sans text-[15px] text-ink3 underline underline-offset-2 ${CONTROL}`}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 10l5-5 5 5" />
        </svg>
        Back to sections
      </a>
    </p>
  );
}

export function AboutMobile() {
  const bands = aboutBandRows();

  return (
    <article className="pt-4">
      <h1 className="font-serif font-bold text-[30px] leading-tight border-b-2 border-ink pb-2 mb-3">{ABOUT_TITLE}</h1>

      <nav id={SECTIONS_ANCHOR} aria-label="On this page" className={`mb-5 ${MOBILE_SCROLL_MT}`}>
        <ul className="list-none p-0 m-0 grid grid-cols-2 gap-2">
          {ABOUT_SECTIONS.map((s) => (
            <li key={s.id} className="min-w-0">
              <a
                href={`#${s.id}`}
                className={`w-full px-3 border border-rule-strong font-sans text-[15px] leading-tight flex items-center ${CONTROL}`}
              >
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {LEDE.map((block, i) => (
        <p key={i} className={P}>
          {block}
        </p>
      ))}

      <h2 id="readings" className={H2}>
        {sectionTitle("readings")}
      </h2>
      <p className={P}>{READINGS_INTRO}</p>
      <ul className="list-none p-0 mb-4 space-y-4">
        {READINGS.map((r) => (
          <li key={r.name} className="border-l-2 border-ink pl-3">
            <strong className="block">{r.name}</strong>
            {r.body}
          </li>
        ))}
      </ul>
      <p className={P}>{RATING_NOT_MEASUREMENT}</p>
      <BackToSections />

      <h2 id="bands" className={H2}>
        {sectionTitle("bands")}
      </h2>
      <ul className="list-none p-0 m-0 mb-4">
        {bands.map((b) => (
          <li key={b.label} className="border-b border-rule py-3 flex items-stretch gap-3">
            {/* The band mark, drawn the way the desktop swatch is: the fill
                carries the ink edge on every side. Without it, Practical
                (#C0C9CE) measures 1.48:1 against the ground and the mark is
                effectively invisible. phBand.ts states the rule; a coloured
                border-left could not satisfy it, because a border cannot also
                hold an inset shadow. */}
            <span aria-hidden="true" className="w-1.5 shrink-0 rounded-[1px]" style={{ backgroundColor: b.hex, boxShadow: `inset 0 0 0 1px ${MARK_STROKE}` }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <strong>{b.label}</strong>
                <span className="font-sans text-[15px] tabular-nums text-ink3 whitespace-nowrap">{b.range}</span>
              </div>
              <div>{b.description}</div>
            </div>
          </li>
        ))}
      </ul>
      <BackToSections />

      <h2 id="scored" className={H2}>
        {sectionTitle("scored")}
      </h2>
      <p className={P}>{SCORED_DIMENSIONS}</p>
      {/* A flex summary loses the native disclosure triangle in Chromium, so the
          marker is drawn here: a chevron that points down closed and flips up open.
          list-none and the webkit marker rule stop Safari drawing a second one. */}
      <details className="group mb-4 border-y border-rule">
        <summary
          className={`cursor-pointer select-none font-sans text-[15px] flex items-center justify-between gap-3 list-none [&::-webkit-details-marker]:hidden ${CONTROL}`}
        >
          <span>{SCORED_CALCULATION_SUMMARY}</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="w-4 h-4 shrink-0 transition-transform group-open:rotate-180"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3 6l5 5 5-5" />
          </svg>
        </summary>
        <p className="pb-3 m-0">{SCORED_CALCULATION}</p>
      </details>
      <p className={P}>{SCORED_HOLISTIC_CHECK}</p>
      <BackToSections />

      <h2 id="not" className={H2}>
        {sectionTitle("not")}
      </h2>
      {NOT_A_FACT_CHECKER.map((block, i) => (
        <p key={i} className={P}>
          {block}
        </p>
      ))}
      <BackToSections />
    </article>
  );
}
