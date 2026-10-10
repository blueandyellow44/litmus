# src/clustering

Groups articles covering the same event into story clusters. Runs on a slower cadence (~30m) because clustering is expensive and doesn't need to be real-time.

- `topicClusterer.ts` — sends recent headlines + summaries to Claude, asks for cluster groupings + a topic label + a one-sentence neutral summary, upserts `clusters` and `cluster_articles` rows

Clusters are the PRIMARY navigation unit in the UI. A cluster's "lean distribution bar" and "P/H range" come from aggregating the member articles.
