# litmus-client

React + Vite + Tailwind frontend. Reads from `litmus-server`'s API. Renders cluster lists, article detail (original + translated side-by-side with diff highlight), and source configuration.

## Design intent

Not a social feed. Not a dashboard. A calm reading instrument: the Quiet Reader
direction (`design/rebrand-2026-09-13/quiet-reader/brand.md`), a warm grey
ground, Newsreader for what a person reads and Instrument Sans for what a person
scans. The user is 50+, reads news daily on a tablet or large phone, and wants
clarity not complexity.

- A dedicated desktop version and a dedicated mobile version of every page
- Mobile-first at 375px
- Running prose 16px minimum; only labels and meta go smaller
- Large touch targets
- High contrast
- Generous whitespace; never more than one thing competing for attention
- Story clusters are the primary unit, not individual articles

## Dirs

- `src/pages/` — `ClusterList`, `ClusterDetail`, `ArticleDetail`, `SourceConfig`
- `src/components/` — `PHBadge`, `LeanBar`, `ClusterCard`, `ArticleSplitView`, `DiffHighlight`, `SourceToggle`, `PaywallBadge`
- `src/lib/` — `api.ts` (typed fetch wrapper), `prefs.ts` (localStorage preferences)
- `src/styles/` — Tailwind config + `tokens.css`

No code yet. This is Phase 0.
