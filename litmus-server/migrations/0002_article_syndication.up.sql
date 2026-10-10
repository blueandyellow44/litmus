-- 0002_article_syndication: ingest keeps outlets.
--
-- Plan phase S2 (docs/plans/story-first-build-2026-09-13.md); the design is
-- step 0 of docs/audits/aggregator-and-process-audit-2026-09-13.md section 3.
--
-- Two things ingest used to throw away now become rows:
--
--   1. Items whose extraction returned zero words (26 in one night's run).
--      They are stored as HEADLINE-ONLY rows: title, url, publication time, no
--      body. They exist so a story can list every outlet that covered it; they
--      never enter scoring or excerpts.
--   2. Cross-outlet copies of an article already stored (wire syndication).
--      They are stored with a pointer to the original so a story can show
--      "syndicated from X" without counting the copy as its own telling.
--
-- Additive only (README rule 2): one nullable column and two constraints that
-- no existing writer can violate, so the previous ingest keeps working through
-- the rollback window.

-- The original this row is a copy of. NULL for every article that is its own
-- telling, which is every row written before this migration.
ALTER TABLE articles ADD COLUMN syndicated_of_article_id INT REFERENCES articles (id) ON DELETE SET NULL;

-- A copy points one hop, never at itself. SET NULL on the original's deletion
-- keeps the copy as a row (it did cover the story) rather than silently
-- removing it; the story layer treats a dangling pointer as "original pruned".
ALTER TABLE articles ADD CONSTRAINT articles_not_syndicated_of_self
  CHECK (syndicated_of_article_id IS NULL OR syndicated_of_article_id <> id);

CREATE INDEX articles_syndicated_of_idx ON articles (syndicated_of_article_id)
  WHERE syndicated_of_article_id IS NOT NULL;

-- The legal posture from the excerpt policy, as a database fact: a headline-
-- only row carries no text at all. extraction_status = 'failed' is what marks
-- a row headline-only (the paywall detector assigns it exactly when the word
-- count is zero), and this constraint means no later writer can attach a body
-- to such a row without also changing its status. No 'failed' row can exist
-- before this migration: ingest skipped them instead of storing them.
ALTER TABLE articles ADD CONSTRAINT articles_headline_only_has_no_body
  CHECK (extraction_status <> 'failed' OR (word_count = 0 AND raw_text = ''));
