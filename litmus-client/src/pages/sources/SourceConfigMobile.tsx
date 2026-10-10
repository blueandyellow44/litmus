// The mobile roster: a grouped list, never a table that scrolls sideways. Each
// outlet is one row with its name on its own line and kind, access and read
// status beneath, because four columns do not fit 375px without truncating
// names. Sixty-odd outlets is a long thumb scroll, so a wrapping row of jump
// links (one per baseline, with its count) sits above the list. The caveat stays
// open and in full: it is the reason the page exists, so it is not folded away.
//
// Data and every derived value come from ./useSources.ts, shared with
// SourceConfigDesktop.tsx.

import { Link } from "react-router-dom";
import { CONTROL } from "../../components/meta.tsx";
import { MOBILE_SCROLL_MT, MOBILE_STICKY_TOP } from "../../components/layout/shared.tsx";
import { useSources } from "./useSources.ts";
import { RosterCaveat, ROSTER_SCOPE } from "./RosterCaveat.tsx";
import { accessLabel, groupAnchor, readLabel, rosterCountLine, sourceTypeLabel } from "./roster.ts";

// The jump links' own anchor, the target of each group's way back up.
const JUMP_NAV_ID = "roster-jump";

// Where a group heading pins: the bottom of LayoutMobile's sticky header. The
// number lives with the header that sets it, in layout/shared.tsx.
const MASTHEAD_TOP = MOBILE_STICKY_TOP;

export function SourceConfigMobile() {
  const { roster, error } = useSources();

  if (error) {
    return (
      <div className="pt-4">
        <Link to="/" className={`font-sans text-[15px] text-ink3 inline-flex items-center ${CONTROL}`}>
          ← Top stories
        </Link>
        <p className="mt-2 text-base">
          Could not load the roster. <span className="text-ink3">{error}</span>
        </p>
      </div>
    );
  }

  if (!roster) return <p className="text-ink3 pt-4 text-base">Loading the roster…</p>;

  return (
    <div className="pt-4">
      <h1 className="font-serif text-[30px] leading-tight mb-2">Sources</h1>
      <p className="font-sans text-[15px] text-ink3 mb-4">
        {rosterCountLine(roster)} {ROSTER_SCOPE}
      </p>

      <RosterCaveat className="text-[15px] mb-5" />

      {roster.total === 0 ? (
        <p className="text-ink3 text-base">The roster is empty.</p>
      ) : (
        <>
          <nav
            id={JUMP_NAV_ID}
            aria-label="Jump to an outlet baseline"
            className={`flex flex-wrap gap-2 mb-2 ${MOBILE_SCROLL_MT}`}
          >
            {roster.groups.map((g) => (
              <a
                key={g.key}
                href={`#${groupAnchor(g.key)}`}
                className={`font-sans text-[15px] px-3 inline-flex items-center border border-rule-strong ${CONTROL}`}
              >
                {g.label}
                <span className="text-ink3 ml-1.5">{g.items.length}</span>
              </a>
            ))}
          </nav>

          {roster.groups.map((g) => (
            // scroll-mt lands the section top exactly where its heading pins,
            // under the sticky mobile masthead.
            <section key={g.key} id={groupAnchor(g.key)} className={`${MOBILE_SCROLL_MT} mt-6`}>
              {/* The heading pins under the masthead for as long as its group is
                  on screen, so a reader in the middle of 25 Center rows still
                  sees which baseline they are in; the classification is the
                  point of the page. The next group's heading pushes it off.

                  Two fixed lines, each unbreakable: on one line beside the back
                  link the heading was capped near 236px and broke inside
                  "CENTER-RIGHT" at the hyphen (browser QA, 2026-09-13).

                  The way back sits beside every heading, outside the h2 so it is
                  not read as part of the heading's name, and pins with it. */}
              <div
                className={`sticky ${MASTHEAD_TOP} z-10 bg-ground flex items-center justify-between gap-3 border-b border-rule-strong py-1.5`}
              >
                <h2 className="font-sans text-[15px] uppercase tracking-wider text-ink3 m-0 min-w-0 leading-snug">
                  <span className="block whitespace-nowrap">Outlet baseline:</span>
                  <span className="block whitespace-nowrap">
                    <span className="text-ink">{g.label}</span>
                    <span className="ml-2">{g.items.length}</span>
                  </span>
                </h2>
                <a
                  href={`#${JUMP_NAV_ID}`}
                  className={`font-sans text-[15px] text-ink3 underline decoration-1 underline-offset-2 shrink-0 whitespace-nowrap inline-flex items-center ${CONTROL}`}
                >
                  All baselines ↑
                </a>
              </div>
              <ul className="list-none p-0 m-0">
                {g.items.map((s) => (
                  <li key={s.id} className="border-b border-rule py-3 min-h-[44px]">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-serif text-[17px] leading-snug min-w-0 break-words">{s.name}</span>
                      <span
                        className={`font-sans text-[15px] shrink-0 ${s.enabled ? "text-ink" : "text-ink3"}`}
                      >
                        {readLabel(s.enabled)}
                      </span>
                    </div>
                    <p className="font-sans text-[15px] text-ink3 m-0 mt-0.5">
                      {sourceTypeLabel(s.type)} · {accessLabel(s.paywallStatus)}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
