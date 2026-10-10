-- Reverse of 0003_story_run_evidence.up.sql.

DROP TABLE story_run_usage;
DROP TABLE story_sweep_checks;
DROP TABLE story_events_log;
DROP TABLE story_article_states;

ALTER TABLE stories DROP COLUMN anchor_article_id;
