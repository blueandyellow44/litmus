// Horizontal five-segment bar showing lean distribution across a cluster.
// Each segment's width is proportional to its count. Segments with 0 articles
// don't render. Hover shows the count.

import type { Lean } from "../lib/types.ts";

export const LEAN_ORDER: Lean[] = ["left", "center-left", "center", "center-right", "right"];

// Grey only: red and blue as political colours are retired (brand.md section
// 11). Lean is a position on a neutral axis, so the ramp is symmetric about the
// centre and the bar sets a gap between segments — without one, a story with
// only Left and Right coverage would draw as a single undivided block.
//
// Module-local on purpose. A LEGEND must not reuse these: the ramp is
// symmetric, so Left and Right share a hex and the two centre steps share one,
// and a swatch that two rows share maps back to no segment. LeanSpread carries
// order and the written label instead.
const COLORS: Record<Lean, string> = {
  "left":         "bg-lean-left",
  "center-left":  "bg-lean-centerLeft",
  "center":       "bg-lean-center",
  "center-right": "bg-lean-centerRight",
  "right":        "bg-lean-right",
};

const LABELS: Record<Lean, string> = {
  "left":         "Left",
  "center-left":  "Center-Left",
  "center":       "Center",
  "center-right": "Center-Right",
  "right":        "Right",
};

interface Props {
  leanCounts: Record<string, number>;
  height?: "sm" | "md";
}

export function LeanBar({ leanCounts, height = "sm" }: Props) {
  const total = LEAN_ORDER.reduce((n, l) => n + (leanCounts[l] ?? 0), 0);
  if (total === 0) return null;

  const h = height === "sm" ? "h-1.5" : "h-2.5";

  return (
    <div className={`flex w-full gap-px ${h} rounded-full overflow-hidden`} role="img" aria-label="Source lean distribution">
      {LEAN_ORDER.map((lean) => {
        const count = leanCounts[lean] ?? 0;
        if (count === 0) return null;
        const pct = (count / total) * 100;
        return (
          <div
            key={lean}
            className={`${COLORS[lean]}`}
            style={{ width: `${pct}%` }}
            title={`${LABELS[lean]}: ${count}`}
          />
        );
      })}
    </div>
  );
}
