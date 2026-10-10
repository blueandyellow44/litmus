# src/scoring

Produces a P/H score (1.0–5.0) for each article using Claude Haiku in batches.

- `calibration.ts` — the P/H rules inlined from the build prompt: five dimensions (headline, language, sourcing, fallacies, structure), weights, cumulative fallacy penalty, sensationalism tax, opinion-column minimum, etc. This is the authoritative spec.
- `phScorer.ts` — builds the Claude prompt, sends it, parses the JSON response, validates it, returns a structured score + rationale
- `batchRunner.ts` — groups 10 articles per Claude call to amortize overhead

Partial articles (< 300 words) get headline + available-text scoring only, no translation downstream. Full articles get the full pipeline.
