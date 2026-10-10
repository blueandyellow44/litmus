# Litmus — Architecture Blueprint

_Authored 2026-04-11. Derived from the build prompt + the `architect` agent workflow at `/path/to/workspace/.claude/agents/architect/AGENT.md`._

## 1. Patterns Identified

**None — greenfield.** `/path/to/litmus/` was empty at Phase 0. No `docs/architecture.md`, no `shared/types.ts`, no prior Litmus code in this directory. The previous version referenced in the build prompt is not in this folder.

## 2. Client / Server Split

Translating the architect's "server is authoritative" principle to a news app: **the server owns ingestion, extraction, scoring, clustering, and translation. The client renders cached results.** Users never trigger Claude API calls directly from the browser.

| Concern                       | Server                        | Client              |
| ----------------------------- | ----------------------------- | ------------------- |
| RSS polling                   | ✅ scheduled cron              | —                   |
| Content extraction            | ✅ Readability                 | —                   |
| Paywall detection             | ✅ word-count + domain rules   | —                   |
| P/H scoring (Claude)          | ✅ batched Haiku/Sonnet        | —                   |
| Story clustering              | ✅ Claude                      | —                   |
| Translation generation        | ✅ on-demand, cached           | —                   |
| Rendering, toggles, diff view | —                             | ✅                   |
| Source preferences            | —                             | ✅ localStorage      |

**Rationale:** Claude API keys never touch the client. Caching server-side means N users reading the same article = 1 scoring call. Rate-limit control is centralized.

## 3. State Design (Postgres Schema, sketch)

```sql
sources          (id, name, rss_url, lean, type, paywall_status, reliability, enabled)
articles         (id, source_id, url, title, author, published_at, raw_text,
                  word_count, extraction_status, paywall_flag, content_hash, fetched_at)
scores           (article_id PK, headline, language, sourcing, fallacies, structure,
                  composite, label, rationale_json, scored_at, model_used)
translations     (article_id PK, translated_text, diff_json, removed_fallacies_json,
                  generated_at, model_used)
clusters         (id, topic, summary, created_at, updated_at)
cluster_articles (cluster_id, article_id, PRIMARY KEY(cluster_id, article_id))
```

Separate `scores` and `translations` tables because scoring runs on every article (cheap, Haiku) and translation runs on-demand (expensive, Sonnet). Different lifecycles = different tables.

## 4. Component Design

**Server (`litmus-server/`):**

- `ingestion/` — `rssPoller.ts`, `extractor.ts` (Readability), `paywallDetector.ts`, `deduper.ts` (content-hash based)
- `scoring/` — `phScorer.ts` (Claude prompt + parse), `batchRunner.ts`, `calibration.ts` (the rules from the build prompt)
- `clustering/` — `topicClusterer.ts` (Claude call over recent headlines)
- `translation/` — `translator.ts` (Claude call, writes to DB)
- `db/` — `schema.sql`, `client.ts` (pg pool), `repos/` (one file per table)
- `api/` — `clusters.ts`, `articles.ts`, `sources.ts`, `translations.ts`
- `lib/` — `anthropic.ts` (single SDK client, model routing), `env.ts`, `logger.ts`
- `workers/` — `ingestCron.ts`, `scoreCron.ts`, `clusterCron.ts`

**Client (`litmus-client/`):**

- `src/pages/` — `ClusterList.tsx`, `ClusterDetail.tsx`, `ArticleDetail.tsx`, `SourceConfig.tsx`
- `src/components/` — `PHBadge.tsx`, `LeanBar.tsx`, `ClusterCard.tsx`, `ArticleSplitView.tsx`, `DiffHighlight.tsx`, `SourceToggle.tsx`, `PaywallBadge.tsx`
- `src/lib/` — `api.ts` (fetch wrappers), `prefs.ts` (localStorage)
- `src/styles/` — Tailwind config + `tokens.css` (Quiet Reader type scale: 16px sans document default, serif reading sizes 18-24, label roles 11.5-14; high contrast palette)

## 5. Data Flow

```
RSS cron (15m) → fetch feeds → for each new item:
  dedupe by content_hash → extract → detect paywall →
  INSERT articles → enqueue scoring

score cron (5m) → SELECT unscored → batch 10 →
  Haiku P/H call → parse → INSERT scores → enqueue clustering

cluster cron (30m) → SELECT recent scored articles →
  Claude topic call → UPSERT clusters / cluster_articles

user clicks article → GET /api/articles/:id →
  if translations row exists → return
  else → Sonnet translation call → INSERT → return
```

## 6. Implementation Sequence

- **Phase 0 — Scaffold only (current).** Folder tree + README stubs + tasks files + this blueprint. No package.json, no code.
- **Phase 1 — DB + ingestion.** Schema, one source, extract + store.
- **Phase 2 — Scoring pipeline.** Haiku batched, calibration rules, rationale capture.
- **Phase 3 — API layer.** Clusters, articles, sources endpoints.
- **Phase 4 — Frontend shell.** Routing, tokens, empty states.
- **Phase 5 — Cluster list + article detail.**
- **Phase 6 — Translation on-demand + diff view.**
- **Phase 7 — Source config + custom RSS.**
- **Phase 8 — Clustering cron.**

## 7. Performance Considerations

- **Token budget:** ~50 sources × ~20 articles/poll × Haiku scoring ≈ cheap at a 15m cadence. Sonnet only on translation click + clustering. Batch scoring (10 articles per prompt) to amortize overhead.
- **Cache aggressively:** scored + translated content is immutable per `(article_id, model_used)`. Never re-score.
- **Dedup before spend:** content-hash compare BEFORE any Claude call. AP wire story syndicated to 8 outlets = 1 score, 8 article rows pointing at shared content.
- **Mobile-first type:** 16px sans default, 1.55 line-height, max-width 65ch; reading text opts into the serif at 18px+. On mobile all running prose is 16px or larger, and only labels, meta lines and chart annotations go below it. Revised 2026-09-13 (C1) from the original 18px serif body: the Quiet Reader direction splits the faces by role rather than setting one blanket floor, so the floor now binds where it matters (prose) instead of on every label. Rationale lives in `litmus-client/src/styles/tokens.css`; the mobile floor is enforced by `src/lib/brand.test.ts`.

---

## Decision: Two independent packages, not a workspaces monorepo

### Context
Need to choose between side-by-side `litmus-server/` + `litmus-client/` with two package.jsons, an npm workspaces monorepo with a shared `packages/types/`, or a single package where Express serves the Vite build.

### Client-Server Impact
- Client: standalone Vite app, its own package.json and tsconfig
- Server: standalone Node app, its own package.json and tsconfig
- Shared: none — types duplicated at the boundary, manually kept in sync

### Decision
Side-by-side. Two packages under `LITMUS2/`. No workspaces, no shared package.

### Rationale
Workspaces add config overhead and a build-order dependency for a small number of shared types. At this stage the shared surface is 3–4 interfaces (Article, Score, Translation, Cluster). Duplication is cheaper than tooling. If the shared surface grows past ~10 types, revisit.

### Performance Implications
- Rendering: no effect
- Network: no effect
- Memory: no effect

---

## Decision: Score on ingest, translate on demand

### Context
Claude API calls are the dominant cost. Every article doesn't need a translation — most users scan cluster lists. But every article DOES need a P/H score to be useful.

### Client-Server Impact
- Client: shows P/H badge immediately for cached scored articles; blocks with a spinner on translation click until the row exists
- Server: two separate pipelines — scoreCron runs on a timer, translator runs on demand from an API handler
- Shared: a `translation_status` state the client can poll if translation is slow

### Decision
Score during ingestion using **Haiku** (cheap, batched 10 articles/call). Generate translations **only** when a user clicks into the article detail view, using **Sonnet**. Cache forever in `translations` table keyed by `article_id`.

### Rationale
Scoring N articles with Haiku and then translating only the M that users actually read (M << N) is dramatically cheaper than translating everything up front. The "cache forever" part works because source article text is immutable once published — the content hash protects us from editorial changes by treating those as new articles.

### Performance Implications
- Rendering: first click on an article has a ~2–5s wait the first time it's ever opened; instant thereafter
- Network: translation endpoint is slow-and-rare; scoring endpoint isn't exposed to clients at all
- Memory: translations table grows roughly with engagement, not with ingestion volume

---

## Decision: the edition manifest is the masthead's only source of truth

_Added 2026-07-26._

### Context
The static snapshot carried `frozenAt`, which no client code read, and `Layout.tsx` printed `new Date()` as the dateline. A bundle whose content was fetched 2026-07-11 therefore displayed the reader's current date. The deployed Pages edition was observed in exactly that state on 2026-07-26: it loaded correctly, and it looked like today's paper.

### Client-Server Impact
- Client: `lib/edition.ts` owns the fresh/stale/unknown verdict; `Layout.tsx` renders "Edition compiled …" plus a notice when the edition is not fresh. No API change.
- Server: unchanged. No endpoint, schema, or scoring change.
- Build: `scripts/edition-manifest.mjs` derives the manifest; `scripts/build-snapshot.mjs` writes it into `snapshot.edition`.

### Decision
Every snapshot carries a typed `edition` manifest: `schemaVersion`, `buildCompletedAt`, `sourceLatestFetchAt` (max `fetchedAt` across articles — real content evidence, not build time), the article/detail/cluster/section counts, and `staleAfterHours`. The displayed date derives from that record. The browser clock measures age only; it can never originate a date or a "fresh" verdict.

Staleness threshold is **18 hours** (originally 36 for a once-daily paper; tightened 2026-07-26 with the twice-daily cadence), named once in `scripts/edition-manifest.mjs` and mirrored in `litmus-client/src/lib/edition.ts`. Under the 5:15 AM / 8:15 PM Pacific schedule, 18 hours means a missed edition is disclosed within the same day rather than surviving behind a "fresh" label for a day and a half.

Three states, with unknown as the safe default: missing, malformed, future-dated, self-contradictory (content newer than its own build), or zero-article manifests all resolve to unknown. Only a manifest that parses cleanly and is inside the window reads fresh.

### Rationale
Stale data under a current date is the failure that costs a news product its credibility outright. Honest staleness is recoverable; a false dateline is not. Deriving the cutoff from `fetchedAt` rather than build time also means a build that succeeds over stale inputs still reads stale.

### Performance Implications
- Rendering: one extra small read from the already-imported snapshot; no new request.
- Network: none.
- Memory: negligible (manifest is ~10 fields).

---

## Decision: a failed snapshot build must not replace a good edition

_Added 2026-07-26._

### Context
`build-snapshot.mjs` wrote `JSON.stringify(snapshot)` directly to the output path with no gate. Every `get()` returning null still produced a well-formed, empty snapshot that overwrote the previous one.

### Decision
`reasonsNotToPublish()` gates the write (manifest present and parseable, at least one article, at least one article detail, at least one section — an empty cluster list is legal on a quiet news day). Failing the gate exits 1 without touching the output. A passing build writes to `snapshot.json.tmp` and `rename()`s it into place, so a crash mid-write cannot leave a truncated file. `refresh.sh` runs under `set -euo pipefail`, so a non-zero snapshot step aborts before the client build and the Pages deploy. No CI or Cloudflare configuration was changed.

### Rationale
Yesterday's honest paper beats today's empty one. The manifest makes the tradeoff visible to the reader rather than silent.

---

## Decision: claim receipts are article-level, and confirmation is earned

_Added 2026-07-26. Offline prototype, three clusters._

### Context
"The Facts" renders `cluster.summary`, a model-generated synthesis. It carries no atomic claims, no dispute state, and no source links.

### Decision
`litmus-client/src/lib/claims.ts` defines a receipt: stable id, cluster id, claim text in LITMUS's own words, a status, and source references carrying only fields the snapshot actually has (`articleId`, `url`, `publisher`, `publishedAt`, `kind`, optional `paywalled`).

- **confirmed** — two independent reporting sources (distinct publishers) or one identifiable primary record. Two articles from the same outlet do not corroborate.
- **contested** — two or more conflicting positions, each independently sourced. The disagreement is the finding; it is not resolved for the reader.
- **unknown** (rendered "Unverified") — an honest state, not an error.

`normalizeReceipt()` enforces this at render time: a receipt asserting "confirmed" without the evidence is **downgraded to unknown and says why**, rather than being hidden. Generated fields — the article summary, the P/H composite, the political-lean number — are never treated as evidence.

Legal posture per `the excerpt policy`: receipts reproduce no article text. Claim wording is ours, every source is a link out, and paywalled sources are labeled "paywalled, link only". The verifier asserts no claim string appears verbatim in any `rawText`.

Data lives in `litmus-client/src/demo/claim-receipts.json` (tracked, hand-authored) rather than inside `snapshot.json` (gitignored, regenerated by the daily funnel), so the funnel cannot silently erase it. This is prototype review material for clusters 12, 18, and 13, not pipeline output; nothing generates receipts automatically yet.

---

## Decision: two named editions a day, and a refresh must be complete to publish

_Added 2026-07-26, closing the failed gates of the rewspaper-foundation audit._

### Context
Every scheduled GitHub Actions run from 2026-07-12 through 2026-07-26 (15 runs) died in the install step: the workflow's client install command redefined `cd` as a recursive shell function, and Bash segfaulted with exit 139 before the funnel started. Separately, an adversarial audit fixture proved the snapshot publish gate accepted destructively incomplete output: with 7 of 8 section endpoints plus `/sources` and `/clusters` failing, the build exited 0 and replaced a 1.7 MB snapshot with a ~1 KB one.

### Decision
**Cadence.** Exactly two automatic editions per Pacific day — 5:15 AM and 8:15 PM `America/Los_Angeles`, using GitHub's timezone-aware schedule syntax — plus `workflow_dispatch` for recovery. Not continuous: a rewspaper is a finite edition, and continuous rebuilding adds churn, overlapping-run risk, and repeated scoring/clustering cost before reader demand proves it useful. One concurrency group, `cancel-in-progress: false`, so a late morning build queues the night build instead of colliding with it.

**Workflow hygiene.** Separate `working-directory` install steps (no shell function games), current major actions (`actions/checkout@v7`, `actions/setup-node@v7`, Node 22, npm cache over both lockfiles), and a fail-fast preflight that reports missing required secret NAMES — never values — before anything installs.

**Publish gate.** `reasonsNotToPublish(snapshot, context)` now judges completeness against what the build *expected*, not just what it got: every expected section page present, a detail record for every article summary, non-empty source metadata, and a per-endpoint failure ledger (non-2xx, malformed JSON, network error) that blocks on any entry. Empty clusters remain legal — a quiet news cycle is not a failure. The atomic temp+rename write is unchanged. `SNAPSHOT_OUT` lets the verifier run the real `build-snapshot.mjs` against fixture APIs end to end, so the safety property is tested on the shipped code path rather than a mirror of it.

### Rationale
"Non-empty" was the wrong invariant — it certified that *something* was fetched, not that an *edition* was fetched. The reader-facing contract is the edition: all sections, every story openable, sources attributable. Anything less preserves yesterday's honest paper.

### Known unresolved risk (recorded, deliberately not fixed here)
Claim receipts are keyed to database cluster SERIAL IDs, and `clustersRepo.replaceAllClusters` deletes and reinserts clusters with new IDs on every run. A successful refresh can orphan the hand-authored receipt prototype (clusters 12, 13, 18). Resolving that — stable story identity or explicit expiry with the frozen edition — is a separate decision, out of this pipeline task's scope.
