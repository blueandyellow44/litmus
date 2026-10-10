# src/db

Postgres persistence layer.

- `schema.sql` — table definitions for a database built from nothing (sources, articles, scores, translations, clusters, cluster_articles)
- `migrations/` — everything that changes a database that already exists, including the story ledger (stories, story_members, story_runs, article_sweeps, sources.outlet_key). See `migrate.ts` and `migrations/README.md`.
- `client.ts` — shared pg pool
- `repos/` — one file per table, each exporting typed query functions (e.g. `findUnscoredArticles`, `insertScore`, `upsertCluster`)

No ORM. Plain SQL + typed wrappers. The schema is small enough that Kysely/Drizzle would be overkill.

See `docs/architecture.md` § 3 for the schema sketch.
