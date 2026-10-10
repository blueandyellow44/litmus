// The Quiet Reader neutrals and highlight colours as hex, for the places a
// Tailwind class cannot reach (SVG fills and strokes, inline styles) and for the
// contrast tests.
//
// Source: design/rebrand-2026-09-13/quiet-reader/brand.md section 2. The same
// literals appear in tailwind.config.js and src/styles/tokens.css; there is no
// build step that lets a JS config import this TypeScript file, so
// palette.test.ts reads both of those files and fails when a value drifts.
//
// The P/H ramp is NOT here. It lives in phBand.ts beside the band boundaries,
// because a band's colour and its range are one fact.

export const PALETTE = {
  // Page background: warm light grey, chroma near zero. Deliberately not cream;
  // cream was the newsprint identity this replaces.
  ground: "#F1F0ED",
  // Cards, evidence boxes, pills, the halo behind a plotted dot.
  surface: "#FAF9F7",
  // Headlines, story text, quotes.
  ink: "#1E1F22",
  // Secondary text and meta.
  ink2: "#45464B",
  // Tertiary text, micro labels, axis labels. The lightest colour text may use.
  ink3: "#63646A",
  // Hairlines between stories and rows. Decorative, so no contrast floor.
  rule: "#D9D7D2",
  // Matrix gridlines.
  grid: "#E2E0DB",
  // A boundary that identifies a control (a select, an outlined toggle). WCAG
  // 1.4.11 wants 3:1 against the ground for that, which --rule does not give.
  // Darker than the design's dashed #8C8D91, which measures 2.91:1 on ground.
  ruleStrong: "#838488",
  // Loaded wording: warm fill plus a warm underline.
  tint: "#F7E1C4",
  hotLine: "#B2511E",
  // Grounded wording: a cool underline and no fill.
  coolLine: "#75838A",
} as const;

export type PaletteToken = keyof typeof PALETTE;

// The tokens text is set in, and the grounds it is set on. palette.test.ts holds
// every pair to WCAG AA.
export const TEXT_TOKENS = ["ink", "ink2", "ink3"] as const satisfies readonly PaletteToken[];
export const TEXT_GROUNDS = ["ground", "surface", "tint"] as const satisfies readonly PaletteToken[];
