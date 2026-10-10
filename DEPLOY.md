# LITMUS — the ongoing daily funnel

The site is a **static paper** on Cloudflare Pages, rebuilt from real news every
day. No always-on server, no per-request database bill. The daily job pulls
fresh RSS, scores it, clusters it into stories, bakes a snapshot into the
client, and deploys.

```
ingest (real RSS) -> score (Claude Haiku) -> cluster -> snapshot -> build -> deploy
```

Run the whole thing with one command:

```bash
bash scripts/refresh.sh          # deploys
SKIP_DEPLOY=1 bash scripts/refresh.sh   # build only, no deploy
```

## Make it run every day (free, laptop-independent)

The funnel runs itself via GitHub Actions (`.github/workflows/daily.yml`) on a
free scheduled runner. One-time setup:

1. **Postgres — Neon (free).** Create a project at neon.tech, copy the pooled
   connection string. This is `DATABASE_URL`.
2. **Push this repo to GitHub.** It is not a git repo yet:
   ```bash
   cd /path/to/litmus
   git init && git add -A && git commit -m "LITMUS"
   gh repo create litmus --private --source=. --push
   ```
   (Add a `.gitignore` first for `node_modules`, `.env`, `dist`, `litmus-client/src/demo/snapshot.json`.)
3. **Cloudflare API token.** Cloudflare dashboard -> My Profile -> API Tokens ->
   Create -> "Edit Cloudflare Pages" template. Note your Account ID too.
4. **Add the four repo secrets** (GitHub repo -> Settings -> Secrets -> Actions):
   `DATABASE_URL`, `ANTHROPIC_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

That is it. The paper refreshes daily at 11:15 UTC, and you can trigger a run
anytime from the Actions tab (`workflow_dispatch`).

## Cost

- Cloudflare Pages: free. Neon: free tier is plenty. GitHub Actions: free minutes.
- The only real cost is Claude Haiku scoring: the funnel scores the newest
  articles per source each day (a stratified sample), a few dollars a month at
  most. Cap it with `SCORE_LIMIT` if needed.

## Point litmustimes.com at it

Cloudflare dashboard -> Workers & Pages -> `litmus` -> Custom domains -> add
`litmustimes.com` (auto-creates the CNAME + cert). Then it serves the daily paper.

## Notes

- There is no archive fallback, in any environment. Ingest takes article text
  from the publisher's page or its own feed only, and `node scripts/check-no-archive.mjs`
  fails the scheduled build if that ever changes.
- `scripts/refresh.sh` starts the API briefly only to snapshot it, then stops it.
  Nothing stays running between daily jobs.
- Verify the seed feeds occasionally (`litmus-server/sources/seed.json`); RSS
  URLs rot. A dead feed just yields fewer articles, it does not break the run.
