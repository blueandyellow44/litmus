# src/lib

Client-side utilities.

- `api.ts` — typed fetch wrapper for the server endpoints. One function per endpoint. Handles loading + error states uniformly.
- `prefs.ts` — localStorage-backed user preferences (enabled sources, lean filter, balance mode). No user accounts in v1.

If an API response shape needs to be shared between client and server, copy the type into here and keep it manually in sync with the server. No workspaces monorepo in v1 (see `docs/architecture.md` decision #1).
