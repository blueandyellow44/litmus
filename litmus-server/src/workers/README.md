# src/workers

Background cron workers. Each one is idempotent and safe to run concurrently with itself.

- `ingestCron.ts` — every 15m: pull all enabled feeds, extract, dedupe, store
- `scoreCron.ts` — every 5m: select unscored articles, batch them, send to Claude, write scores
- `clusterCron.ts` — every 30m: recluster the last ~24h of scored articles

Workers are separate processes from the API server in production, but can be run in-process during dev.
