# src/styles

Design tokens and global styles for the Quiet Reader direction
(`design/rebrand-2026-09-13/quiet-reader/brand.md`).

- `tokens.css` — the CSS custom properties: ground and surface, the three-step
  ink scale, rules and gridlines, the five-step P/H temperature ramp, and the two
  highlight treatments (`.hl-loaded`, `.hl-grounded`, referenced from
  `src/lib/highlight.ts`).
- Tailwind config lives at the project root (`tailwind.config.js`) and carries
  the same values as Tailwind colour names.
- `src/lib/palette.ts` holds the same neutrals as hex, for SVG fills and for the
  tests. `src/lib/palette.test.ts` reads all three files and fails when one
  drifts.

## Type

- Newsreader (serif) carries what a person reads: story text, headlines, quotes.
- Instrument Sans carries what a person scans: labels, scores, counts, nav.
- Both load from Google Fonts in `index.html`, with system fallbacks so a blocked
  request degrades the faces rather than the page.
- Running prose is 16px or larger, mobile included. Only labels, meta lines and
  chart annotations go below that: `text-micro` (11.5px caps label) and
  `text-meta` (13.5px counts and scores).
- Max measure: 65ch.

## Palette intent

A warm light grey ground, near-black ink in three weights, hairline rules. The
only colour is the P/H temperature ramp, and it only ever fills a mark: a dot or
a swatch. It never colours text and text is never set on it, because the ramp is
ordered by lightness and its calm end is too pale to read against. The number and
the band word always travel with the colour, so colour is never the only signal.
Lean is a position on a grey axis; red and blue as political colours are retired.
