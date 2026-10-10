// The desktop left rail: wordmark, tagline, edition record, reference nav,
// and the two reading keys — sticky beside the feed rather than a horizontal
// header above it. Matches the approved Quiet Reader mock's .shell/.rail
// structure (design/rebrand-2026-09-13/quiet-reader/front-desktop.html)
// exactly on spacing and type scale; TAGLINE is the ruled copy
// (lib/brand.ts), not the mock's forbidden "how it's being bent" line.

import { NavLink } from "react-router-dom";
import { TAGLINE } from "../../lib/brand.ts";
import { PH_BANDS } from "../../lib/phBand.ts";
import { HighlightLegend } from "../ExcerptBlock.tsx";
import { CONTROL, FOCUS_RING } from "../meta.tsx";
import { DeviceSwitch } from "../DeviceSwitch.tsx";
import { Wordmark } from "../Wordmark.tsx";
import { Byline } from "../story/Byline.tsx";
import { EditionNotice, LEGAL_HREF, SECTION_LINKS, editionLine, useEditionStatus, useSectionActive } from "./shared.tsx";

const REF_LINK = `block font-sans text-[14px] font-medium text-ink no-underline py-[9px] hover:underline hover:decoration-1 hover:underline-offset-4 ${FOCUS_RING} ${CONTROL}`;
const REF_LINK_ACTIVE = "text-ink font-semibold";
const MICRO = "font-sans text-[11.5px] font-semibold uppercase tracking-[0.12em] text-ink3";

export function Rail() {
  const edition = useEditionStatus();
  const sectionActive = useSectionActive();

  return (
    <header className="sticky top-0 self-start h-screen overflow-auto flex flex-col gap-[26px] pt-10 pb-8">
      <div>
        <Wordmark />
        <p className="font-serif text-xl leading-[1.35] text-ink -mt-1.5 mb-0">{TAGLINE}</p>
      </div>

      <div className="grid gap-1 font-sans text-[13.5px] leading-[1.45] text-ink2">
        <span className="font-semibold text-ink">{editionLine(edition)}</span>
        {edition && edition.state !== "fresh" && <EditionNotice edition={edition} />}
      </div>

      <nav aria-label="Sections" className="grid gap-0.5 border-t border-rule pt-3.5">
        {SECTION_LINKS.map((s) => (
          <NavLink
            key={s.to}
            to={s.to}
            end={s.end}
            className={({ isActive }) => `${REF_LINK} ${sectionActive(s, isActive) ? REF_LINK_ACTIVE : ""}`}
          >
            {s.label}
          </NavLink>
        ))}
      </nav>

      <div className="grid gap-3.5 border-t border-rule pt-4">
        <p className={MICRO}>P/H scale</p>
        <ol className="grid gap-1.5 font-sans text-[13px] text-ink2">
          {PH_BANDS.map((b, i) => (
            <li key={b.label} className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block w-[11px] h-[11px] rounded-full shrink-0"
                style={{ backgroundColor: b.hex, boxShadow: "inset 0 0 0 1px rgba(30,31,34,.5)" }}
              />
              <b className="font-semibold text-ink tabular-nums w-2">{i + 1}</b> {b.label}
            </li>
          ))}
        </ol>
        <HighlightLegend />
      </div>

      <div className="mt-auto grid gap-2">
        <nav aria-label="Reference" className="grid gap-0.5 border-t border-rule pt-3.5 mb-1">
          <NavLink to="/about" className={REF_LINK}>How it works</NavLink>
          <NavLink to="/sources" className={REF_LINK}>Sources</NavLink>
          <a href={LEGAL_HREF} className={REF_LINK}>Legal &amp; AI disclosure</a>
        </nav>
        <div className="flex items-center gap-3">
          <Byline />
          <DeviceSwitch />
        </div>
      </div>
    </header>
  );
}
