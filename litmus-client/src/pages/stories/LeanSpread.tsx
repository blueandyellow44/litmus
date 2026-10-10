// A cluster's lean bar with its key. The shared LeanBar draws coloured segments
// only, with the counts hidden in hover titles that a phone never shows, so the
// spread a card claims to show could not actually be read. This pairs the bar
// with a one-line legend in the same left-to-right order, Left first.
//
// The legend carries NO swatch. The ramp is symmetric grey (brand.md section 11
// retires red and blue for lean), so Left and Right share one hex and so do the
// two centre steps. Inside the bar that is fine, because position still says
// which is which; in a legend it is not, because a dot that two rows share maps
// back to nothing and two identical dots read as one category. Order plus the
// written label is the mapping here. A monotone light-to-dark ramp would fix the
// swatch and break something worse: it would make Right the darkest mark on the
// card, which reads as the heaviest.
//
// The counts are OUTLET baselines, not article framing, and the label says so:
// the server counts each member article's source lean.

import { LeanBar } from "../../components/LeanBar.tsx";
import { leanSpreadParts } from "./clusterListLogic.ts";

export function LeanSpread({ leanCounts, textClass }: { leanCounts: Record<string, number>; textClass: string }) {
  const parts = leanSpreadParts(leanCounts);
  if (parts.length === 0) return null;

  return (
    <div>
      <LeanBar leanCounts={leanCounts} height="md" />
      <p className={`mt-1.5 mb-0 font-sans text-ink3 flex flex-wrap items-center gap-x-3 gap-y-1 ${textClass}`}>
        <span>Outlet baselines:</span>
        {parts.map((p) => (
          <span key={p.lean} className="text-ink whitespace-nowrap">
            {p.label} {p.count}
          </span>
        ))}
      </p>
    </div>
  );
}
