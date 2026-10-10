# src/pages

Top-level route components. Each one is a full screen.

- `ClusterList.tsx` — today's story clusters. Primary landing page. Each cluster shows topic, source count, lean distribution bar, P/H range, and the cluster's member articles on expand.
- `ClusterDetail.tsx` — full view of one cluster. Lists all member articles side by side so the user can compare how different sources told the same story.
- `ArticleDetail.tsx` — one article. Side-by-side original vs. translated view with diff highlight. Toggleable. Shows the full P/H breakdown (five dimensions + rationale).
- `SourceConfig.tsx` — enable/disable sources, filter by lean, add custom RSS feed, toggle "balance mode".
