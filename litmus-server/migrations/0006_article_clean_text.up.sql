-- 0006_article_clean_text: page furniture kept aside, never deleted.
--
-- Max, 2026-09-27: captions, subscription pitches, bylines and links to other
-- stories were stored as article text, reached the scorer and showed in 15 of
-- 53 sampled published excerpts. Jev classifies each paragraph before scoring.
-- raw_text is NEVER modified: clean_text is the story text the scorer and the
-- excerpt builder read when it exists, and furniture holds every paragraph
-- that was set aside, with its index and class, so nothing is lost.
-- NULL clean_text means the article was not filtered; readers fall back to raw_text.

ALTER TABLE articles ADD COLUMN clean_text TEXT;
ALTER TABLE articles ADD COLUMN furniture JSONB;
