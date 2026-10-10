# src/translation

On-demand bias-stripped translation of full articles. Only runs for articles with 300+ words of extracted text.

- `translator.ts` — sends the article to Claude Sonnet with the translation spec (replace loaded verbs with neutral ones, strip adverb stacking, restructure emotional ledes to inverted pyramid, surface buried counterpoints, preserve all facts/quotes/data, annotate removed fallacies inline), parses the response, writes to `translations` table keyed by `article_id`

This is the most expensive operation in the system. Caching is aggressive — a translation row is written once and never regenerated. If the scoring model is upgraded and we want to rescore with the new model, a new row is inserted with a new `model_used` value.
