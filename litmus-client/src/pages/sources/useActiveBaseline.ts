// Which outlet baseline group the reader is currently scrolled into, for the
// desktop rail's active state. A browser QA pass (2026-09-13) found that in the
// middle of a long group nothing on screen said which baseline the rows belonged
// to, and the classification is the whole point of the Sources page.
//
// It reads layout, not data, so it lives beside the view rather than in
// useSources.ts. A group is current once its top has reached the line where
// group headings pin, and stops being current once its bottom passes that line,
// so scrolling past the table into the footer clears the mark instead of leaving
// the last baseline lit.

import { useEffect, useState } from "react";

export function useActiveBaseline(anchors: readonly string[], pinLine: number): string | null {
  const [active, setActive] = useState<string | null>(null);
  // A stable dependency: a new array with the same anchors must not re-subscribe.
  const key = anchors.join("|");

  useEffect(() => {
    const ids = key ? key.split("|") : [];
    let frame = 0;

    const measure = () => {
      frame = 0;
      let current: string | null = null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const { top, bottom } = el.getBoundingClientRect();
        if (top <= pinLine && bottom > pinLine) current = id;
      }
      setActive(current);
    };

    // One measurement per frame at most, however fast the scroll events arrive.
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [key, pinLine]);

  return active;
}
