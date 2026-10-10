# Migrations

`schema.sql` creates a database from nothing. It is `CREATE TABLE IF NOT EXISTS`
throughout, so it can never alter a table that already exists — which means it
cannot express any of the schema work the repair plan needs (source identity,
edition lineage, versioned analyses). That work goes here.

## Rules

1. **Fresh databases** come from `schema.sql` (`npm run db:init:node`), then every
   migration applies in order. **Existing databases** only ever change through a
   migration. Nothing NEW edits `schema.sql` to change an existing table.

   Read that last sentence as a rule going forward, not as a description of the
   file. `schema.sql` still carries a legacy "Additive migrations (idempotent)"
   block of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements (articles,
   scores, clusters, sources — including `sources.prominence`) that predates this
   directory and runs on every `db:init`. It stays because databases in the wild
   depend on it. It is not a precedent: a new column goes in a numbered
   migration, where it has a checksum, a ledger row, and a reverse.
2. **Additive first, two-phase drops.** Add the new column/table, backfill,
   switch the readers, and only then remove the old one in a *later* migration.
   During the window between the two, old code and the previous edition must
   still work — that window is what makes rollback survivable.
3. **Every migration ships both directions, or says explicitly that it can't.**
   `NNNN_name.up.sql` and `NNNN_name.down.sql`. A migration with no honest
   reverse (a destructive drop) ships `NNNN_name.irreversible` instead of a
   `.down.sql` — a non-empty note explaining why there is no automatic reverse
   and what manual recovery requires. A migration is either reversible (has a
   `.down.sql`) or explicitly irreversible (has an `.irreversible` note), never
   both, and `migrate:up` refuses to apply one that has neither. Reversibility
   cannot change once a migration has run: adding, removing, or editing either
   file after the fact is drift, and `migrate:status`/`up`/`down` all refuse
   until it's reconciled.
4. **Applied inside one transaction**, recorded in `schema_migrations` in the
   same transaction. A failed migration leaves no partial state and no ledger row.
5. **Rehearse before production.** `npm run migrate:rehearse` restores a
   production-shaped dump into a scratch database and applies pending migrations
   there. A migration that has not been rehearsed does not go near production.
6. **Back up before applying to production.** For Neon that is a branch; for
   plain Postgres a `pg_dump`. Row counts printed by the tool are verification,
   not a backup, and not a rollback.

## Naming

`0001_short_name.up.sql` / `0001_short_name.down.sql`. Four-digit, zero-padded,
strictly increasing. The number is the ordering key; renaming an applied
migration breaks the ledger.

## Commands

    npm run migrate:status     # what is applied, what is pending
    npm run migrate:up         # apply pending, transactionally, in order
    npm run migrate:down       # reverse exactly the last applied migration
    npm run migrate:rehearse   # apply pending against a scratch copy first

`migrate:up` refuses to run against a non-local database unless
`ALLOW_PROD_MIGRATE=1` is set, and prints the plan before it applies anything.
