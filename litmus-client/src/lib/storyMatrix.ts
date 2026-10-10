// Geometry for the story matrix (layer 2): every report in a story plotted by
// the lean of its framing (left to right) and its P/H temperature (bottom to
// top). Pure functions, so the scales, the label layout and the hollow lane are
// unit-tested without rendering an SVG. The React component
// (components/story/StoryMatrix.tsx) only draws what these return.
//
// Honesty rules (brand.md section 5; Measured brand.md section 6): both axes
// are fixed and never zoomed to the data. A clump at the centre is a clump at
// the centre. Labels never sit on dots, every label carries the number and
// the band word, and a report LITMUS could not read is still on the chart, as a
// hollow dot in its own lane, never dropped.

import { PH_BANDS, colorForComposite } from "./phBand.ts";
import type { StoryMemberDTO } from "./storyTypes.ts";
import { axisWordWidth, nameWidth, scoreWidth } from "./labelMetrics.ts";
import { hollowMembers, outletShortName, pendingMembers, plottedMembers, scoreText } from "./storyModel.ts";

export const LEAN_MIN = -100;
export const LEAN_MAX = 100;
export const PH_MIN = 1;
export const PH_MAX = 5;

export interface MatrixMargins {
  l: number;
  r: number;
  t: number;
  b: number;
}

export interface MatrixPreset {
  w: number;
  h: number;
  // Dot radius.
  r: number;
  m: MatrixMargins;
  // Minimum vertical distance between two stacked labels.
  labelGap: number;
  // Horizontal distance from a group's outermost dot to its label column.
  labelOffset: number;
  // "full" labels each gridline with band word, number and a swatch; "compact"
  // drops the swatch and the ".0".
  bandWords: "full" | "compact";
  // Estimated advance per character at label size, for overflow decisions.
  charW: number;
  // Height added below the axis when the story has headline-only members.
  laneHeight: number;
}

// The three compositions from the Quiet Reader mocks (design/rebrand-2026-09-13/
// quiet-reader/_build.mjs): the story page at 1440, the story page at 375, and
// the small matrix in a front-page margin column or mobile fold.
export const MATRIX_PRESETS = {
  storyDesktop: { w: 542, h: 440, r: 7.5, m: { l: 150, r: 14, t: 14, b: 40 }, labelGap: 32, labelOffset: 30, bandWords: "full", charW: 6.4, laneHeight: 56 },
  storyMobile: { w: 343, h: 360, r: 6.5, m: { l: 112, r: 8, t: 14, b: 38 }, labelGap: 30, labelOffset: 16, bandWords: "compact", charW: 6.4, laneHeight: 52 },
  front: { w: 343, h: 290, r: 5.5, m: { l: 112, r: 6, t: 14, b: 40 }, labelGap: 29, labelOffset: 16, bandWords: "compact", charW: 6.4, laneHeight: 48 },
} as const satisfies Record<string, MatrixPreset>;

export type MatrixPresetName = keyof typeof MATRIX_PRESETS;

// A small story needs less height; the mock drops the front matrix to 210 for
// three members or fewer.
const FRONT_SHORT_HEIGHT = 210;
const FRONT_SHORT_MAX_MEMBERS = 3;

export function presetFor(name: MatrixPresetName, plottedCount: number): MatrixPreset {
  const base: MatrixPreset = MATRIX_PRESETS[name];
  if (name === "front" && plottedCount <= FRONT_SHORT_MAX_MEMBERS) return { ...base, h: FRONT_SHORT_HEIGHT };
  return base;
}

export function plotWidth(p: MatrixPreset): number {
  return p.w - p.m.l - p.m.r;
}

export function plotHeight(p: MatrixPreset): number {
  return p.h - p.m.t - p.m.b;
}

export function xForLean(lean: number, p: MatrixPreset): number {
  const clamped = Math.min(LEAN_MAX, Math.max(LEAN_MIN, lean));
  return p.m.l + ((clamped - LEAN_MIN) / (LEAN_MAX - LEAN_MIN)) * plotWidth(p);
}

export function yForComposite(composite: number, p: MatrixPreset): number {
  const clamped = Math.min(PH_MAX, Math.max(PH_MIN, composite));
  return p.m.t + ((PH_MAX - clamped) / (PH_MAX - PH_MIN)) * plotHeight(p);
}

// Total SVG height: the preset, plus the lane only when there is something to
// put in it.
export function matrixHeight(p: MatrixPreset, hollowCount: number): number {
  return p.h + (hollowCount > 0 ? p.laneHeight : 0);
}

// ── Points ──────────────────────────────────────────────────────────────────

export interface MatrixPoint {
  id: number;
  x: number;
  y: number;
  composite: number;
  hex: string;
  // Label lines: outlet name, then "2.3 Grounded", then an optional third line.
  name: string;
  scoreLine: string;
  extra: string | null;
  // The <title> text and the description entry.
  title: string;
}

export function matrixPoints(members: readonly StoryMemberDTO[], p: MatrixPreset): MatrixPoint[] {
  return plottedMembers({ members: [...members] }).map((m) => {
    // plottedMembers guarantees both numbers; the fallbacks only satisfy the
    // type system and cannot fire.
    const composite = m.composite ?? PH_MIN;
    const lean = m.politicalLean ?? 0;
    const name = outletShortName(m.outletName);
    const scoreLine = scoreText(composite);
    const extra = m.kind === "syndicated" ? "wire copy" : null;
    return {
      id: m.articleId,
      x: xForLean(lean, p),
      y: yForComposite(composite, p),
      composite,
      hex: colorForComposite(composite),
      name,
      scoreLine,
      extra,
      title: `${name} ${scoreLine}${extra ? ` · ${extra}` : ""}`,
    };
  });
}

// Hotter dots are drawn last so they sit on top of calmer ones.
export function drawOrder(points: readonly MatrixPoint[]): MatrixPoint[] {
  return [...points].sort((a, b) => a.composite - b.composite || a.id - b.id);
}

// ── Labels ──────────────────────────────────────────────────────────────────
//
// Each dot's label is placed on its own (rewritten 2026-09-26 after Max's
// phone showed labels running into the axis words and off the right edge; an
// audit of the live edition found 25 of 102 front-matrix labels outside the
// plot). Every label tries spots beside its dot, right or left, then a little
// above or below, and takes the first one that stays inside the plot and
// covers no other label and no dot. A leader joins label and dot.
//
// Every dot is labelled in the chart (Max, 2026-10-09: "they all need to be
// labeled in matrix"; the 09-26 line under the chart, "Also on the chart:
// ...", is gone). When the near spots are taken, the label searches the whole
// plot near its dot, beside or centred above or below, nearest first; a dot at
// the centre of a phone chart has no room beside it for a name, so above or
// below is often the only spot. A label never sits far from its dot and its
// leader never crosses another leader or label. If a label still has nowhere
// to go, fitMatrix makes the chart taller, which spreads the dots apart.

// Line spacing inside a label, and the first line's offset from the anchor y.
const LINE_HEIGHT = 13;
const FIRST_LINE_DY = -6;
// A label's box around its anchor y: half a line above the first line's
// centre, half a line below the last.
const BOX_ABOVE = 6;
const BOX_BELOW = 6;
// Space between a dot and its label, and around every box when testing overlap.
const LABEL_DOT_GAP = 7;
const BOX_PAD = 2;
// Vertical steps tried, nearest first, then the same steps a little further
// out sideways, with a longer leader.
const LABEL_STEPS = [0, -14, 14, -28, 28, -42, 42, -56, 56, -70, 70];
const LABEL_REACH = [0, 24, 48];
// Leader lines start just outside the dot and stop just short of the text.
const LEADER_DOT_CLEARANCE = 3;
const LEADER_TEXT_CLEARANCE = 3;
// Vertical step for the wide search, the same as the near steps' spacing.
const WIDE_STEP = 14;
// Wide-search spots further from the dot cost more; a spot beside the dot is
// preferred over one above or below at the same distance.
const VERTICAL_PENALTY = 6;
// The furthest a label may sit from its dot, nearest edge to dot centre. A
// label flung across the chart reads as the score of wherever it lands (the
// first try at this put "BBC News 1.3" on the Running Hot line), so fitMatrix
// starts tight and loosens only when growing the chart has not made room.
const MAX_LABEL_DISTANCE = 52;
// And never further than this from its dot's score, in P/H points.
const MAX_SCORE_OFFSET = 0.4;

// One line of a label. "name" is the outlet in bold; "score" is "1.6
// Grounded"; "extra" is "wire copy" in italic. A compact label's single line
// is a name with its score as a suffix: "NPR" + " 1.6 Grounded".
export interface LabelRow {
  text: string;
  kind: "name" | "score" | "extra";
  suffix?: string;
  dy: number;
}

export interface MatrixLabel {
  // The dots this label names. Usually one; touching dots with the same score
  // share a label, since the reader sees one mark.
  ids: number[];
  x: number;
  y: number;
  anchor: "start" | "end";
  rows: LabelRow[];
  // One line, "NPR 1.6 Grounded": used on a chart too crowded for two-line
  // labels.
  compact: boolean;
  leader: { x1: number; y1: number; x2: number; y2: number };
}

export interface Box { x0: number; x1: number; y0: number; y1: number }

const overlaps = (a: Box, b: Box) =>
  a.x0 < b.x1 + BOX_PAD && b.x0 < a.x1 + BOX_PAD && a.y0 < b.y1 + BOX_PAD && b.y0 < a.y1 + BOX_PAD;

export function labelWidth(rows: readonly Pick<LabelRow, "text" | "suffix" | "kind">[]): number {
  return Math.max(...rows.map((r) => (r.kind === "name" ? nameWidth(r.text) : scoreWidth(r.text)) + (r.suffix ? scoreWidth(r.suffix) : 0)));
}

// The box a placed label covers, as the layout measured it.
export function labelBox(l: Pick<MatrixLabel, "x" | "y" | "anchor" | "rows">): Box {
  const d = dimsFor(l.rows);
  const x0 = l.anchor === "start" ? l.x : l.x - d.w;
  return { x0, x1: x0 + d.w, y0: l.y - d.top, y1: l.y + d.bottom };
}

// ── Label units ─────────────────────────────────────────────────────────────

// What gets one label: a dot, or dots that touch or overlap on the chart and
// carry the same score text, since the reader sees them as one mark.
interface LabelUnit {
  ids: number[];
  x: number;
  y: number;
  names: string[];
  composite: number;
  scoreLine: string;
  extra: string | null;
}

function labelUnits(points: readonly MatrixPoint[], p: MatrixPreset): LabelUnit[] {
  const units: Array<LabelUnit & { members: MatrixPoint[] }> = [];
  const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x || a.id - b.id);
  for (const pt of sorted) {
    const home = units.find((u) =>
      u.scoreLine === pt.scoreLine && u.extra === pt.extra && u.members.some((m) => Math.hypot(m.x - pt.x, m.y - pt.y) <= 2 * p.r));
    if (home) {
      home.members.push(pt);
      home.ids.push(pt.id);
      home.names.push(pt.name);
      home.x = home.members.reduce((t, m) => t + m.x, 0) / home.members.length;
      home.y = home.members.reduce((t, m) => t + m.y, 0) / home.members.length;
    } else {
      units.push({ members: [pt], ids: [pt.id], x: pt.x, y: pt.y, names: [pt.name], composite: pt.composite, scoreLine: pt.scoreLine, extra: pt.extra });
    }
  }
  return units;
}

// Names joined with commas, wrapped so no line is wider than the plot.
function nameLines(names: readonly string[], maxChars: number): string[] {
  const lines: string[] = [];
  for (const name of names) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last]!.length + 2 + name.length <= maxChars) lines[last] = `${lines[last]}, ${name}`;
    else {
      if (last >= 0) lines[last] = `${lines[last]},`;
      lines.push(name);
    }
  }
  return lines;
}

function unitRows(u: LabelUnit, compact: boolean, p: MatrixPreset): LabelRow[] {
  const maxChars = Math.floor(plotWidth(p) / p.charW);
  const at = (i: number) => FIRST_LINE_DY + i * LINE_HEIGHT;
  if (compact) {
    // "NPR 1.6 Grounded" on one line: the number and the band word always
    // travel together (brand.md). Wire copy adds "wire".
    const suffix = ` ${u.scoreLine}${u.extra ? " wire" : ""}`;
    const lines = nameLines(u.names, maxChars - suffix.length);
    // Centred on the anchor y, so a level leader meets the middle of the text.
    const top = (-(lines.length - 1) * LINE_HEIGHT) / 2;
    return lines.map((text, i) => ({ text, kind: "name" as const, dy: top + i * LINE_HEIGHT, ...(i === lines.length - 1 ? { suffix } : {}) }));
  }
  const rows: LabelRow[] = nameLines(u.names, maxChars).map((text, i) => ({ text, kind: "name" as const, dy: at(i) }));
  rows.push({ text: u.scoreLine, kind: "score", dy: at(rows.length) });
  if (u.extra) rows.push({ text: u.extra, kind: "extra", dy: at(rows.length) });
  return rows;
}

// ── Placement ───────────────────────────────────────────────────────────────

interface Spot { anchor: "start" | "end"; x: number; y: number; box: Box; beside: boolean }

// A label's size: width, and its box above and below the anchor y.
interface Dims { w: number; top: number; bottom: number }

function dimsFor(rows: readonly LabelRow[]): Dims {
  return { w: labelWidth(rows), top: -rows[0]!.dy + BOX_ABOVE, bottom: rows[rows.length - 1]!.dy + BOX_BELOW };
}

function besideSpot(u: LabelUnit, d: Dims, anchor: "start" | "end", reach: number, dy: number, p: MatrixPreset): Spot {
  const x = anchor === "start" ? u.x + p.r + LABEL_DOT_GAP + reach : u.x - p.r - LABEL_DOT_GAP - reach;
  const y = u.y + dy;
  return { anchor, x, y, beside: true, box: { x0: anchor === "start" ? x : x - d.w, x1: anchor === "start" ? x + d.w : x, y0: y - d.top, y1: y + d.bottom } };
}

// A label centred over or under its dot, slid sideways to stay in the plot.
function verticalSpot(u: LabelUnit, d: Dims, above: boolean, k: number, p: MatrixPreset): Spot {
  const plotRight = p.w - p.m.r;
  const x = Math.min(Math.max(u.x - d.w / 2, LEFT_EDGE), plotRight - d.w);
  const y = above
    ? u.y - p.r - LABEL_DOT_GAP - d.bottom - k * WIDE_STEP
    : u.y + p.r + LABEL_DOT_GAP + d.top + k * WIDE_STEP;
  return { anchor: "start", x, y, beside: false, box: { x0: x, x1: x + d.w, y0: y - d.top, y1: y + d.bottom } };
}

function distanceToBox(x: number, y: number, b: Box): number {
  const dx = Math.max(b.x0 - x, 0, x - b.x1);
  const dy = Math.max(b.y0 - y, 0, y - b.y1);
  return Math.hypot(dx, dy);
}

type Seg = MatrixLabel["leader"];

function segmentsCross(a: Seg, b: Seg): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return (
    o(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1) !== o(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2) &&
    o(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1) !== o(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2)
  );
}

function segmentHitsBox(s: Seg, b: Box): boolean {
  // Sampled: leaders are short, and a box is never thinner than a text line.
  const SAMPLES = 16;
  for (let i = 1; i < SAMPLES; i++) {
    const t = i / SAMPLES;
    const x = s.x1 + (s.x2 - s.x1) * t, y = s.y1 + (s.y2 - s.y1) * t;
    if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) return true;
  }
  return false;
}

// Beside: a level line from the dot's edge to the text, ending at the
// label's anchor y. Above or below: from the dot's edge to the nearest point
// of the label's bottom or top edge.
function leaderFor(u: LabelUnit, spot: Spot, p: MatrixPreset): Seg {
  if (spot.beside) {
    const dir = spot.anchor === "start" ? 1 : -1;
    return { x1: u.x + dir * (p.r + LEADER_DOT_CLEARANCE), y1: u.y, x2: spot.x - dir * LEADER_TEXT_CLEARANCE, y2: spot.y };
  }
  const above = spot.box.y1 <= u.y;
  const x2 = Math.min(Math.max(u.x, spot.box.x0), spot.box.x1);
  const y2 = above ? spot.box.y1 + LEADER_TEXT_CLEARANCE : spot.box.y0 - LEADER_TEXT_CLEARANCE;
  const len = Math.hypot(x2 - u.x, y2 - u.y) || 1;
  const start = p.r + LEADER_DOT_CLEARANCE;
  return { x1: u.x + ((x2 - u.x) / len) * start, y1: u.y + ((y2 - u.y) / len) * start, x2, y2 };
}

// The SVG's left edge, with a hair of room so text is never clipped.
const LEFT_EDGE = 2;
// Half the height of an axis word's box, and room for its band swatch.
const AXIS_WORD_HALF_HEIGHT = 9;
const SWATCH_ROOM = 10;

// The boxes of the band words down the left ("Mixed Signals 3"), drawn by
// StoryMatrix.tsx: right-aligned 8px left of the plot, or 20px left of it with
// a swatch on the full-size chart.
export function axisWordBoxes(p: MatrixPreset): Box[] {
  return PH_BANDS.map((b, i) => {
    const v = i + 1;
    const y = yForComposite(v, p);
    const full = p.bandWords === "full";
    const right = full ? p.m.l - 20 : p.m.l - 8;
    const w = axisWordWidth(`${b.label} ${full ? `${v}.0` : v}`);
    return { x0: right - w, x1: full ? p.m.l - 10 + SWATCH_ROOM / 2 : right, y0: y - AXIS_WORD_HALF_HEIGHT, y1: y + AXIS_WORD_HALF_HEIGHT };
  });
}

export interface LabelOptions {
  maxDistance?: number;
  // The furthest a label's centre may sit from its dot's score, in P/H
  // points, so "CNBC 1.9" never sits down at the 1.3 line.
  maxScoreOffset?: number;
  compact?: boolean;
}

const labelledCount = (labels: readonly MatrixLabel[]) => labels.reduce((t, l) => t + l.ids.length, 0);

// How many times a layout is retried with the labels that found no spot moved
// to the front of the queue.
const PRIORITY_RETRIES = 6;

export function layoutLabels(points: readonly MatrixPoint[], p: MatrixPreset, opts: LabelOptions = {}): MatrixLabel[] {
  if (points.length === 0) return [];
  // Top of the chart first (hottest), ties by lean, so the hot end, the part a
  // reader looks at first, gets the nearest spots. A label that found no spot
  // goes first on the next try, since the hotter labels placed before it may
  // have taken the only room near its dot.
  let order = labelUnits(points, p);
  let best: MatrixLabel[] = [];
  for (let attempt = 0; attempt <= PRIORITY_RETRIES; attempt++) {
    const { labels, missed } = placeLabels(points, order, p, opts);
    if (labelledCount(labels) > labelledCount(best)) best = labels;
    if (missed.length === 0) break;
    order = [...missed, ...order.filter((u) => !missed.includes(u))];
  }
  return best;
}

function placeLabels(points: readonly MatrixPoint[], units: readonly LabelUnit[], p: MatrixPreset, { maxDistance = MAX_LABEL_DISTANCE, maxScoreOffset = MAX_SCORE_OFFSET, compact = false }: LabelOptions): { labels: MatrixLabel[]; missed: LabelUnit[] } {
  const missed: LabelUnit[] = [];
  const plotBottom = p.m.t + plotHeight(p);
  const plotRight = p.w - p.m.r;
  const centre = xForLean(0, p);
  const dots: Box[] = points.map((pt) => ({ x0: pt.x - p.r, x1: pt.x + p.r, y0: pt.y - p.r, y1: pt.y + p.r }));
  const placed: Box[] = [];
  const leaders: Seg[] = [];
  const out: MatrixLabel[] = [];
  // Labels may use the left margin between the axis words, never the words
  // themselves (2026-09-26: labels ran into them).
  const axisWords = axisWordBoxes(p);
  const boxFits = (box: Box) =>
    box.x0 >= LEFT_EDGE && box.x1 <= plotRight && box.y0 >= p.m.t - BOX_ABOVE && box.y1 <= plotBottom &&
    !axisWords.some((b) => overlaps(b, box)) &&
    !placed.some((b) => overlaps(b, box)) && !dots.some((d) => overlaps(d, box));
  // A leader may not cross another leader or run through another label or
  // dot, and a new label may not sit on an earlier leader.
  const leaderFits = (seg: Seg, box: Box, own: readonly number[]) =>
    !leaders.some((l) => segmentsCross(l, seg)) && !placed.some((b) => segmentHitsBox(seg, b)) &&
    !leaders.some((l) => segmentHitsBox(l, box)) &&
    !points.some((pt, i) => !own.includes(pt.id) && segmentHitsBox(seg, dots[i]!)) &&
    !axisWords.some((b) => segmentHitsBox(seg, b));
  const maxDy = maxScoreOffset * (plotHeight(p) / (PH_MAX - PH_MIN));
  const nearScore = (u: LabelUnit, box: Box) => Math.abs((box.y0 + box.y1) / 2 - u.y) <= maxDy;
  const maxSteps = Math.ceil(plotHeight(p) / WIDE_STEP);
  const maxReach = plotWidth(p);

  for (const u of units) {
    const rows = unitRows(u, compact, p);
    const d = dimsFor(rows);
    // Prefer the side facing the open middle of the chart's own half.
    const sides: Array<"start" | "end"> = u.x > centre ? ["end", "start"] : ["start", "end"];
    let chosen: Spot | null = null;
    // The near spots, in the order approved on 2026-09-26.
    search: for (const reach of LABEL_REACH) for (const dy of LABEL_STEPS) {
      for (const anchor of sides) {
        const spot = besideSpot(u, d, anchor, reach, dy, p);
        if (nearScore(u, spot.box) && boxFits(spot.box) && leaderFits(leaderFor(u, spot, p), spot.box, u.ids)) { chosen = spot; break search; }
      }
    }
    // The wide search: anywhere within reach of the dot, nearest first.
    if (!chosen) {
      let best: { spot: Spot; cost: number } | null = null;
      const consider = (spot: Spot, cost: number) => {
        if (best && cost >= best.cost) return;
        if (distanceToBox(u.x, u.y, spot.box) > maxDistance || !nearScore(u, spot.box) || !boxFits(spot.box)) return;
        if (!leaderFits(leaderFor(u, spot, p), spot.box, u.ids)) return;
        best = { spot, cost };
      };
      for (let k = 0; k <= maxSteps; k++) {
        for (const above of [true, false]) consider(verticalSpot(u, d, above, k, p), k * WIDE_STEP + VERTICAL_PENALTY);
      }
      for (let reach = 0; reach <= maxReach; reach += LABEL_REACH[1]!) {
        for (let i = -maxSteps; i <= maxSteps; i++) {
          for (const anchor of sides) consider(besideSpot(u, d, anchor, reach, i * WIDE_STEP, p), reach + Math.abs(i) * WIDE_STEP);
        }
      }
      chosen = (best as { spot: Spot } | null)?.spot ?? null;
    }
    if (!chosen) { missed.push(u); continue; }
    const leader = leaderFor(u, chosen, p);
    placed.push(chosen.box);
    leaders.push(leader);
    out.push({ ids: u.ids, x: chosen.x, y: chosen.y, anchor: chosen.anchor, rows, compact, leader });
  }
  return { labels: out, missed };
}

// When a label has nowhere to go: first grow the chart a little, which spreads
// the dots apart; then let labels sit a little further out; then switch the
// whole chart to one-line labels ("NPR 1.6 Grounded"), half the height. A
// chart where everything fits keeps the two-line labels approved 2026-09-26.
// Each stage is (one-line labels, furthest label distance, furthest score
// offset, most added height). Leaders never cross at any stage; only the last
// stage, a safeguard no real edition has needed, lifts the distance limits.
const GROW_STEP = 40;
const FIT_STAGES: ReadonlyArray<readonly [boolean, number, number, number]> = [
  [false, MAX_LABEL_DISTANCE, MAX_SCORE_OFFSET, 80],
  [false, 80, MAX_SCORE_OFFSET, 160],
  [true, MAX_LABEL_DISTANCE, MAX_SCORE_OFFSET, 160],
  [true, 80, MAX_SCORE_OFFSET, 320],
  [true, 120, 0.5, 480],
  [true, Infinity, Infinity, 800],
];

export interface FittedMatrix {
  p: MatrixPreset;
  points: MatrixPoint[];
  labels: MatrixLabel[];
  // Which FIT_STAGES entry placed every label; 0 is the approved look.
  stage: number;
}

// The preset, points and labels for one chart, with every dot labelled.
export function fitMatrix(members: readonly StoryMemberDTO[], presetName: MatrixPresetName): FittedMatrix {
  const base = presetFor(presetName, plottedMembers({ members: [...members] }).length);
  let fallback: FittedMatrix | null = null;
  for (const [stage, [compact, maxDistance, maxScoreOffset, maxGrow]] of FIT_STAGES.entries()) {
    for (let grow = 0; grow <= maxGrow; grow += GROW_STEP) {
      const p = grow === 0 ? base : { ...base, h: base.h + grow };
      const points = matrixPoints(members, p);
      const labels = layoutLabels(points, p, { maxDistance, maxScoreOffset, compact });
      if (labelledCount(labels) === points.length) return { p, points, labels, stage };
      if (!fallback || labelledCount(labels) > labelledCount(fallback.labels)) fallback = { p, points, labels, stage };
    }
  }
  return fallback!;
}

// The dots that got no label in the chart; the figure names them underneath.
export function unlabelledPoints(points: readonly MatrixPoint[], labels: readonly MatrixLabel[]): MatrixPoint[] {
  const labelled = new Set(labels.flatMap((l) => l.ids));
  return points.filter((pt) => !labelled.has(pt.id)).sort((a, b) => b.composite - a.composite);
}

// ── The hollow lane ─────────────────────────────────────────────────────────
//
// A headline-only member has no score and no lean, so it cannot sit on the
// plot. It gets a hollow dot in a lane under the axis, spaced by index. When
// the outlet names fit, each dot is labelled; when they do not, the lane
// carries one summary line naming every outlet, so no report is ever dropped.

export interface HollowDot {
  id: number;
  x: number;
  name: string;
  title: string;
}

export interface HollowLane {
  y: number;
  dots: HollowDot[];
  labelled: boolean;
  summary: string;
}

const LANE_LABEL_PADDING = 8;
export const HOLLOW_LANE_TITLE = "Headline only";

export function hollowLane(members: readonly StoryMemberDTO[], p: MatrixPreset): HollowLane | null {
  const hollow = hollowMembers({ members: [...members] });
  if (hollow.length === 0) return null;
  const pw = plotWidth(p);
  // One dot per outlet (2026-09-26: an outlet that filed twice showed as two
  // identical "New York Times" dots); a repeat is counted in its label.
  const byOutlet = new Map<string, { id: number; count: number }>();
  for (const m of hollow) {
    const name = outletShortName(m.outletName);
    const seen = byOutlet.get(name);
    if (seen) seen.count += 1;
    else byOutlet.set(name, { id: m.articleId, count: 1 });
  }
  const n = byOutlet.size;
  const dots: HollowDot[] = [...byOutlet.entries()].map(([outlet, { id, count }], i) => {
    const name = count > 1 ? `${outlet} ×${count}` : outlet;
    return { id, x: p.m.l + (pw * (i + 0.5)) / n, name, title: `${outlet} · ${count > 1 ? `${count} reports, ` : ""}headline only, not scored` };
  });
  const widest = Math.max(...dots.map((d) => d.name.length)) * p.charW + LANE_LABEL_PADDING;
  const labelled = widest * n <= pw;
  const names = dots.map((d) => d.name).join(", ");
  return {
    y: p.h + p.laneHeight / 2,
    dots,
    labelled,
    summary: `${n} headline only: ${names}`,
  };
}

// ── Screen-reader description ───────────────────────────────────────────────

export function matrixDescription(members: readonly StoryMemberDTO[]): string {
  const story = { members: [...members] };
  const parts: string[] = [];
  for (const m of plottedMembers(story)) {
    parts.push(`${outletShortName(m.outletName)}: P/H ${scoreText(m.composite)}, lean ${m.politicalLean}${m.kind === "syndicated" ? ", wire copy" : ""}`);
  }
  const pending = pendingMembers(story);
  if (pending.length > 0) parts.push(`Not yet scored: ${pending.map((m) => outletShortName(m.outletName)).join(", ")}`);
  return parts.join("; ");
}
