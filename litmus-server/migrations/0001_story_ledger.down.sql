-- Reverse of 0001_story_ledger.up.sql.
--
-- This discards every story, membership, run and sweep row. That is the honest
-- reverse of a schema that did not exist before: the pre-ledger paper reads
-- only the clusters tables, which the up migration never touched. Take a backup
-- first if the ledger's history matters (README rule 6).
--
-- Order follows the foreign keys: sweeps and members reference runs, stories
-- and articles; stories reference themselves (merged_into).

DROP TABLE article_sweeps;
DROP TABLE story_members;
DROP TABLE stories;
DROP TABLE story_runs;

DROP INDEX sources_outlet_key_idx;
ALTER TABLE sources DROP CONSTRAINT sources_outlet_key_format;
ALTER TABLE sources DROP COLUMN outlet_key;
