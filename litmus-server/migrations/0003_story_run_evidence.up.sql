-- 0003_story_run_evidence: durable outcomes and evidence for the Story Ledger.
--
-- The base ledger stores memberships and aggregate sweep counts. This additive
-- migration stores the terminal state of articles that did not become members,
-- every auditable decision, each story/article sweep verdict, and per-call
-- usage. Without these rows the offered equation and coverage report would be
-- reconstructable only while the worker process was still alive.

-- The anchor is the first primary member that seeded the stable story id. It
-- never changes merely because an older article is discovered later.
ALTER TABLE stories ADD COLUMN anchor_article_id INT REFERENCES articles (id) ON DELETE SET NULL;

UPDATE stories st
SET anchor_article_id = (
  SELECT sm.article_id
  FROM story_members sm
  WHERE sm.story_id = st.id AND sm.role = 'primary'
  ORDER BY sm.added_at, sm.article_id
  LIMIT 1
)
WHERE st.anchor_article_id IS NULL;

CREATE TABLE story_article_states (
  article_id  INT PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  state       TEXT NOT NULL CHECK (state IN ('flag', 'not_news')),
  reason      TEXT NOT NULL CHECK (btrim(reason) <> ''),
  run_id      BIGINT REFERENCES story_runs (id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX story_article_states_state_idx ON story_article_states (state, updated_at DESC);

CREATE TABLE story_events_log (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT REFERENCES story_runs (id) ON DELETE SET NULL,
  article_id  INT REFERENCES articles (id) ON DELETE SET NULL,
  story_id    TEXT REFERENCES stories (id) ON DELETE SET NULL,
  action      TEXT NOT NULL CHECK (btrim(action) <> ''),
  reason      TEXT NOT NULL CHECK (btrim(reason) <> ''),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX story_events_run_idx ON story_events_log (run_id, id);
CREATE INDEX story_events_story_idx ON story_events_log (story_id, id);

CREATE TABLE story_sweep_checks (
  run_id      BIGINT NOT NULL REFERENCES story_runs (id) ON DELETE CASCADE,
  article_id  INT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  story_id    TEXT NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  outcome     TEXT NOT NULL CHECK (outcome IN ('excluded', 'match', 'uncertain')),
  reason      TEXT NOT NULL CHECK (btrim(reason) <> ''),
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, article_id, story_id)
);

CREATE INDEX story_sweep_checks_story_idx ON story_sweep_checks (story_id, run_id);

CREATE TABLE story_run_usage (
  run_id                       BIGINT NOT NULL REFERENCES story_runs (id) ON DELETE CASCADE,
  stage                        TEXT NOT NULL CHECK (btrim(stage) <> ''),
  call_index                   INT NOT NULL CHECK (call_index > 0),
  model                        TEXT NOT NULL CHECK (btrim(model) <> ''),
  status                       TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error                        TEXT,
  input_tokens                 INT NOT NULL CHECK (input_tokens >= 0),
  output_tokens                INT NOT NULL CHECK (output_tokens >= 0),
  cache_creation_input_tokens  INT NOT NULL CHECK (cache_creation_input_tokens >= 0),
  cache_read_input_tokens      INT NOT NULL CHECK (cache_read_input_tokens >= 0),
  wall_ms                      INT NOT NULL CHECK (wall_ms >= 0),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, stage, call_index)
  ,CONSTRAINT story_run_usage_error_shape CHECK (
    (status = 'succeeded' AND error IS NULL) OR (status = 'failed' AND btrim(error) <> '')
  )
);
