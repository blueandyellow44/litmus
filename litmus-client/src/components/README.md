# src/components

Reusable UI pieces. Keep them dumb — data in via props, events out via callbacks, no data fetching inside.

- `PHBadge.tsx` — the 1.0–5.0 score chip: a temperature swatch, the number and the band word. Ramp colour fills the swatch only, never text.
- `LeanBar.tsx` — the five-segment horizontal bar showing a cluster's lean distribution
- `ClusterCard.tsx` — the primary card used on `ClusterList`
- `ArticleSplitView.tsx` — side-by-side original/translated layout with a toggle
- `DiffHighlight.tsx` — inline highlighting of what changed between original and translated
- `SourceToggle.tsx` — enable/disable row used on `SourceConfig`
- `PaywallBadge.tsx` — the "Partial — behind paywall" flag

Styling via Tailwind. Design tokens come from `src/styles/tokens.css`.
