// Layer 2: every report in the story on one fixed chart. Lean of the framing
// left to right, P/H bottom to top, dots filled with the band colour and
// labelled with outlet, number and band word. Headline-only reports sit as
// hollow dots in their own lane, never dropped. A screen reader gets the same
// facts twice: an SVG title and description, and a table under the figure.
//
// All geometry is in lib/storyMatrix.ts; this file only draws it.
//
// Axis text is 13px (audit 2026-10-02: 10.5px axis numbers were unreadable);
// the left margins in storyMatrix.ts were widened to hold "Proportionate 1" at
// that size.

import { PALETTE } from "../../lib/palette.ts";
import { MARK_STROKE, PH_BANDS } from "../../lib/phBand.ts";
import type { StoryMemberDTO } from "../../lib/storyTypes.ts";
import { hollowMembers, memberState, memberStateText, outletShortName, pendingMembers, readStatusCaption, scoreText } from "../../lib/storyModel.ts";
import { framingLabel } from "../meta.tsx";
import {
  drawOrder,
  fitMatrix,
  matrixDescription,
  matrixHeight,
  plotHeight,
  unlabelledPoints,
  xForLean,
  type MatrixPresetName,
} from "../../lib/storyMatrix.ts";

interface Props {
  members: readonly StoryMemberDTO[];
  preset: MatrixPresetName;
  // Unique on the page: the SVG's title and description ids derive from it.
  id: string;
  className?: string;
  // The screen-reader table of every report. Off while a front-page card is
  // collapsed (Max, 2026-10-02): the collapsed card carries the chart only, and
  // the table returns with "Show the tellings".
  withTable?: boolean;
}

const AXIS_FONT = 13;

export const MATRIX_TITLE = "Where each report sits: political lean left to right, Proportionate to Hyperbolic bottom to top";
const HALO_EXTRA_RADIUS = 2;
const LEADER_STROKE = "#A9A7A1";
const AXIS_STROKE = "#B9B7B1";

export function StoryMatrix({ members, preset: presetName, id, className = "", withTable = true }: Props) {
  // Every dot labelled in the chart (Max, 2026-10-09); the chart grows taller
  // when it must. The line under the chart is a last resort fitMatrix has not
  // needed on a real edition.
  const { p, points: pts, labels } = fitMatrix(members, presetName);
  const unlabelled = unlabelledPoints(pts, labels);
  // Headline-only reports are named in the caption, not drawn (2026-09-26).
  const height = matrixHeight(p, 0);
  const plotBottom = p.m.t + plotHeight(p);
  const plotRight = p.w - p.m.r;
  const axisY = plotBottom + 10;
  const leanY = plotBottom + 26;
  const centreX = xForLean(0, p);
  const desc = matrixDescription(members);
  const caption = readStatusCaption({ members: [...members] });
  const nothingToPlot = pts.length === 0;

  return (
    <figure className={`m-0 ${className}`}>
      {nothingToPlot ? (
        <p className="font-sans text-sm text-ink2 m-0" role="status">
          No scored report to plot yet.
          {pendingMembers({ members: [...members] }).length > 0 && " Analysis is pending for this story."}
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${p.w} ${height}`}
          width="100%"
          style={{ maxWidth: p.w, height: "auto", display: "block", overflow: "visible" }}
          role="img"
          aria-labelledby={`${id}-t ${id}-d`}
          className="font-sans"
        >
          <title id={`${id}-t`}>{MATRIX_TITLE}</title>
          <desc id={`${id}-d`}>{desc}</desc>

          {PH_BANDS.map((b, i) => {
            const v = i + 1;
            const y = p.m.t + ((5 - v) / 4) * plotHeight(p);
            return (
              <g key={b.label}>
                <line x1={p.m.l} x2={plotRight} y1={y} y2={y} stroke={PALETTE.grid} strokeWidth={1} />
                {p.bandWords === "full" ? (
                  <>
                    <circle cx={p.m.l - 10} cy={y} r={3.5} fill={b.hex} stroke={MARK_STROKE} strokeWidth={1} />
                    <text x={p.m.l - 20} y={y} textAnchor="end" dominantBaseline="middle" fontSize={AXIS_FONT} fill={PALETTE.ink3}>
                      {b.label} <tspan fill={PALETTE.ink2} fontWeight={600}>{v}.0</tspan>
                    </text>
                  </>
                ) : (
                  <text x={p.m.l - 8} y={y} textAnchor="end" dominantBaseline="middle" fontSize={AXIS_FONT} fill={PALETTE.ink3}>
                    {b.label} <tspan fill={PALETTE.ink2} fontWeight={600}>{v}</tspan>
                  </text>
                )}
              </g>
            );
          })}

          <line x1={centreX} x2={centreX} y1={p.m.t - 4} y2={plotBottom} stroke={AXIS_STROKE} strokeWidth={1} strokeDasharray="3 3" />
          <line x1={p.m.l} x2={plotRight} y1={axisY} y2={axisY} stroke={AXIS_STROKE} strokeWidth={1} />
          <text x={p.m.l} y={leanY} fontSize={AXIS_FONT} fill={PALETTE.ink3}>Left</text>
          <text x={centreX} y={leanY} fontSize={AXIS_FONT} fill={PALETTE.ink3} textAnchor="middle">Center</text>
          <text x={plotRight} y={leanY} fontSize={AXIS_FONT} fill={PALETTE.ink3} textAnchor="end">Right</text>

          {labels.map((l) => (
            <g key={`label-${l.ids.join("-")}`}>
              <line x1={l.leader.x1} y1={l.leader.y1} x2={l.leader.x2} y2={l.leader.y2} stroke={LEADER_STROKE} strokeWidth={0.75} />
              {l.rows.map((row, i) => (
                <text
                  key={i}
                  x={l.x}
                  y={l.y + row.dy}
                  textAnchor={l.anchor}
                  dominantBaseline="middle"
                  fontSize={row.kind === "name" ? 11.5 : 11}
                  fontWeight={row.kind === "name" ? 600 : undefined}
                  fontStyle={row.kind === "extra" ? "italic" : undefined}
                  fill={row.kind === "name" ? PALETTE.ink : PALETTE.ink2}
                >
                  {row.text}
                  {row.suffix && <tspan fontWeight={400} fontSize={11} fill={PALETTE.ink2}>{row.suffix}</tspan>}
                </text>
              ))}
            </g>
          ))}

          {drawOrder(pts).map((pt) => (
            <g key={`dot-${pt.id}`}>
              <circle cx={pt.x} cy={pt.y} r={p.r + HALO_EXTRA_RADIUS} fill={PALETTE.surface} />
              <circle cx={pt.x} cy={pt.y} r={p.r} fill={pt.hex} stroke={MARK_STROKE} strokeWidth={1}>
                <title>{pt.title}</title>
              </circle>
            </g>
          ))}

        </svg>
      )}

      <figcaption className="font-sans text-meta text-ink2 mt-2">
        {caption}
        {unlabelled.length > 0 && (
          <span className="block">
            Not labelled above: {unlabelled.map((pt) => `${pt.name} ${pt.scoreLine}`).join(", ")}
          </span>
        )}
      </figcaption>

      {/* The screen-reader table sits in an sr-only div: an sr-only TABLE ignores
          the 1px width and widened phone pages to about 700px (2026-09-26). */}
      {withTable && members.length > 0 && (
        <div className="sr-only">
        <table>
          <caption>Every report in this story, with its score, band and framing</caption>
          <thead>
            <tr>
              <th scope="col">Outlet</th>
              <th scope="col">Score</th>
              <th scope="col">Framing</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {members.filter((m) => m.kind !== "headline_only").map((m) => {
              const state = memberState(m);
              return (
                <tr key={m.articleId}>
                  <td>{outletShortName(m.outletName)}</td>
                  <td>{state === "scored" || state === "syndicated" ? scoreText(m.composite) : "Not scored"}</td>
                  <td>{typeof m.politicalLean === "number" ? framingLabel(m.politicalLean) : "Not scored"}</td>
                  <td>{memberStateText(state) ?? "Read in full"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </figure>
  );
}

export function hasHollowMembers(members: readonly StoryMemberDTO[]): boolean {
  return hollowMembers({ members: [...members] }).length > 0;
}
