# src/ingestion

Turns RSS feeds into `articles` rows.

- `rssPoller.ts` — fetch each enabled source's feed through `lib/safeFetch.ts` and parse it with `rss-parser`; return new items not already in the DB
- `extractor.ts` — fetch the article page through `lib/safeFetch.ts` and pull full body text with `@extractus/article-extractor` (Mozilla Readability)

Every feed and article request goes through `lib/safeFetch.ts`, which reaches public internet addresses only (checked at the URL, at DNS, on connect, and on every redirect) and bounds the body size. Neither library is handed a URL to fetch itself (security baseline, 2026-10-07).
- `paywallDetector.ts` — flags `partial` when extracted text < 200 words AND the source is known-paywalled; otherwise `full`
- `deduper.ts` — content-hash (normalized title + first 500 chars of body). Since S2 (2026-09-13) the hash only COLLAPSES a match inside the same outlet (sister feeds); a match in another outlet is stored as a syndicated copy pointing at the original
- `articleRow.ts` — the pure per-item decision and the row's content hash (a row with a body hashes title + body; a headline-only row hashes title + publication day, so a recurring column is not mistaken for a duplicate of its own last edition): headline-only row for a zero-word extraction (title, url, date, no body; never scored or excerpted), skip for a same-outlet copy, syndicated row for a cross-outlet copy

Ingestion is invoked by `workers/ingestCron.ts` on a 15-minute cadence. It writes to `articles` and enqueues new rows for scoring. It never calls Claude.
