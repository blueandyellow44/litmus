/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Quiet Reader neutrals (design/rebrand-2026-09-13/quiet-reader/brand.md
        // section 2). A warm light grey ground, near-black ink in three steps, and
        // hairline rules. No cream, no newsprint.
        //
        // MUST STAY IN SYNC with PALETTE in src/lib/palette.ts, which is what SVG
        // fills and the contrast tests read. src/lib/palette.test.ts parses this
        // file and fails when a value drifts.
        ground:        "#F1F0ED",
        surface:       "#FAF9F7",
        ink:           "#1E1F22",
        ink2:          "#45464B",
        ink3:          "#63646A",
        rule:          "#D9D7D2",
        "rule-strong": "#838488",
        grid:          "#E2E0DB",
        tint:          "#F7E1C4",
        "hot-line":    "#B2511E",
        "cool-line":   "#75838A",
        // P/H temperature ramp, ordered by lightness.
        //
        // MUST STAY IN SYNC with PH_BANDS in src/lib/phBand.ts, which is the
        // canonical table and the one an SVG fill reads (a Tailwind class
        // cannot resolve from arbitrary data). src/lib/phBand.test.ts holds the
        // measured ratios; scripts/check-band-parity.ts holds these two files and
        // the server's band table together.
        //
        // These fill marks only (a swatch, a dot). They never colour text and text
        // is never set on them: the two pale steps are under 2:1 on the ground.
        ph: {
          practical: "#c0c9ce", // 1.0–1.4 cool slate
          grounded:  "#b7ae8e", // 1.5–2.4 sand
          mixed:     "#c1893c", // 2.5–3.4 amber
          hot:       "#c05a16", // 3.5–4.4 burnt orange
          hysterical:"#ad3118", // 4.5–5.0 vermilion
        },
        // Lean segments. Grey only: red and blue as political colours are
        // retired, and lean is a position, not a team colour. Symmetric about
        // the centre so neither side reads as heavier; LeanBar separates
        // adjacent segments with a gap and LeanSpread names each one.
        lean: {
          left:        "#63646A",
          centerLeft:  "#9A9BA0",
          center:      "#C9C8C3",
          centerRight: "#9A9BA0",
          right:       "#63646A",
        },
      },
      fontFamily: {
        // Serif means "read this": story text, headlines, quotes.
        // Sans means "this is a label on the instrument": meta, scores, nav.
        // Both load from Google Fonts in index.html; the fallbacks are what a
        // reader gets when that request fails or is blocked.
        serif: ["Newsreader", "Georgia", '"Times New Roman"', "serif"],
        sans:  ['"Instrument Sans"', "system-ui", "-apple-system", '"Segoe UI"', "Roboto", "sans-serif"],
      },
      fontSize: {
        // `base` is the SERIF reading size, not the document default. The
        // document default is 16px sans and lives in src/styles/tokens.css,
        // which carries the decision that replaced the old blanket 18px floor.
        // Reading text (story assessments, quotes, article body) opts up into
        // text-base; label roles below opt down. brand.md section 3 is the table.
        base: ["18px", { lineHeight: "1.6" }],
        sm:   ["16px", { lineHeight: "1.5" }],
        h3:   ["22px", { lineHeight: "1.3", letterSpacing: "-0.01em" }],
        h2:   ["28px", { lineHeight: "1.25", letterSpacing: "-0.015em" }],
        h1:   ["34px", { lineHeight: "1.2",  letterSpacing: "-0.02em" }],
        // Quiet Reader label roles. `micro` is the caps label ("WHAT'S
        // ESTABLISHED"); pair it with `uppercase`. `meta` is counts, times and
        // scores; pair it with `tabular-nums`.
        micro: ["11.5px", { lineHeight: "1.3", letterSpacing: "0.12em" }],
        meta:  ["13.5px", { lineHeight: "1.3" }],
      },
      maxWidth: {
        prose: "65ch",
      },
    },
  },
  plugins: [],
};
