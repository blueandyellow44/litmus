# Litmus / LITMUS2

A web app that ingests political news from across the spectrum and gives readers two things for every story: the original article and a bias-stripped "translated" version. Every article is scored on the **P/H (Practical-to-Hysterical) Balance** scale (1–5) — a measure of how the story is *told*, not the political position it takes.

## Layout

Side-by-side, two independent packages under this root:

- `litmus-server/` — Node/Express/Hono API, RSS ingestion, Claude-powered scoring + translation, Postgres storage
- `litmus-client/` — React + Vite + Tailwind frontend

## Start here

1. Read `docs/architecture.md` — the full architecture blueprint
2. Read `tasks/todo.md` — current work queue
3. Read `tasks/lessons.md` — learned mistakes to not repeat

Phase 0 (this scaffold) is folders only. No package.json, no code. Next phase: database schema + RSS ingestion pipeline.
