// Everything the desktop and mobile page shells share: the section list, the
// Reading-as options, the edition record and its notice. Each shell lays these
// out its own way (LayoutDesktop.tsx, LayoutMobile.tsx); neither redefines them.
//
// The dateline reports when this edition was COMPILED, read from the manifest
// frozen into the snapshot — never from the reader's clock. A paper that has not
// refreshed says so instead of wearing today's date.

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { fetchEditionStatus } from "../../lib/api.ts";
import { LEGAL_HREF } from "../../lib/brand.ts";
import { evaluateEdition, formatEditionDate, formatEditionStamp, formatAge, type EditionStatus } from "../../lib/edition.ts";

// One page (Max, 2026-09-26): LITMUS covers politics only, broadly defined, so
// the eight section tabs and the separate All Stories page are gone from the
// navigation. Their routes still resolve for old links; nothing points at them.
// Share links that land on the front page under their own path, so analytics
// can count where readers came from (Max, 2026-10-03: the Substack essay links
// litmustimes.com/substack). The URL stays put; the front page renders.
export const LANDING_PATHS = ["/substack"];

export const SECTION_LINKS: { label: string; to: string; end?: boolean; aliases?: string[] }[] = [
  { label: "Stories", to: "/", end: true, aliases: LANDING_PATHS },
  { label: "About", to: "/about" },
];

// NavLink's own isActive, widened to a link's aliases, so the Stories link
// stays marked on a landing path such as /substack.
export function useSectionActive(): (link: (typeof SECTION_LINKS)[number], isActive: boolean) => boolean {
  const { pathname } = useLocation();
  return (link, isActive) => isActive || (link.aliases?.includes(pathname) ?? false);
}

// Re-exported from lib/brand.ts, which is where the copy lives now.
export { LEGAL_HREF };

// The mobile shell's sticky header height, in px, and the two class names that
// depend on it: what pins below it, and how far a jumped-to heading clears it.
// Measured against LayoutMobile's header (wordmark row plus section strip). A
// page that pins something under the header imports these rather than writing
// its own number, so one header change moves them all.
// Measured in Chrome at 375px: 97px (a 44px wordmark row plus the 44px section
// strip and its hairline).
export const MOBILE_HEADER_PX = 97;
export const MOBILE_STICKY_TOP = "top-[97px]";
export const MOBILE_SCROLL_MT = "scroll-mt-[109px]";

// Until the manifest resolves we say nothing about dates — an empty dateline is
// honest, a guessed one is not.
export function editionLine(edition: EditionStatus | null): string {
  if (!edition) return "Reading the edition record…";
  if (edition.compiledAt) return `Edition compiled ${formatEditionDate(edition.compiledAt)}`;
  return "Edition date unverified";
}

export function useEditionStatus(): EditionStatus | null {
  const [edition, setEdition] = useState<EditionStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchEditionStatus()
      .then((e) => {
        if (!cancelled) setEdition(e);
      })
      .catch(() => {
        // A snapshot we cannot read is itself an answer: unknown, never fresh.
        if (!cancelled) setEdition(evaluateEdition(null));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return edition;
}

// Calm, conspicuous, and only when there is something to say. Stale and unknown
// both keep the last good edition on screen — the notice explains what the
// reader is looking at rather than replacing it with an error page.
export function EditionNotice({ edition }: { edition: EditionStatus }) {
  if (edition.state === "fresh") return null;
  const stale = edition.state === "stale";
  return (
    <div
      role="status"
      // Calm styling, blunt words. A hairline top rule, not a bounding box —
      // this rail has no cards anywhere else, and a boxed alert here was the
      // one thing on the page reading as a build-status warning rather than
      // part of the paper (Max, live review, 2026-09-17).
      className="font-sans border-t border-rule pt-3"
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-ink3">
        {stale ? "This edition has not refreshed" : "Edition record incomplete"}
      </div>
      <p className="text-[13.5px] leading-[1.45] text-ink2 m-0 mt-1">
        {edition.reason}{" "}
        {edition.contentThrough ? (
          <>
            The most recent verified content is from{" "}
            <strong className="font-semibold">{formatEditionStamp(edition.contentThrough)}</strong>
            {edition.ageMs !== null ? ` (${formatAge(edition.ageMs)} ago)` : ""}. Everything below is that
            edition, unchanged.
          </>
        ) : (
          <>
            LITMUS cannot verify when this content was gathered, so it is not presented as current. Check each
            story&rsquo;s source link for its own publication date.
          </>
        )}
      </p>
    </div>
  );
}
