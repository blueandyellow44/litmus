-- 0001_story_ledger: the Story Ledger schema.
--
-- Plan phase S1 (docs/plans/story-first-build-2026-09-13.md); design in
-- docs/audits/aggregator-and-process-audit-2026-09-13.md section 3.
--
-- Additive only (README rule 2). The one change to an existing table is a
-- NULLABLE column on sources, and the clusters tables are untouched, so the
-- current clusterer, API and snapshot keep working until their readers switch.
-- outlet_key is deliberately not NOT NULL yet: Postgres checks NOT NULL on the
-- proposed row of an INSERT ... ON CONFLICT before it resolves the conflict, so
-- the previous seeder (which does not write the column) would fail on every
-- ingest during the rollback window. A later migration can tighten it once no
-- reader or writer predates it.

-- ── Outlet identity ─────────────────────────────────────────────────────
-- The roster lists feeds, not outlets: "New York Times — Politics" and
-- "New York Times — US" are two rows and one newsroom. One key per outlet stops
-- a story counting a newsroom twice.
ALTER TABLE sources ADD COLUMN outlet_key TEXT;
ALTER TABLE sources ADD CONSTRAINT sources_outlet_key_format
  CHECK (outlet_key IS NULL OR outlet_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- One-time backfill so existing rows have a key the moment this applies. It is
-- the SQL mirror of outletKeyFromName (src/ingestion/outletKey.ts): the part of
-- the name before " — ", ASCII letters and digits only, lowercased, hyphenated.
-- sources/seed.json carries the authoritative explicit key per feed and the
-- seeder overwrites this on the next ingest, which refresh.sh runs right after
-- the schema step. The integration test proves the two derivations agree over
-- every seed name.
UPDATE sources
SET outlet_key = NULLIF(
  btrim(lower(regexp_replace(split_part(name, ' — ', 1), '[^A-Za-z0-9]+', '-', 'g')), '-'),
  ''
)
WHERE outlet_key IS NULL;

CREATE INDEX sources_outlet_key_idx ON sources (outlet_key);

-- ── Runs ────────────────────────────────────────────────────────────────
-- One row per story-stage run. counts and usage are JSON so the coverage report
-- can grow fields without a migration; they must stay objects so a reader can
-- always index into them.
CREATE TABLE story_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  counts          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- True only when every leftover article was checked against every open
  -- story. A run that never finished cannot claim that.
  sweep_complete  BOOLEAN NOT NULL DEFAULT FALSE,
  usage           JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT story_runs_finished_after_start
    CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT story_runs_sweep_needs_finish
    CHECK (NOT sweep_complete OR finished_at IS NOT NULL),
  CONSTRAINT story_runs_counts_object CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT story_runs_usage_object  CHECK (jsonb_typeof(usage) = 'object')
);

-- ── Stories ─────────────────────────────────────────────────────────────
-- The id is minted once in code (src/stories/identity.ts) and never reused, so
-- a link to a story survives every later run. It is text, never a serial: the
-- clusters table's regenerated serials are what orphaned the old receipts.
CREATE TABLE stories (
  id                       TEXT PRIMARY KEY
                           CONSTRAINT stories_id_format CHECK (id ~ '^st_[0-9A-HJKMNP-TV-Z]{26}$'),
  slug                     TEXT NOT NULL UNIQUE
                           CONSTRAINT stories_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  section                  TEXT,
  headline                 TEXT NOT NULL CONSTRAINT stories_headline_present CHECK (btrim(headline) <> ''),
  event_statement          TEXT NOT NULL CONSTRAINT stories_event_statement_present CHECK (btrim(event_statement) <> ''),
  assessment_text          TEXT,
  assessment_model         TEXT,
  assessment_generated_at  TIMESTAMPTZ,
  -- The membership the current assessment was written for. The assessment
  -- stage regenerates only when the live membership hashes differently. NULL
  -- means never assessed.
  membership_hash          TEXT,
  first_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Moves when a member is ADDED, so "no new member for 7 days" (dormancy) is
  -- readable straight off this column.
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                   TEXT NOT NULL DEFAULT 'open'
                           CONSTRAINT stories_status_known CHECK (status IN ('open', 'dormant', 'merged')),
  -- Where a merged story's readers go. The absorbed row is kept, not deleted,
  -- so its id still resolves.
  merged_into              TEXT REFERENCES stories (id),
  -- An assessment is all three fields or none: a text with no model or date
  -- cannot be disclosed honestly.
  CONSTRAINT stories_assessment_complete CHECK (
    (assessment_text IS NULL) = (assessment_model IS NULL)
    AND (assessment_text IS NULL) = (assessment_generated_at IS NULL)
  ),
  CONSTRAINT stories_assessment_has_hash CHECK (assessment_text IS NULL OR membership_hash IS NOT NULL),
  CONSTRAINT stories_merge_pointer CHECK ((status = 'merged') = (merged_into IS NOT NULL)),
  CONSTRAINT stories_not_merged_into_self CHECK (merged_into IS NULL OR merged_into <> id)
);

CREATE INDEX stories_status_updated_idx ON stories (status, updated_at DESC);

-- ── Members ─────────────────────────────────────────────────────────────
CREATE TABLE story_members (
  story_id                  TEXT NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  article_id                INT  NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  -- Ruling 2: a roundup can be a secondary member of several stories and never
  -- counts as a telling. A primary member belongs to exactly one story (index
  -- below).
  role                      TEXT NOT NULL CONSTRAINT story_members_role_known CHECK (role IN ('primary', 'secondary')),
  kind                      TEXT NOT NULL CONSTRAINT story_members_kind_known CHECK (kind IN ('full', 'headline_only', 'syndicated')),
  -- SET NULL, not CASCADE: pruning an original must not silently remove the
  -- copy's membership. The pointer is therefore one-way (a pointer implies
  -- syndicated), and a syndicated member whose original is gone reads null,
  -- which the contract already allows.
  syndicated_of_article_id  INT REFERENCES articles (id) ON DELETE SET NULL,
  confidence                TEXT NOT NULL CONSTRAINT story_members_confidence_known CHECK (confidence IN ('high', 'medium', 'low')),
  -- Every join is auditable after the fact, including deterministic ones.
  reason                    TEXT NOT NULL CONSTRAINT story_members_reason_present CHECK (btrim(reason) <> ''),
  -- NULL for a manual or bootstrap attach that ran outside a recorded run.
  added_run_id              BIGINT REFERENCES story_runs (id) ON DELETE SET NULL,
  added_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (story_id, article_id),
  CONSTRAINT story_members_pointer_implies_syndicated
    CHECK (syndicated_of_article_id IS NULL OR kind = 'syndicated'),
  CONSTRAINT story_members_not_syndicated_of_self
    CHECK (syndicated_of_article_id IS NULL OR syndicated_of_article_id <> article_id)
);

CREATE UNIQUE INDEX story_members_one_primary_story ON story_members (article_id) WHERE role = 'primary';
CREATE INDEX story_members_article_idx ON story_members (article_id);

-- ── Sweep record ────────────────────────────────────────────────────────
-- One row per (run, article, shard of open stories). This is what makes "every
-- leftover article was asked about every open story" a checkable fact instead
-- of a hope: the sum of stories_checked per article must reach the open count.
CREATE TABLE article_sweeps (
  run_id           BIGINT NOT NULL REFERENCES story_runs (id) ON DELETE CASCADE,
  article_id       INT    NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  shard            INT    NOT NULL CONSTRAINT article_sweeps_shard_nonnegative CHECK (shard >= 0),
  stories_checked  INT    NOT NULL CONSTRAINT article_sweeps_checked_nonnegative CHECK (stories_checked >= 0),
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, article_id, shard)
);

CREATE INDEX article_sweeps_article_idx ON article_sweeps (article_id);
