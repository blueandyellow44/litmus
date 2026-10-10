-- Reverse of 0002_article_syndication.up.sql.
--
-- Dropping the column loses which rows were copies of which; the copies
-- themselves stay as ordinary articles. Headline-only rows (extraction_status
-- 'failed', no body) also stay: the pre-0002 code never read such rows because
-- every query it runs has a word floor, so they are inert there. Take a backup
-- first if the syndication pointers matter (README rule 6).

ALTER TABLE articles DROP CONSTRAINT articles_headline_only_has_no_body;
DROP INDEX articles_syndicated_of_idx;
ALTER TABLE articles DROP CONSTRAINT articles_not_syndicated_of_self;
ALTER TABLE articles DROP COLUMN syndicated_of_article_id;
