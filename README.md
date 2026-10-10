# LITMUS

A daily paper that groups the news into stories and shows how each outlet told the same one. Live at [litmustimes.com](https://litmustimes.com).

## What it does

Most media-bias tools sort outlets left and right. LITMUS asks a different question. It reads how a report is told and scores the temperature of the telling on a 1 to 5 scale, from Proportionate to Hyperbolic. A calm report from either side scores the same.

The distinction that makes it work is narrow and deliberate. The scorer rates only what the writer controls, the headline, the reporter's own words, the structure, the sourcing. A restrained, accurately sourced report that quotes an inflammatory speaker is grounded writing, and it scores that way. The quoted subject's words never count against the piece.

Reports are grouped into stories, so a reader sees one event and every outlet that covered it. Each story carries a short summary, a chart of where the outlets landed, and the calmest and hottest telling side by side, with the words that earned each score marked in the text.

The paper is a finite edition, not an infinite feed. It builds once each morning and then it is done.

## How it works

One command, no always-on server.

```
ingest (real RSS) -> score -> group into stories -> assess -> bake snapshot -> build -> deploy
```

- **Ingest.** RSS feeds are polled and each article is fetched through one bounded, public-only fetcher.
- **Score.** Each report is judged on five dimensions. The model sets the dimensions and flags, and the final number is computed in code with floors the model cannot argue around.
- **Group.** A story ledger decides whether a new report belongs to an existing story, starts a new one, or should merge two. Stories persist across days.
- **Publish.** The edition is baked into the client at build time, so the deployed site is fully static. There is no per-request database bill and no server to keep awake.

Claude Haiku 4.5 writes every text field. Jev, a small model on Cloudflare Workers AI, judges the scores and the same-event calls. Storage is Postgres. Hosting is Cloudflare Pages.

- `litmus-server/` is the pipeline. Ingestion, scoring, the story ledger, and the API the build reads from.
- `litmus-client/` is the reader. React, Vite, and Tailwind, with separate desktop and mobile layouts.
- `ops/edition-clock/` is a Cloudflare Worker that starts the morning edition on time.
- `scripts/` holds the build and the checks that gate a publish.

## Engineering notes

**The edition starts on time because a clock starts it.** GitHub's scheduled runners began the job between four and nine hours late, measured over a week. A Cloudflare cron now dispatches the workflow at 3:45 AM Pacific, and the GitHub schedule stays only as a fallback that skips itself when the edition already ran.

**Publishing is gated by checks, not by hope.** A run refuses to publish an edition that would shrink the front page or that carries full article text. Each gate is a script in `scripts/`.

**Only a short excerpt is ever published.** Full text is stored privately for scoring. The paper shows at most 200 words and never more than a quarter of an article, with a link to the original.

**Paid calls are bounded.** Scoring, grouping, and assessment each have a per-run limit, and on-demand translation is off unless switched on and capped per day.

**Tests.** 732 unit tests on the server and 449 on the client, plus integration tests that run against a real Postgres.

## Running it

```bash
# one-time: set DATABASE_URL and ANTHROPIC_API_KEY (see litmus-server/.env.example)
bash scripts/refresh.sh                  # ingest, score, group, build, deploy
SKIP_DEPLOY=1 bash scripts/refresh.sh    # build only
```

The client imports the baked edition, `litmus-client/src/demo/snapshot.json`, which the build writes and git ignores. A fresh clone type-checks once that file exists.

## Status

Live, with a new edition every morning. The scoring is imperfect and still being tuned, and `litmus-server` ships a harness for that work (`npm run calibrate`). Its output stays local, because it embeds full article text.

The same rubric drives [LITMUS Live](https://github.com/blueandyellow44/litmus-meter), a meter that scores broadcast speech one sentence at a time.

## License

MIT
