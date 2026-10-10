#!/usr/bin/env bash
# LITMUS daily funnel: pull real news -> score -> cluster -> story ledger ->
# snapshot -> build -> deploy. One command. Runs the same way locally and in
# CI (GitHub Actions).
#
# Required env:
#   DATABASE_URL       Postgres (Neon in prod, embedded/local in dev)
#   ANTHROPIC_API_KEY  scoring/clustering
# For deploy (skip with SKIP_DEPLOY=1):
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
# Optional:
#   PORT (default 8787), SCORE_LIMIT (cap articles scored per run)
#   RUN_STORY_LEDGER=1 to run the story ledger step (5/7), default off
#   RESCORE_HAIKU_JUDGED=1 to rescore, with Jev, the page's members still judged
#                      by Haiku (step 5b), default off; RESCORE_LIMIT caps it
#   STORY_LOOKBACK_DAYS (cap the ledger's unassigned-article window, default
#                        2, hard ceiling 14 - see stories/lookbackLimit.ts)
#   ALLOW_SMALLER_EDITION=1 publish even though this run has no ledger and the
#                      front page would shrink (scripts/check-edition-size.mjs)
#   SNAPSHOT_OUT (write the snapshot somewhere other than the client bundle)
#   SKIP_MIGRATE=1     the caller already applied pending migrations (the daily
#                      workflow does, after taking a backup). Step 1 then runs
#                      the idempotent schema only.
# Isolation (see litmus-server/src/lib/isolation.ts, scripts/isolation-guard.mjs):
#   LITMUS_ISOLATED=1  scratch database only, no deploy credentials, forces
#                      SKIP_DEPLOY. Requires LITMUS_SCRATCH_ROOT and
#                      SNAPSHOT_OUT (must resolve inside the root). Pair with
#                      ANTHROPIC_FAKE=1 for a $0 run.
#   LITMUS_SCRATCH_ROOT  a directory that SNAPSHOT_OUT must resolve inside.
#                        Required when LITMUS_ISOLATED=1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PORT="${PORT:-8787}"
# build-snapshot.mjs defaults to localhost:8787, so a run with a custom PORT
# started the API on one port and then read the snapshot from another: every
# endpoint came back ECONNREFUSED and the publish gate correctly refused to
# write an empty edition. Derive the URL from PORT so the two cannot disagree.
export API_URL="${API_URL:-http://localhost:$PORT/api}"

log() { printf '\n\033[1m[refresh] %s\033[0m\n' "$1"; }
die() { printf '\n\033[1m[refresh] REFUSING: %s\033[0m\n' "$1" >&2; exit 1; }

# An isolated run can never reach the deploy step, whatever the caller passed.
# The database and model guards live in the server (they have to hold for a
# worker invoked directly, not just through this script); these are the guards
# that only this script can enforce, and every one of them fails closed.
if [ "${LITMUS_ISOLATED:-}" = "1" ]; then
  export SKIP_DEPLOY=1

  # OVERRIDE, not default. The line above honours an inherited API_URL, which in
  # an isolated run would let the snapshot be assembled from a remote
  # deployment's data and reported as a local experiment.
  if [ -n "${API_URL:-}" ] && [ "$API_URL" != "http://localhost:$PORT/api" ]; then
    log "ISOLATED RUN: ignoring inherited API_URL=$API_URL"
  fi
  export API_URL="http://localhost:$PORT/api"

  # SNAPSHOT_OUT unset means "write the published snapshot", so a forgotten
  # variable turns a fixture run into a publication. Require it.
  #
  # This shell block does presence checks only — non-empty, nothing more. The
  # authoritative check is scripts/isolation-guard.mjs's canonical-path
  # containment inside LITMUS_SCRATCH_ROOT, which build-snapshot.mjs runs
  # before its first fetch. A second, WEAKER ruleset here (the previous version
  # matched one literal path suffix, which a symlink, a `../` alias, or another
  # worktree's snapshot would all have slipped past) is exactly the drifting-
  # duplicate-implementation trap: two guards that can disagree are worse than
  # one that is actually enforced where the write happens. Bash cannot resolve
  # symlinks, hard links, or case-insensitive aliases correctly enough to be
  # that authority, so it does not try.
  [ -n "${LITMUS_SCRATCH_ROOT:-}" ] || die \
    "LITMUS_ISOLATED=1 requires LITMUS_SCRATCH_ROOT: a directory SNAPSHOT_OUT must resolve inside."
  [ -n "${SNAPSHOT_OUT:-}" ] || die \
    "LITMUS_ISOLATED=1 requires SNAPSHOT_OUT. Unset, the snapshot would overwrite the published edition."

  log "ISOLATED RUN: scratch database, deploy disabled, snapshot -> $SNAPSHOT_OUT (root: $LITMUS_SCRATCH_ROOT)"
  if [ "${ANTHROPIC_FAKE:-}" = "1" ]; then
    log "ISOLATED RUN: fixture model responses, no paid calls, results are NOT measurable"
  fi
elif [ "${ANTHROPIC_FAKE:-}" = "1" ]; then
  # The server refuses this too; catching it here means the run stops before it
  # has ingested anything, rather than partway through.
  die "ANTHROPIC_FAKE=1 without LITMUS_ISOLATED=1 would persist fabricated scores to a real database."
fi

# The deploy tool is the version pinned in litmus-client's lockfile (security
# baseline, 2026-10-07). `npx wrangler` fetched whatever the registry served that
# morning and ran it holding the Pages token. Checked before anything is
# ingested, so a missing install costs nothing.
WRANGLER="$ROOT/litmus-client/node_modules/.bin/wrangler"
if [ "${SKIP_DEPLOY:-0}" != "1" ] && [ ! -x "$WRANGLER" ]; then
  die "the pinned wrangler is not installed ($WRANGLER). Run npm ci in litmus-client."
fi

# The Pages token reaches the deploy command and nothing else, when that is
# possible. Ingest fetches pages from the open internet and every worker parses
# them; none of them needs to publish. Jev, though, falls back to this token for
# Workers AI when JEV_API_TOKEN is unset (lib/env.ts), so the token is withheld
# only when Jev has its own; otherwise scoring would quietly leave Jev. Isolated
# runs keep it in the environment so the server's guard can see it and refuse.
DEPLOY_TOKEN=""
if [ "${LITMUS_ISOLATED:-}" != "1" ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if [ -n "${JEV_API_TOKEN:-}" ]; then
    DEPLOY_TOKEN="$CLOUDFLARE_API_TOKEN"
    unset CLOUDFLARE_API_TOKEN
  else
    log "NOTE: JEV_API_TOKEN is unset, so Jev uses the Pages token and the workers keep it"
  fi
fi

log "1/7 schema (idempotent) + migrations"
( cd "$ROOT/litmus-server" && npm run db:init:node )
# db:init:node builds a database from nothing and cannot alter one that exists,
# so everything added since (the story ledger, sources.outlet_key) only arrives
# through the migration runner. The seeder in the next step writes outlet_key,
# which is why this cannot wait: against a database without the migration the
# ingest fails on the first source.
#
# SKIP_MIGRATE=1 means the caller already applied them. That is how the daily
# workflow runs against Neon: migrate:up refuses a non-local database without
# ALLOW_PROD_MIGRATE=1, and a production migration has to be preceded by a
# backup (litmus-server/migrations/README.md rule 6), neither of which belongs
# inside an unattended funnel step. So daily.yml owns the backup and the
# migration as their own steps, and this script keeps migrate:up for the local
# and isolated runs where the database is disposable.
if [ "${SKIP_MIGRATE:-}" = "1" ]; then
  log "migrations: skipped, the caller applied them (SKIP_MIGRATE=1)"
else
  ( cd "$ROOT/litmus-server" && npm run migrate:up )
fi

log "2/7 ingest real news"
( cd "$ROOT/litmus-server" && npm run ingest )

log "3/7 score (recalibrated model)"
# scoreCron caps ONE cycle at MAX_PER_CYCLE articles so a backlog cannot run away
# with the API budget. A single cycle therefore scores only a fraction of a fresh
# ingest, and the edition would be built from that fraction while the rest of the
# day's news sat unscored. Drain the queue with bounded repeats rather than
# raising the per-cycle ceiling, so the budget guard stays intact. Each cycle is
# idempotent and resumable (unscored queue + primary key), so repeating is safe.
# Sized to what the paper RENDERS, not to the backlog and not to the cap.
#
# This ran 3 cycles of 50, so a run paid to score 150 articles. The edition that
# produced was measured end to end: clustering kept 30 of them, the section pages
# surfaced 15, and the remaining 135 were displayed nowhere at all, because the
# only page showing the flat feed had no route. One cycle of MAX_PER_CYCLE (40)
# now covers everything the paper can show, with margin.
#
# The loop still stops early when the queue drains, and still warns if it hits
# the cap with articles unscored. Before raising this, check that a surface
# actually displays the extra articles; scoring is the expensive step and an
# article nobody can reach is pure cost.
SCORE_CYCLES="${SCORE_CYCLES:-1}"
for cycle in $(seq 1 "$SCORE_CYCLES"); do
  score_out="$( cd "$ROOT/litmus-server" && npm run score 2>&1 )"
  printf '%s\n' "$score_out"
  if printf '%s' "$score_out" | grep -q '"msg":"no unscored articles"'; then
    log "score queue drained after $cycle cycle(s)"
    break
  fi
  if [ "$cycle" -eq "$SCORE_CYCLES" ]; then
    log "WARNING: hit the $SCORE_CYCLES-cycle cap with articles still unscored; this edition is incomplete"
  fi
done

# Non-fatal (2026-09-21): a clusterer crash - e.g. the known max_tokens=32000
# ceiling truncating a large cluster response ("submit_clusters returned
# malformed input", topicClusterer.ts) - used to take the whole funnel down
# with it under `set -euo pipefail`, including the story ledger step that
# runs after it, even though the two are supposed to be independent groupings
# over the same articles. Same principle already applied to the ledger step
# below: a failed step must not take the rest of the edition down with it.
log "4/7 cluster into stories + sections"
if ! ( cd "$ROOT/litmus-server" && npm run cluster ); then
  log "WARNING: cluster run failed; continuing without new clusters/sections this edition"
fi

# Story Ledger (2026-09-19): the story-first front end's real data source,
# separate from and alongside the clusterer above — same database, two
# independent groupings, until the client fully switches over. Real Sonnet 5
# spend every run (measured ~$24 for a 200-article day, 2026-09-17). A failed
# or partial run must not take the whole edition down with it: the clusterer-
# based paper is still real and publishable even when this finds nothing, the
# same way an empty cluster list does not block publish.
#
# RUN_STORY_LEDGER opt-in, default off (Max, 2026-09-19): the caller decides
# per-invocation which runs pay for it. daily.yml's single scheduled edition
# sets it; a manual dispatch or an ad-hoc local `bash scripts/refresh.sh`
# skips it unless asked.
# LEDGER_RAN tells the edition-size gate (step 6b) whether this edition has
# the day's stories in it.
LEDGER_RAN=0
if [ "${RUN_STORY_LEDGER:-0}" = "1" ]; then
  log "5/7 story ledger"
  if ( cd "$ROOT/litmus-server" && npm run stories ); then
    LEDGER_RAN=1
  else
    log "WARNING: story ledger run failed; continuing without new/updated stories this edition"
  fi
else
  log "5/7 story ledger — skipped (RUN_STORY_LEDGER not set)"
fi

# One edition, one judge (audit 2026-10-02, 3.4). Off unless Max turns it on.
if [ "${RESCORE_HAIKU_JUDGED:-0}" = "1" ]; then
  log "5b/7 rescore Haiku-judged members with Jev"
  if ! ( cd "$ROOT/litmus-server" && RESCORE_HAIKU_JUDGED=1 npm run rescore:haiku-judged ); then
    log "WARNING: rescore failed; the edition keeps its mixed judges"
  fi
else
  log "5b/7 rescore Haiku-judged members — skipped (RESCORE_HAIKU_JUDGED not set)"
fi

log "6/7 snapshot the API into the static bundle"
( cd "$ROOT/litmus-server" && npm run start ) &
API_PID=$!

# Killing $API_PID alone kills the `npm run start` wrapper and leaves the node
# server it spawned running: it keeps the port and holds the inherited stdout
# open, so the next local run dies on EADDRINUSE and anything reading this
# script's output waits forever for a stream that never closes. CI never saw it
# because the job ends and takes the orphan with it.
stop_api() {
  pkill -P "$API_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
}
trap stop_api EXIT

until curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; do sleep 1; done
FROZEN_AT="$(date -u +%FT%TZ)" node "$ROOT/scripts/build-snapshot.mjs"
stop_api
trap - EXIT

# Every matrix dot labelled in its chart (Max, 2026-10-09). Warns on the run,
# never blocks the paper: an unplaced dot is still named under its chart.
"$ROOT/litmus-server/node_modules/.bin/tsx" "$ROOT/scripts/check-matrix-labels.ts" \
  || log "WARNING: the matrix label check could not run"

# A run that did not run the ledger must not shrink the front page (2026-10-09:
# a code deploy replaced a 50-story edition with 8). Only when publishing; the
# gate also writes edition-size.json into the bundle for the next run to read.
if [ "${SKIP_DEPLOY:-0}" != "1" ]; then
  log "6b/7 edition-size gate"
  LEDGER_RAN="$LEDGER_RAN" node "$ROOT/scripts/check-edition-size.mjs" \
    || die "edition-size gate refused to publish (see above). Nothing was deployed."
fi

log "7/7 build + deploy the static paper"
( cd "$ROOT/litmus-client" && VITE_DEMO=true npm run build )
if [ "${SKIP_DEPLOY:-0}" != "1" ]; then
  ( cd "$ROOT/litmus-client" && CLOUDFLARE_API_TOKEN="${DEPLOY_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}" \
      "$WRANGLER" pages deploy dist --project-name=litmus --branch=main --commit-dirty=true )
fi

log "done — the paper is refreshed."
