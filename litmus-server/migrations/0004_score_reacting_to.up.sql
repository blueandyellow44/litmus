-- 0004_score_reacting_to: the P/H scorer's relational-context field.
--
-- article_summary is deliberately neutral "just the facts" text (reader-
-- facing), which strips exactly the context the Story Ledger's SAME_EVENT_RULE
-- grouping needs: whether this article explicitly reports itself as reacting
-- to another specific event or statement. reacting_to is a separate field for
-- that purpose - internal to the ledger, never shown to readers. NULL means
-- either "not yet scored under this field" (existing rows) or "the article
-- does not report itself as a reaction" - both read the same to a grouping
-- decision, so one NULL state is enough; nothing downstream needs to tell
-- them apart.

ALTER TABLE scores ADD COLUMN reacting_to TEXT;
