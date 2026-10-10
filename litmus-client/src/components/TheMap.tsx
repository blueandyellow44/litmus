// The Map — a pure-SVG scatter of the section's trending-story coverage.
// X = political lean (-100 left … +100 right), Y = P/H composite (proportionate at
// the bottom, hyperbolic at the top). Dots take the P/H band color; source
// names label the dots when there is room, and are skipped when they would
// overflow the frame. No chart library — the viewBox keeps it responsive.

import { useNavigate } from "react-router-dom";
import type { SectionArticleDTO } from "../lib/types.ts";
import { bandWord, colorForComposite, isValidComposite, MARK_STROKE } from "../lib/phBand.ts";
import { PALETTE } from "../lib/palette.ts";
import { framingLabel } from "./meta.tsx";

// Re-exported because half the app imports colorForComposite from here. The
// ladder itself used to live in this file, as one of four independent copies of
// the band table; it now comes from lib/phBand.ts like every other reading of a
// composite. See that file's header.
export { colorForComposite };

// Fixed drawing space — rendered size scales with the container via viewBox.
const W = 520;
const H = 400;
const PAD_L = 40;
const PAD_R = 90;
const PAD_T = 18;
const PAD_B = 34;
const IW = W - PAD_L - PAD_R;
const IH = H - PAD_T - PAD_B;
const LABEL_FONT = 9;
// Stroke width of the surface halo behind a dot. paint-order puts it under the
// fill, so half of it shows: 4 draws the 2px ring brand.md section 5 asks for.
const HALO_WIDTH = 4;
const LABEL_CHAR_W = 5.4; // rough advance width per character at 9px sans
const LABEL_LINE_H = 11; // vertical stagger step for colliding labels

type Plottable = SectionArticleDTO & { politicalLean: number; composite: number };

// Both coordinates have to be real numbers in range, because both are POSITIONS.
// A null check alone is not enough: NaN, Infinity or a composite of 7.2 would
// each produce an `x`/`y` that is off the canvas or not a number at all, and an
// SVG circle with cx="NaN" simply does not draw — the article would vanish from
// The Map with nothing saying it had. Excluding it here is the same judgement
// the badge makes when it prints "Not rated": an unusable score has no place on
// a scale, and the honest rendering is absence rather than a dot in a plausible
// spot.
function isPlottable(a: SectionArticleDTO): a is Plottable {
  return (
    typeof a.politicalLean === "number" &&
    Number.isFinite(a.politicalLean) &&
    a.politicalLean >= -100 &&
    a.politicalLean <= 100 &&
    isValidComposite(a.composite)
  );
}

interface Props {
  articles: SectionArticleDTO[];
}

// A dot with its resolved label geometry. side === null means the label is
// hidden (the dot still draws); x0/x1 are the label's horizontal extent, used
// for overlap tests during the stagger pass.
interface Placement {
  a: Plottable;
  x: number;
  y: number;
  fill: string;
  side: "start" | "end" | null;
  labelX: number;
  labelY: number;
  x0: number;
  x1: number;
}

export function TheMap({ articles }: Props) {
  const navigate = useNavigate();
  const plotted = articles.filter(isPlottable);

  // Compute each dot's position and a first-pass label placement: anchor right
  // of the dot, flip left near the right edge, hide if neither side fits.
  const placements: Placement[] = plotted.map((a) => {
    const x = PAD_L + ((a.politicalLean + 100) / 200) * IW;
    const y = PAD_T + ((5 - a.composite) / 4) * IH;
    const labelW = a.sourceName.length * LABEL_CHAR_W;
    const fitsRight = x + 8 + labelW <= PAD_L + IW;
    const fitsLeft = x - 8 - labelW >= PAD_L;
    const side: Placement["side"] = fitsRight ? "start" : fitsLeft ? "end" : null;
    const labelX = side === "end" ? x - 8 : x + 8;
    const x0 = side === "end" ? x - 8 - labelW : x + 8;
    const x1 = side === "end" ? x - 8 : x + 8 + labelW;
    return { a, x, y, fill: colorForComposite(a.composite), side, labelX, labelY: y + 3, x0, x1 };
  });

  // Stagger colliding labels. Greedy top-to-bottom: if a label sits within one
  // line height of an already-placed label AND overlaps it horizontally, push
  // it down by a line height until it clears. Dots never move, only labels.
  const labeled = placements
    .filter((p) => p.side !== null)
    .sort((p, q) => p.labelY - q.labelY);
  for (let i = 0; i < labeled.length; i++) {
    const cur = labeled[i]!;
    let moved = true;
    while (moved) {
      moved = false;
      for (let j = 0; j < i; j++) {
        const prev = labeled[j]!;
        const overlapsX = cur.x0 < prev.x1 && prev.x0 < cur.x1;
        if (overlapsX && Math.abs(cur.labelY - prev.labelY) < LABEL_LINE_H) {
          cur.labelY = prev.labelY + LABEL_LINE_H;
          moved = true;
        }
      }
    }
    // After nudging, a label pushed past the frame bottom is hidden rather than
    // drawn outside the viewBox. The dot stays.
    if (cur.labelY > PAD_T + IH) cur.side = null;
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      // Names the axis for what it actually plots. X is the scorer's reading of
      // each ARTICLE's framing, not the outlet's standing baseline, and the two
      // regularly differ — which is the finding, not a defect.
      aria-label="Scatter plot of this story's coverage: each article's own framing left to right, proportionate to hyperbolic bottom to top"
      className="block w-full h-auto"
    >
      {/* Frame */}
      <rect x={PAD_L} y={PAD_T} width={IW} height={IH} fill={PALETTE.surface} stroke={PALETTE.rule} />
      {/* Center crosshair rules */}
      <line x1={PAD_L + IW / 2} y1={PAD_T} x2={PAD_L + IW / 2} y2={PAD_T + IH} stroke={PALETTE.grid} />
      <line x1={PAD_L} y1={PAD_T + IH / 2} x2={PAD_L + IW} y2={PAD_T + IH / 2} stroke={PALETTE.grid} />

      {plotted.length === 0 && (
        <text
          x={PAD_L + IW / 2}
          y={PAD_T + IH / 2 - 12}
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize={12}
          fill={PALETTE.ink3}
        >
          {articles.length === 0
            ? "No coverage of this story yet"
            : `No plottable score among ${articles.length} article${articles.length === 1 ? "" : "s"}`}
        </text>
      )}

      {/* An article that could not be plotted is SAID, not silently dropped. A
          dot missing from a scatter is invisible, and a reader counting outlets
          against the coverage list below would find the two disagree. */}
      {plotted.length > 0 && plotted.length < articles.length && (
        <text
          x={PAD_L + IW / 2}
          y={PAD_T + IH + 14}
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontSize={9}
          fill={PALETTE.ink3}
        >
          {articles.length - plotted.length} of {articles.length} not plotted (no usable score)
        </text>
      )}

      {placements.map((p) => (
        <g
          key={p.a.id}
          role="link"
          tabIndex={0}
          style={{ cursor: "pointer" }}
          onClick={() => navigate(`/articles/${p.a.id}`)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") navigate(`/articles/${p.a.id}`);
          }}
          className="group"
        >
          {/* The band word is derived from the number, never read off the
              stored label, so the tooltip cannot contradict the dot's colour. */}
          <title>{`${p.a.sourceName} · article framing ${framingLabel(p.a.politicalLean)} · P/H ${p.a.composite.toFixed(1)} ${bandWord(p.a.composite)} — open analysis`}</title>
          {/* Enlarged invisible hit target */}
          <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
          {/* Two marks, not one (brand.md section 5): a 2px surface halo under
              the fill so dots that clump in one region stay separable, then the
              1px ink edge on top so the two pale bands are visible at all.
              paint-order puts the halo's stroke beneath the fill, so the 4px
              width reads as 2px outside the dot. */}
          <circle cx={p.x} cy={p.y} r={5} fill={p.fill} stroke={PALETTE.surface} strokeWidth={HALO_WIDTH} paintOrder="stroke" />
          <circle
            cx={p.x}
            cy={p.y}
            r={5}
            fill="none"
            stroke={MARK_STROKE}
            strokeWidth={1}
            className="group-hover:stroke-ink"
          />
          {p.side !== null && (
            <text
              x={p.labelX}
              y={p.labelY}
              textAnchor={p.side}
              fontFamily="system-ui, sans-serif"
              fontSize={LABEL_FONT}
              fill={PALETTE.ink2}
              className="group-hover:font-semibold group-hover:underline"
            >
              {p.a.sourceName}
            </text>
          )}
        </g>
      ))}

      {/* Axis labels */}
      <text x={PAD_L} y={H - 10} textAnchor="start" fontFamily="system-ui, sans-serif" fontSize={9} fill={PALETTE.ink3} letterSpacing="1">
        LEFT
      </text>
      {/* Says which of the two political readings this axis is. Without it a
          reader compares the dot's position against the outlet baseline printed
          elsewhere on the page and reads the difference as an error. */}
      <text x={PAD_L + IW / 2} y={H - 10} textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize={9} fill={PALETTE.ink3} letterSpacing="0.5">
        ARTICLE FRAMING
      </text>
      <text x={PAD_L + IW} y={H - 10} textAnchor="end" fontFamily="system-ui, sans-serif" fontSize={9} fill={PALETTE.ink3} letterSpacing="1">
        RIGHT
      </text>
      <text
        x={13}
        y={PAD_T + 16}
        textAnchor="middle"
        transform={`rotate(-90 13 ${PAD_T + 16})`}
        fontFamily="system-ui, sans-serif"
        fontSize={9}
        fill={PALETTE.ink3}
        letterSpacing="1"
      >
        HYPERBOLIC
      </text>
      <text
        x={13}
        y={PAD_T + IH - 30}
        textAnchor="middle"
        transform={`rotate(-90 13 ${PAD_T + IH - 30})`}
        fontFamily="system-ui, sans-serif"
        fontSize={9}
        fill={PALETTE.ink3}
        letterSpacing="1"
      >
        PROPORTIONATE
      </text>
    </svg>
  );
}
