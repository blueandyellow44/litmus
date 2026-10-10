# src/api

HTTP route handlers. One file per resource.

- `clusters.ts` — `GET /api/clusters` (list today's clusters with lean distribution + P/H range)
- `articles.ts` — `GET /api/articles/:id` (article + score + cached translation if present)
- `sources.ts` — `GET/POST/PATCH/DELETE /api/sources` (user source management, custom RSS add)
- `translations.ts` — `POST /api/translations/:articleId` (trigger on-demand generation, returns cached result)

Handlers are thin. They call into repos and pipelines; they don't contain business logic.
