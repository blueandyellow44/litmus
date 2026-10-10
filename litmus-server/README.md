# litmus-server

Node + TypeScript backend. Owns all Claude API calls, RSS ingestion, content extraction, P/H scoring, story clustering, and on-demand translation. Persists to Postgres.

## Dirs

- `src/api/` — HTTP handlers (clusters, articles, sources, translations)
- `src/ingestion/` — RSS poll, Readability extract, paywall detect, dedupe
- `src/scoring/` — P/H scoring pipeline + calibration rules
- `src/clustering/` — topic clustering
- `src/translation/` — on-demand bias-stripped translation
- `src/workers/` — cron workers (ingest, score, cluster)
- `src/db/` — schema + pg client + per-table repos
- `src/lib/` — anthropic client, env loader, logger
- `sources/` — seed source library (RSS URLs + lean tags)

No code yet. This is Phase 0.
