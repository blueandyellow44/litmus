// Which About section the reader is currently in, for the desktop "On this
// page" index. A sticky index that never moves reads as decoration; marking the
// current entry tells a reader deep in the page where they are.
//
// This is view state, not page data: it reads heading positions from the DOM and
// holds no content, so it lives beside the page rather than in the shared data
// layer. The rule is "the last heading that has scrolled above the reading line",
// and at the very bottom of the page the last section wins, because a short final
// section can never push its heading up to the line on a tall screen.

import { useEffect, useState } from "react";

// How far below the viewport top a heading must pass before its section counts
// as current. Roughly a third of a 900px screen, so the entry flips as the
// section's heading settles into the upper part of the view, not only at the edge.
const READING_LINE_PX = 240;

// Slack for "scrolled to the bottom": sub-pixel scroll positions and zoom mean
// scrollY + innerHeight rarely equals scrollHeight exactly.
const BOTTOM_SLACK_PX = 4;

export function useActiveSection(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    if (ids.length === 0) return;
    let frame = 0;

    const measure = () => {
      frame = 0;
      const doc = document.documentElement;
      const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - BOTTOM_SLACK_PX;
      if (atBottom) {
        setActive(ids[ids.length - 1] ?? null);
        return;
      }
      let current: string | null = ids[0] ?? null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= READING_LINE_PX) current = id;
        else break;
      }
      setActive(current);
    };

    // One measurement per animation frame at most, however fast scroll events fire.
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [ids]);

  return active;
}
