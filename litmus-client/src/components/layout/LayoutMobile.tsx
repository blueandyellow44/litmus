// The mobile page shell. Not the desktop version squeezed down: a compact sticky
// header with the wordmark and the edition date, one horizontally scrolling
// section strip, and the less-used controls (reference pages, the version
// switch) moved to the footer where a thumb reaches them after reading rather
// than before. Shares its pieces with LayoutDesktop.tsx through ./shared.tsx.
//
// The header's height is MOBILE_HEADER_PX in ./shared.tsx. Pages that pin a
// heading below it read that, so this file is the only place the number moves.

import { NavLink, Outlet } from "react-router-dom";
import { TAGLINE } from "../../lib/brand.ts";
import { CONTROL, FOCUS_RING } from "../meta.tsx";
import { DeviceSwitch } from "../DeviceSwitch.tsx";
import { Wordmark } from "../Wordmark.tsx";
import { Byline } from "../story/Byline.tsx";
import { EditionNotice, LEGAL_HREF, SECTION_LINKS, editionLine, useEditionStatus, useSectionActive } from "./shared.tsx";

const sectionLinkClass = ({ isActive }: { isActive: boolean }) =>
  `font-sans text-[14px] px-3 inline-flex items-center whitespace-nowrap ${CONTROL} ${FOCUS_RING} ${
    isActive ? "text-ink font-semibold border-b-2 border-ink" : "text-ink3 border-b-2 border-transparent"
  }`;

const FOOTER_LINK = `underline decoration-1 underline-offset-2 decoration-rule inline-flex items-center ${CONTROL}`;

export function LayoutMobile() {
  const edition = useEditionStatus();
  const sectionActive = useSectionActive();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-20 bg-ground border-b border-rule">
        <div className="px-4 py-1 flex items-center justify-between gap-3">
          <Wordmark className="min-h-[44px]" />
          <span className="font-sans text-[12px] text-ink3 text-right leading-tight">{editionLine(edition)}</span>
        </div>
        <nav
          aria-label="Sections"
          className="flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {SECTION_LINKS.map((s) => (
            <NavLink key={s.to} to={s.to} end={s.end} className={({ isActive }) => sectionLinkClass({ isActive: sectionActive(s, isActive) })}>
              {s.label}
            </NavLink>
          ))}
        </nav>
      </header>

      {edition && edition.state !== "fresh" && (
        <div className="px-4">
          <EditionNotice edition={edition} />
        </div>
      )}

      <main className="flex-1 px-4 pb-8">
        <Outlet />
      </main>

      <footer className="border-t border-rule mt-6 px-4 py-5 font-sans text-[16px] text-ink3">
        <p className="text-ink2 m-0">{TAGLINE}</p>

        <nav aria-label="About LITMUS" className="mt-3 flex flex-col">
          <NavLink to="/sources" className={FOOTER_LINK}>
            Sources
          </NavLink>
          <NavLink to="/about" className={FOOTER_LINK}>
            How the scoring works
          </NavLink>
          {/* Plain anchor: /legal is a static file the SPA router cannot serve. */}
          <a href={LEGAL_HREF} className={FOOTER_LINK}>
            Legal &amp; AI disclosure
          </a>
          <DeviceSwitch className="self-start" />
        </nav>

        <Byline className="inline-flex items-center min-h-[44px] mt-2" />
      </footer>
    </div>
  );
}
