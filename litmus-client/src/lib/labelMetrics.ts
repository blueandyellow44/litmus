// Glyph widths of the chart's label font, so a label's box is its real width
// rather than an estimate per character (a centre dot missed the room beside
// it by 2px on the estimate, 2026-10-09). Measured in Chrome with canvas
// measureText: Instrument Sans, 600 at 11.5px for names and 400 at 11px for
// scores, in ems. Order: printable ASCII from space to "~", then ’, é,
// ×, –.

const GLYPHS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("") + "’é×–";

const NAME_EMS = [
  0.193, 0.295, 0.449, 0.727, 0.637, 0.786, 0.768, 0.256, 0.439, 0.439, 0.43, 0.544, 0.275, 0.493, 0.275, 0.444,
  0.677, 0.387, 0.557, 0.579, 0.615, 0.581, 0.615, 0.561, 0.598, 0.619, 0.275, 0.275, 0.544, 0.544, 0.544, 0.58,
  0.867, 0.733, 0.645, 0.747, 0.755, 0.63, 0.594, 0.764, 0.725, 0.254, 0.427, 0.712, 0.589, 0.898, 0.725, 0.794,
  0.667, 0.806, 0.664, 0.637, 0.664, 0.704, 0.733, 1.087, 0.707, 0.7, 0.631, 0.439, 0.444, 0.439, 0.544, 0.466,
  0.354, 0.558, 0.621, 0.552, 0.621, 0.571, 0.37, 0.621, 0.612, 0.26, 0.26, 0.558, 0.26, 0.941, 0.612, 0.597,
  0.621, 0.621, 0.39, 0.494, 0.406, 0.604, 0.536, 0.8, 0.587, 0.536, 0.513, 0.439, 0.234, 0.439, 0.544, 0.275,
  0.571, 0.544, 0.599,
];

const SCORE_EMS = [
  0.2, 0.273, 0.384, 0.716, 0.608, 0.786, 0.755, 0.232, 0.406, 0.406, 0.408, 0.531, 0.255, 0.506, 0.255, 0.443,
  0.666, 0.391, 0.545, 0.574, 0.6, 0.574, 0.599, 0.532, 0.582, 0.61, 0.255, 0.255, 0.531, 0.531, 0.531, 0.567,
  0.853, 0.728, 0.636, 0.741, 0.752, 0.638, 0.602, 0.765, 0.736, 0.254, 0.455, 0.692, 0.588, 0.906, 0.736, 0.786,
  0.656, 0.787, 0.656, 0.608, 0.648, 0.712, 0.728, 1.089, 0.688, 0.676, 0.623, 0.406, 0.443, 0.406, 0.531, 0.426,
  0.354, 0.533, 0.606, 0.533, 0.606, 0.564, 0.354, 0.606, 0.599, 0.24, 0.24, 0.535, 0.24, 0.922, 0.599, 0.584,
  0.606, 0.606, 0.375, 0.473, 0.377, 0.589, 0.523, 0.767, 0.551, 0.523, 0.496, 0.406, 0.242, 0.406, 0.531, 0.255,
  0.564, 0.531, 0.586,
];

// A glyph not in the table counts as a wide one.
const UNKNOWN_EM = 0.75;
// Headroom for a fallback font before Instrument Sans loads, which runs a
// little wider.
const FALLBACK_HEADROOM = 1.06;

export const NAME_FONT_SIZE = 11.5;
export const SCORE_FONT_SIZE = 11;

function ems(text: string, table: readonly number[]): number {
  let total = 0;
  for (const ch of text) {
    const i = GLYPHS.indexOf(ch);
    total += i >= 0 ? table[i]! : UNKNOWN_EM;
  }
  return total;
}

export function nameWidth(text: string): number {
  return ems(text, NAME_EMS) * NAME_FONT_SIZE * FALLBACK_HEADROOM;
}

export function scoreWidth(text: string): number {
  return ems(text, SCORE_EMS) * SCORE_FONT_SIZE * FALLBACK_HEADROOM;
}

export const AXIS_FONT_SIZE = 13;

// An axis word such as "Mixed Signals 3", set at 13px.
export function axisWordWidth(text: string): number {
  return ems(text, SCORE_EMS) * AXIS_FONT_SIZE * FALLBACK_HEADROOM;
}
