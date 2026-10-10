-- Litmus schema. Run with: psql $DATABASE_URL -f src/db/schema.sql
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS sources (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  rss_url         TEXT NOT NULL UNIQUE,
  lean            TEXT NOT NULL CHECK (lean IN ('left','center-left','center','center-right','right')),
  type            TEXT NOT NULL CHECK (type IN ('wire','newspaper','magazine','broadcast','digital-native')),
  paywall_status  TEXT NOT NULL CHECK (paywall_status IN ('free','metered','hard')),
  reliability     SMALLINT NOT NULL CHECK (reliability BETWEEN 1 AND 5),
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  -- Authoritative register for every article from this source, when the source
  -- only ever files one kind. NULL means the scorer decides per article, which
  -- is correct for a mixed outlet like NPR. See sourcesRepo and phScorer.
  register        TEXT CHECK (register IN ('news','sports','culture','feature'))
);

CREATE TABLE IF NOT EXISTS articles (
  id                SERIAL PRIMARY KEY,
  source_id         INT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  title             TEXT NOT NULL,
  author            TEXT,
  published_at      TIMESTAMPTZ,
  raw_text          TEXT NOT NULL DEFAULT '',
  word_count        INT NOT NULL DEFAULT 0,
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('full','partial','failed')),
  paywall_flag      BOOLEAN NOT NULL DEFAULT FALSE,
  content_hash      TEXT NOT NULL,
  extracted_via     TEXT,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, url)
);

CREATE INDEX IF NOT EXISTS articles_content_hash_idx ON articles (content_hash);
CREATE INDEX IF NOT EXISTS articles_published_at_idx ON articles (published_at DESC);

CREATE TABLE IF NOT EXISTS scores (
  article_id      INT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  headline        REAL NOT NULL,
  language        REAL NOT NULL,
  sourcing        REAL NOT NULL,
  fallacies       REAL NOT NULL,
  structure       REAL NOT NULL,
  composite       REAL NOT NULL,
  label           TEXT NOT NULL,
  rationale_json  JSONB NOT NULL,
  markers         JSONB NOT NULL DEFAULT '[]'::jsonb,
  excerpt_indices JSONB NOT NULL DEFAULT '[]'::jsonb,
  political_lean  REAL,
  article_summary TEXT NOT NULL DEFAULT '',
  section         TEXT,
  scored_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model_used      TEXT NOT NULL,
  -- Inputs to the code-computed composite, so a stored score can be replayed
  -- and explained rather than merely displayed. See scoring/composite.ts.
  flags           JSONB,
  breakdown       JSONB,
  declared_band   TEXT
);

CREATE INDEX IF NOT EXISTS scores_composite_idx ON scores (composite);

CREATE TABLE IF NOT EXISTS translations (
  article_id              INT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  translated_text         TEXT NOT NULL,
  diff_json               JSONB NOT NULL,
  removed_fallacies_json  JSONB NOT NULL,
  generated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model_used              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clusters (
  id          SERIAL PRIMARY KEY,
  topic       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  section     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cluster_articles (
  cluster_id  INT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  article_id  INT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, article_id)
);

CREATE INDEX IF NOT EXISTS cluster_articles_article_idx ON cluster_articles (article_id);

-- ── Additive migrations (idempotent) for databases created before these columns.
-- Safe to run on every db:init; no-ops once the columns exist.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS extracted_via   TEXT;
ALTER TABLE scores   ADD COLUMN IF NOT EXISTS markers         JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE scores   ADD COLUMN IF NOT EXISTS excerpt_indices JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE scores   ADD COLUMN IF NOT EXISTS political_lean  REAL;
ALTER TABLE scores   ADD COLUMN IF NOT EXISTS article_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE scores   ADD COLUMN IF NOT EXISTS section         TEXT;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS section         TEXT;
-- Editorial prominence: who can carry a front page. Deliberately separate from
-- `reliability` (trustworthiness) and from `lean` (politics) — a small outlet
-- can be perfectly reliable and still not be cover material. 3 = wire service
-- or major national desk, 2 = significant national, 1 = everything else.
ALTER TABLE sources  ADD COLUMN IF NOT EXISTS prominence      REAL NOT NULL DEFAULT 1.0;
-- The composite is computed in code from the dimensions plus the model's flags
-- (see scoring/composite.ts). Storing only the result made a production row
-- impossible to replay or explain: you could see the number but not the terms
-- that produced it. These three carry the inputs alongside it. Nullable, since
-- every row written before this has no record of them.
-- Register pinned per source. Register drives BOTH the marker exemption and the
-- composite (a non-news register halves the language weight and switches off the
-- loaded-headline and emotional-lede floors), and it was observed flipping
-- between 'news' and 'feature' for the same outlet across runs, which moves the
-- score on a coin flip. Pinning it where the answer is never in doubt removes
-- that variance.
ALTER TABLE sources  ADD COLUMN IF NOT EXISTS register        TEXT;
ALTER TABLE scores   ADD COLUMN IF NOT EXISTS flags           JSONB;
ALTER TABLE scores   ADD COLUMN IF NOT EXISTS breakdown       JSONB;
ALTER TABLE scores   ADD COLUMN IF NOT EXISTS declared_band   TEXT;
