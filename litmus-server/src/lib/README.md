# src/lib

Cross-cutting utilities shared by all other modules.

- `anthropic.ts` — single `@anthropic-ai/sdk` client instance. Exposes `scoreBatch()` (Haiku) and `translate()` / `cluster()` (Sonnet). Model routing lives here, not in individual pipelines.
- `env.ts` — validated env loader (`ANTHROPIC_API_KEY`, `DATABASE_URL`, `PORT`, etc.)
- `logger.ts` — structured logging

Keep this thin. If a util is used in exactly one place, it belongs in that place.
