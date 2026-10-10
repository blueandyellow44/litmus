# sources

`seed.json` is the out-of-the-box source roster. The ingest seeder upserts it by
`rss_url` on every run, so editing this file and re-running ingest is safe.
Custom user-added sources go to the `sources` DB table at runtime, not here.

## Fields

```json
{
  "name": "Associated Press — Politics",
  "rssUrl": "https://...",
  "lean": "center",
  "type": "wire",
  "paywallStatus": "free",
  "reliability": 5,
  "prominence": 3,
  "enabled": true,
  "register": "sports"
}
```

- `lean` — `left`, `center-left`, `center`, `center-right`, `right`
- `type` — `wire`, `newspaper`, `magazine`, `broadcast`, `digital-native`
- `paywallStatus` — `free`, `metered`, `hard`
- `reliability` — 1-5, see the boundary below
- `prominence` — 1-3, see the boundary below
- `enabled` — omit for true; `false` keeps the row without polling it
- `register` — optional pin: `news`, `sports`, `culture`, `feature`. Only for a
  source that files exactly one kind of piece. Overrides the scorer's
  per-article judgement (see `applyRegisterPin`). Leave it off for a mixed
  outlet.

## The methodology boundary on `lean`, `reliability` and `prominence`

**These three fields are LITMUS's own editorial judgements. They have no
published rubric, no external source, and no named authority. Nothing may be
changed about them, in either direction, without one.**

That is the standing rule, and it is written here because the fields look like
measurements and are not. A number in a JSON file reads as evidence; a number
assigned by hand while building a roster is an opinion with a decimal point.

What follows from it:

- **Do not edit a value to move an aggregate.** If a representation figure looks
  wrong, the honest fix is coverage, never a re-rating that produces a nicer
  chart. `scripts/representation-audit.mjs` reports these numbers and
  deliberately has no pass threshold, for exactly this reason.
- **Do not cite them to a reader.** No surface publishes `reliability`.
  `lean` IS published, as "Outlet baseline", and the app labels it as LITMUS's
  standing classification of the publication rather than a fact about it — and
  always beside the article's own measured framing, which is a separate reading
  and often disagrees.
- **`prominence` is a layout input, not a quality claim.** It answers "would a
  reader expect to see this desk leading a paper", and it gates the front-page
  cover. It is not trust, and the tier-3 list spans left, centre and right.
- **The article-weighted reliability spread is not a finding about the wings.**
  On the 2026-08-03 edition it read left 4.25, center-left 4.00, center 4.40,
  center-right 4.33, right 2.87. That gap is a property of who assigned the
  numbers, not of the outlets, until a rubric and an authority exist to defend
  it. Do not repeat it as though it were measured.

Before any of the three moves: write the rubric, name who owns it, and record
the change and its reason here. Until then the values stand as they are.

## Disabled sources

`enabled: false` keeps a row in the file without polling it. Five entries are
disabled, and all five are disabled for the same reason — **the feed URL no
longer serves RSS** — not for any editorial reason.

Verified by direct request, 2026-09-04:

| Source | URL result |
|---|---|
| Reuters — Top News | `feeds.reuters.com` does not resolve (DNS) |
| Associated Press — Politics | `feeds.apnews.com` does not resolve (DNS) |
| C-SPAN | `HTTP 410 Gone` |
| USA Today — News | `HTTP 200`, but serves an HTML page, not a feed |
| Forbes | `HTTP 404` |

**The two wire services are the ones that matter.** LITMUS's scale is anchored
at the Practical end by wire-register reporting, and losing the direct wire
baseline means the calmest end of the scale is represented only by syndicated
wire copy arriving through other publishers. Both were re-checked on 2026-09-04
and neither has a public replacement:

- `reutersagency.com/feed/...` → `HTTP 404`
- `apnews.com/hub/politics.rss` → `HTTP 404`
- `apnews.com/index.rss` → `HTTP 401 Invalid client credentials`

AP's feed now sits behind licensed credentials. Reuters has retired its public
RSS. Restoring either is a licensing decision, not a configuration fix, and it
is Max's call — so the rows stay disabled and honest rather than being replaced
with a lookalike feed from an aggregator.
