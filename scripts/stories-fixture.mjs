// Build a `stories` array into the demo snapshot from what the snapshot already
// holds, so the story-first client (C2 components, C3 pages) can be built and
// checked before the Story Ledger lands on the server.
// See docs/plans/story-first-build-2026-09-13.md phase C4.
//
// This script INVENTS NOTHING. Every string it writes is already in the
// snapshot, written by the pipeline that produced it:
//   - a cluster's topic becomes the story headline,
//   - a cluster's summary becomes the assessment text and its first sentence
//     the event statement,
//   - an article's own title, url, score, lean and capped excerpt become its
//     member row.
// The one exception is deliberate and labelled: ONE fixture headline-only
// member, so the hollow-dot state renders somewhere. It is marked in three
// places (a negative article id, FIXTURE_MEMBER_MARK in the outlet name, and
// an example.com link) and the server never emits anything like it.
//
// Legal posture (the excerpt policy): member excerpts are copied BY REFERENCE
// from the snapshot's own `excerpt` objects, which buildExcerptWindow already
// capped and whose markers edition-manifest.mjs already trimmed to the shown
// window. Nothing here widens a window, lifts a paragraph, or adds a marker.
// `rawText` is asserted absent before the file is written.
//
//   node scripts/stories-fixture.mjs            # rewrite the demo snapshot
//   node scripts/stories-fixture.mjs --check    # build and report, write nothing
//   node scripts/stories-fixture.mjs --clean    # no fixture member (a clean edition)
//
// SNAPSHOT_PATH overrides the input and output path.

import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH ?? join(ROOT, "litmus-client", "src", "demo", "snapshot.json");
const CHECK_ONLY = process.argv.includes("--check");
const CLEAN = process.argv.includes("--clean");

// The mark that makes the one fabricated member impossible to mistake for data.
// Grep it before shipping: no published story may contain it. The title
// prefix and the outlet suffix are exported so the client's tests can check
// the member is marked where a reader would see it.
export const FIXTURE_MEMBER_MARK = "FIXTURE";
export const FIXTURE_HEADLINE_ONLY_TITLE_PREFIX = `${FIXTURE_MEMBER_MARK}: `;
export const FIXTURE_OUTLET_SUFFIX = ` (${FIXTURE_MEMBER_MARK}, headline-only member)`;
const FIXTURE_MEMBER_ARTICLE_ID = -1;
const FIXTURE_MEMBER_URL = "https://example.com/fixture-headline-only";
// A fixture member has no body, by construction: headline-only members carry a
// headline and a link and nothing else (storyTypes.ts).
const FIXTURE_MEMBER = {
  articleId: FIXTURE_MEMBER_ARTICLE_ID,
  outletKey: "fixture-headline-only",
  outletName: `Sample Outlet${FIXTURE_OUTLET_SUFFIX}`,
  sourceLean: "center",
  title: `${FIXTURE_HEADLINE_ONLY_TITLE_PREFIX}Paywalled report LITMUS could not read`,
  url: FIXTURE_MEMBER_URL,
  publishedAt: null,
  kind: "headline_only",
  syndicatedOfArticleId: null,
  role: "primary",
  composite: null,
  politicalLean: null,
  howItWasTold: null,
  heat: null,
  excerpt: null,
};

// ── Small pure helpers, exported so the client's unit tests can reuse them ───

// Sister feeds are one outlet: "Axios — Politics & Policy" and "Axios" share
// an identity. The client's outletShortName does the same split for display;
// this is the key the server will later carry as sources.outlet_key.
export function outletShortName(name) {
  const short = String(name).split(" — ")[0]?.trim();
  return short && short.length > 0 ? short : String(name);
}

export function slugify(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
}

export function outletKeyFor(sourceName) {
  return slugify(outletShortName(sourceName)) || "unknown-outlet";
}

// The first sentence of a summary, used as the event statement. Falls back to
// the whole string rather than an empty one: an event statement is required by
// the contract and a blank is worse than a long sentence.
export function firstSentence(text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const m = t.match(/^.*?[.!?](?=\s|$)/);
  const first = (m ? m[0] : t).trim();
  return first.length > 0 ? first : t;
}

// Ids must survive a rebuild: two runs over the same snapshot must produce the
// same id for the same story, or every reader's bookmark breaks each night.
// Derived from the slug, with a numeric suffix only where two slugs collide.
export function uniqueSlug(base, taken) {
  const root = base || "story";
  if (!taken.has(root)) {
    taken.add(root);
    return root;
  }
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

// ── Members ─────────────────────────────────────────────────────────────────

// The snapshot carries an article three times over (summary, detail, cluster
// row) and each copy holds a different subset. The detail is the richest, so it
// wins; the cluster row supplies lean and name when the detail is absent.
function memberFrom(article, detail) {
  const src = detail ?? article;
  const score = src.score ?? article.score ?? null;
  const composite = typeof score?.composite === "number" ? score.composite : null;
  const politicalLean = typeof score?.politicalLean === "number" ? score.politicalLean : null;
  // The scorer's own summary of how this piece told it. It is the sentence in
  // the snapshot that describes the TELLING rather than the facts, which is
  // what howItWasTold means in the contract. The server will replace it with
  // a purpose-written one in S4.
  const howItWasTold = typeof score?.rationale?.summary === "string" ? score.rationale.summary : null;
  return {
    articleId: src.id,
    outletKey: outletKeyFor(src.sourceName),
    // The short name ("Axios", not "Axios — Politics & Policy"): outletKey
    // carries the shared identity, and the short name is what the story pages
    // show, so two feeds of one outlet never label two dots differently. The
    // article page still shows the feed name from its own record.
    outletName: outletShortName(src.sourceName),
    sourceLean: src.sourceLean,
    title: src.title,
    url: src.url,
    publishedAt: src.publishedAt ?? null,
    // Every article in this snapshot was extracted and scored, so every member
    // is "full". The kinds that need a server (headline_only from a failed
    // extraction, syndicated from the copy detector) do not exist in the data
    // yet; the one fixture member below covers headline_only for the UI.
    kind: "full",
    syndicatedOfArticleId: null,
    role: "primary",
    composite,
    politicalLean,
    howItWasTold,
    // Copied by reference, exactly as the snapshot holds it: already capped by
    // buildExcerptWindow and already marker-trimmed to the shown window.
    excerpt: src.excerpt ?? null,
  };
}

function phRange(members) {
  const scored = members.map((m) => m.composite).filter((c) => typeof c === "number" && Number.isFinite(c));
  if (scored.length === 0) return { phMin: null, phMax: null };
  return { phMin: Math.min(...scored), phMax: Math.max(...scored) };
}

// Fixture ids carry their own prefix so a reader of the snapshot can never
// mistake one for a ledger id ("st_01J..."), and so the server's ids and the
// fixture's cannot collide if both ever sit in one file.
export const FIXTURE_ID_PREFIX = "st_fx_";

// What wrote the assessment text, named honestly: no model was called here.
// A cluster story's text is the clusterer's summary from the snapshot; a
// single-outlet story's text is the scorer's article summary.
export const CLUSTER_ASSESSMENT_MODEL = "fixture: clusterer summary";
export const ARTICLE_ASSESSMENT_MODEL = "fixture: scorer article summary";

function storyFrom({ slug, section, headline, eventStatement, assessmentText, assessmentModel, assessmentAt, members, firstSeenAt, updatedAt }) {
  const primary = members.filter((m) => m.role === "primary");
  const outletCount = new Set(primary.map((m) => m.outletKey)).size;
  return {
    id: `${FIXTURE_ID_PREFIX}${slug}`,
    slug,
    section: section ?? null,
    headline,
    eventStatement,
    assessment: assessmentText
      ? {
          text: assessmentText,
          // Never a real model name: none was called to build this fixture,
          // and a page that printed one would be lying about its provenance.
          // S4 writes the real assessment and the real model.
          model: assessmentModel,
          generatedAt: assessmentAt,
        }
      : null,
    firstSeenAt,
    updatedAt,
    outletCount,
    memberCount: members.length,
    ...phRange(members),
    singleOutlet: outletCount <= 1,
    members,
    // Layer 3 is server work (S5). An empty list is the honest state: the
    // fixture has computed no framing notes, and inventing one would put an
    // analysis on screen that nothing performed.
    notes: [],
    // The sweep is a server job too. It is reported complete because the
    // fixture's universe is the snapshot and the fixture did read all of it;
    // a false here would draw an incomplete-sweep warning nothing measured.
    coverage: { excluded: [], sweepComplete: true },
  };
}

// ── Build ───────────────────────────────────────────────────────────────────

// withHollowFixture: false builds a clean edition with no fabricated member,
// for a check that must not see one.
export function buildStories(snapshot, { withHollowFixture = true } = {}) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("stories fixture: snapshot must be an object with articles, articleDetail and clusters");
  }
  const articles = Array.isArray(snapshot.articles) ? snapshot.articles : [];
  const detail = snapshot.articleDetail ?? {};
  const clusters = Array.isArray(snapshot.clusters) ? snapshot.clusters : [];
  const clusterArticles = snapshot.clusterArticles ?? {};
  const byId = new Map(articles.map((a) => [a.id, a]));
  const taken = new Set();
  const stories = [];
  const clustered = new Set();

  // Multi-outlet stories first, from the clusters.
  for (const cluster of clusters) {
    const rows = clusterArticles[String(cluster.id)] ?? clusterArticles[cluster.id] ?? [];
    if (rows.length === 0) continue;
    const members = rows.map((row) => {
      clustered.add(row.id);
      return memberFrom(byId.get(row.id) ?? row, detail[String(row.id)]);
    });
    const slug = uniqueSlug(slugify(cluster.topic), taken);
    // A cluster's section is whatever its members agree on most often; the
    // cluster row does not carry one.
    const section = majoritySection(members, detail, byId);
    const earliest = members.map((m) => m.publishedAt).filter(Boolean).sort()[0] ?? cluster.updatedAt;
    stories.push(
      storyFrom({
        slug,
        section,
        headline: cluster.topic,
        eventStatement: firstSentence(cluster.summary) || cluster.topic,
        assessmentText: typeof cluster.summary === "string" && cluster.summary.trim() ? cluster.summary.trim() : null,
        assessmentModel: CLUSTER_ASSESSMENT_MODEL,
        assessmentAt: cluster.updatedAt,
        members,
        firstSeenAt: earliest,
        updatedAt: cluster.updatedAt,
      }),
    );
  }

  // Then a single-outlet story per scored article no cluster claimed (ruling 3:
  // they publish, lower in the order, labelled as such, with no findings).
  for (const article of articles) {
    if (clustered.has(article.id)) continue;
    const score = article.score ?? null;
    if (typeof score?.composite !== "number") continue;
    const member = memberFrom(article, detail[String(article.id)]);
    const slug = uniqueSlug(slugify(article.title), taken);
    const summary = typeof score.articleSummary === "string" ? score.articleSummary.trim() : "";
    const when = article.publishedAt ?? article.fetchedAt;
    stories.push(
      storyFrom({
        slug,
        section: score.section ?? null,
        headline: article.title,
        eventStatement: firstSentence(summary) || article.title,
        assessmentText: summary || null,
        assessmentModel: ARTICLE_ASSESSMENT_MODEL,
        assessmentAt: score.scoredAt ?? when,
        members: [member],
        firstSeenAt: when,
        updatedAt: article.fetchedAt ?? when,
      }),
    );
  }

  if (withHollowFixture) attachFixtureHollowMember(stories);
  return stories;
}

function majoritySection(members, detail, byId) {
  const counts = new Map();
  for (const m of members) {
    const s = detail[String(m.articleId)]?.score?.section ?? byId.get(m.articleId)?.score?.section ?? null;
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [section, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && section < best)) {
      best = section;
      bestN = n;
    }
  }
  return best;
}

// The hollow lane only has a shape to check if something is in it. This puts
// the one marked fixture member on the widest multi-outlet story, which is the
// story every surface shows first.
function attachFixtureHollowMember(stories) {
  const target = stories
    .filter((s) => !s.singleOutlet)
    .sort((a, b) => b.memberCount - a.memberCount || (a.id < b.id ? -1 : 1))[0];
  if (!target) return;
  target.members = [...target.members, { ...FIXTURE_MEMBER }];
  target.memberCount = target.members.length;
  target.outletCount = new Set(target.members.filter((m) => m.role === "primary").map((m) => m.outletKey)).size;
}

// ── Guards ──────────────────────────────────────────────────────────────────

// Legal and contract checks that run before any write. A failure exits non-zero
// and leaves the snapshot byte-for-byte in place.
export function inspectStories(stories) {
  const problems = [];
  const ids = new Set();
  const slugs = new Set();
  for (const s of stories) {
    if (ids.has(s.id)) problems.push(`duplicate story id ${s.id}`);
    ids.add(s.id);
    if (slugs.has(s.slug)) problems.push(`duplicate slug ${s.slug}`);
    slugs.add(s.slug);
    if (!s.headline) problems.push(`${s.id}: empty headline`);
    if (!s.eventStatement) problems.push(`${s.id}: empty event statement`);
    if (s.memberCount !== s.members.length) problems.push(`${s.id}: memberCount disagrees with members`);
    for (const m of s.members) {
      if ("rawText" in m) problems.push(`${s.id}: member ${m.articleId} carries rawText`);
      if (m.kind === "headline_only" && m.excerpt !== null) problems.push(`${s.id}: headline-only member ${m.articleId} carries an excerpt`);
      if (m.excerpt && !Array.isArray(m.excerpt.paragraphs)) problems.push(`${s.id}: member ${m.articleId} has a malformed excerpt`);
    }
  }
  const raw = JSON.stringify(stories);
  if (/"rawText"/.test(raw)) problems.push("rawText appears somewhere in the stories array");
  for (const s of stories) {
    if (!s.id.startsWith(FIXTURE_ID_PREFIX)) problems.push(`${s.id}: id lacks the ${FIXTURE_ID_PREFIX} prefix`);
    for (const m of s.members) {
      const marked = m.articleId === FIXTURE_MEMBER_ARTICLE_ID;
      if (marked && (!m.title.startsWith(FIXTURE_HEADLINE_ONLY_TITLE_PREFIX) || !m.outletName.endsWith(FIXTURE_OUTLET_SUFFIX))) {
        problems.push(`${s.id}: the fixture member is not marked in its title and outlet name`);
      }
      if (!marked && (m.title.includes(FIXTURE_MEMBER_MARK) || m.outletName.includes(FIXTURE_MEMBER_MARK))) {
        problems.push(`${s.id}: member ${m.articleId} carries the fixture mark but is real data`);
      }
    }
  }
  // No archive-host check here, deliberately. The fallback was removed rather
  // than disabled (the excerpt policy) and three files are allowed to name the
  // hosts in order to detect them: scripts/check-no-archive.mjs,
  // edition-manifest.mjs and verify-edition.mjs. Spelling the pattern in a
  // fourth file is itself a violation that check-no-archive reports, and the
  // check would be redundant anyway: every member url here is copied from a
  // snapshot that edition-manifest already refused to publish if it carried
  // one. The guard belongs upstream of this script, and it is there.
  return problems;
}

export function summarise(stories) {
  const multi = stories.filter((s) => !s.singleOutlet);
  const hollow = stories.filter((s) => s.members.some((m) => m.kind === "headline_only"));
  return {
    stories: stories.length,
    multiOutlet: multi.length,
    singleOutlet: stories.length - multi.length,
    members: stories.reduce((n, s) => n + s.members.length, 0),
    withHollow: hollow.length,
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const text = await readFile(SNAPSHOT_PATH, "utf8");
  const snapshot = JSON.parse(text);
  const stories = buildStories(snapshot, { withHollowFixture: !CLEAN });

  const problems = inspectStories(stories);
  if (problems.length > 0) {
    console.error(`\nstories fixture REFUSED (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const s = summarise(stories);
  console.log(
    `stories fixture: ${s.stories} stories (${s.multiOutlet} multi-outlet, ${s.singleOutlet} single-outlet), ` +
      `${s.members} members, ${s.withHollow} with a headline-only member`,
  );

  if (CHECK_ONLY) {
    console.log("--check: nothing written");
    return;
  }

  // Rebuilt rather than mutated so `stories` lands beside the other collections
  // in a stable place, and so a re-run replaces rather than appends.
  const out = { ...snapshot, stories };
  const tmp = `${SNAPSHOT_PATH}.tmp`;
  try {
    // Minified, exactly as scripts/build-snapshot.mjs writes it: a fixture run
    // and a real snapshot build must leave the same shape of file behind, and
    // this one ships inside the demo bundle.
    await writeFile(tmp, JSON.stringify(out), "utf8");
    await rename(tmp, SNAPSHOT_PATH);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  console.log(`wrote ${SNAPSHOT_PATH}`);
}

// Importable for tests without running the write.
if (process.argv[1] && process.argv[1].endsWith("stories-fixture.mjs")) {
  await main();
}
