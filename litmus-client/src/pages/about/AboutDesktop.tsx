// The desktop About page: a 65ch reading column beside a sticky section index,
// so a reader deep in "What gets scored" can reach the bands without scrolling
// back. The bands are a real table, because on a wide screen range, band, and
// what it reads like line up in columns and can be compared at a glance. The
// words come from AboutCopy.tsx and the band rows from aboutContent.ts, so this
// version and AboutMobile.tsx say exactly the same things.

import { CONTROL } from "../../components/meta.tsx";
import { useActiveSection } from "./useActiveSection.ts";
import { ABOUT_SECTIONS, ABOUT_TITLE, aboutBandRows } from "./aboutContent.ts";
import { MARK_STROKE } from "../../lib/phBand.ts";
import {
  LEDE,
  NOT_A_FACT_CHECKER,
  RATING_NOT_MEASUREMENT,
  READINGS,
  READINGS_INTRO,
  SCORED_CALCULATION,
  SCORED_DIMENSIONS,
  SCORED_HOLISTIC_CHECK,
} from "./AboutCopy.tsx";

const H2 = "font-serif font-bold text-h2 border-b border-rule-strong pb-2 mt-10 mb-4 scroll-mt-6";
// Running prose on the public explainer. The size is written out rather than
// inherited from the body default: this is reference prose, which brand.md
// section 3 sets at 15-16 sans, and a page's copy should not silently resize
// when the document default moves.
const P = "font-sans text-[16px] leading-[1.55] mb-5";

// Stable across renders, so useActiveSection does not re-subscribe on every scroll update.
const SECTION_IDS = ABOUT_SECTIONS.map((s) => s.id);

function sectionTitle(id: string): string {
  return ABOUT_SECTIONS.find((s) => s.id === id)?.title ?? "";
}

export function AboutDesktop() {
  const bands = aboutBandRows();
  const activeId = useActiveSection(SECTION_IDS);

  return (
    <div className="grid grid-cols-[200px_minmax(0,65ch)] gap-12 justify-center items-start pt-8">
      <aside className="sticky top-6">
        <nav aria-label="On this page">
          <div className="font-sans text-[11px] uppercase tracking-[0.16em] text-ink3 mb-2">On this page</div>
          <ul className="list-none p-0 m-0 border-l border-rule">
            {ABOUT_SECTIONS.map((s) => {
              const current = s.id === activeId;
              return (
              <li key={s.id}>
                {/* The current entry takes a heavy ink rule over the index's hairline
                    (-ml-px sits it on top) and bold ink text; the rest stay muted. */}
                <a
                  href={`#${s.id}`}
                  aria-current={current ? "location" : undefined}
                  className={`font-sans text-sm pl-3 -ml-px border-l-2 flex items-center hover:underline underline-offset-2 ${
                    current ? "border-ink text-ink font-bold" : "border-transparent text-ink3"
                  } ${CONTROL}`}
                >
                  {s.title}
                </a>
              </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <article className="min-w-0">
        <h1 className="font-serif font-bold text-h1 border-b-2 border-ink pb-3 mb-6">{ABOUT_TITLE}</h1>

        {LEDE.map((block, i) => (
          <p key={i} className={P}>
            {block}
          </p>
        ))}

        <h2 id="readings" className={H2}>
          {sectionTitle("readings")}
        </h2>
        <p className={P}>{READINGS_INTRO}</p>
        <ul className="space-y-3 list-none p-0 mb-5">
          {READINGS.map((r) => (
            <li key={r.name}>
              <strong>{r.name}</strong> {r.body}
            </li>
          ))}
        </ul>
        <p className={P}>{RATING_NOT_MEASUREMENT}</p>

        <h2 id="bands" className={H2}>
          {sectionTitle("bands")}
        </h2>
        {/* Rows align on the first-line baseline, not the cell top: the range (14px sans)
            and the band name (18px serif) would otherwise sit about 2px apart. */}
        <table className="w-full border-collapse mb-5">
          <thead>
            <tr className="font-sans text-[11px] uppercase tracking-[0.16em] text-ink3 text-left border-b border-rule-strong">
              <th scope="col" className="font-normal py-2 pr-4 whitespace-nowrap">
                Score
              </th>
              <th scope="col" className="font-normal py-2 pr-4">
                Band
              </th>
              <th scope="col" className="font-normal py-2">
                What it reads like
              </th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => (
              <tr key={b.label} className="border-b border-rule align-baseline">
                <td className="py-3 pr-4 font-sans text-sm tabular-nums whitespace-nowrap">
                  <span
                    aria-hidden="true"
                    className="inline-block w-3 h-3 mr-2 align-baseline rounded-full"
                    // Every ramp mark carries the ink edge: the two pale steps
                    // are under 2:1 against the ground on their own.
                    style={{ backgroundColor: b.hex, boxShadow: `inset 0 0 0 1px ${MARK_STROKE}` }}
                  />
                  {b.range}
                </td>
                <th scope="row" className="py-3 pr-4 text-left font-bold whitespace-nowrap">
                  {b.label}
                </th>
                <td className="py-3">{b.description}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 id="scored" className={H2}>
          {sectionTitle("scored")}
        </h2>
        <p className={P}>{SCORED_DIMENSIONS}</p>
        <p className={P}>{SCORED_CALCULATION}</p>
        <p className={P}>{SCORED_HOLISTIC_CHECK}</p>

        <h2 id="not" className={H2}>
          {sectionTitle("not")}
        </h2>
        {NOT_A_FACT_CHECKER.map((block, i) => (
          <p key={i} className={P}>
            {block}
          </p>
        ))}

      </article>
    </div>
  );
}
