-- 0005_story_touches_politics: the front page's scope, judged per story.
--
-- Max, 2026-09-26: LITMUS covers what Political Wire covers, politics plus
-- economy, national and world stories that touch politics, not sports,
-- entertainment, lifestyle or product news. No desk label carries that, so the
-- assessment call judges it for each story it writes up. NULL means not yet
-- judged; the front page shows only TRUE.

ALTER TABLE stories ADD COLUMN touches_politics BOOLEAN;
