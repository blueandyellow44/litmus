-- Reverse of 0006_article_clean_text.up.sql. raw_text was never modified, so
-- dropping these loses only the filter's output, which can be recomputed.

ALTER TABLE articles DROP COLUMN furniture;
ALTER TABLE articles DROP COLUMN clean_text;
