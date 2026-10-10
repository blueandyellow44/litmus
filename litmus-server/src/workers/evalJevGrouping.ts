// Side-by-side check before Jev grouping goes live (Max, 2026-10-02): would
// Jev's same-event calls agree with the ones the Haiku ledger already made?
// Read-only: it refuses any database that accepts a write.
//
// Two samples from stories touched in the last two days:
//   A. Articles Haiku attached to a story with 3+ primary members (never the
//      story's first member, whose title the card was written from). Jev sees
//      that story with this article removed from its member list, plus up to
//      19 other candidates retrieval finds for it.
//   B. Articles Haiku left as a one-article story. Jev sees retrieval's
//      candidates, minus that story.
// Bars, set before the run:
//   A: Jev picks the same story at >= 80% for at least 70%, and a DIFFERENT
//      story at >= 80% for at most 5%.
//   B: Jev attaches to some story at >= 80% for at most 15%; every one of
//      those is printed so a person can say who is right.
// Usage: DATABASE_URL=<read-only copy> JEV_ACCOUNT_ID=... JEV_API_TOKEN=... \
//   npx tsx src/workers/evalJevGrouping.ts [perSample=100]
import { pool } from "../db/client.js";
import { listOpenStoryCards, retrieveCandidateStories, type StoryArticle, type StoryCard } from "../stories/retrieval.js";
import { jevSweepArticles, jevAssignmentPrepass, MATCH_AT, type JevArticle, type JevCard } from "../stories/jevGrouping.js";
import { JEV_INPUT_DOLLARS_PER_MILLION } from "../lib/jev.js";

const PER_SAMPLE = Number(process.argv[2] ?? "100");
const LOOKBACK_DAYS = 3;

try {
  await pool.query("CREATE TEMP TABLE write_probe (x int)");
  throw new Error("refusing: this database accepts writes; point DATABASE_URL at a read-only copy");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("refusing")) throw error;
}

const OUTLET = `COALESCE(src.outlet_key, 'source-' || src.id::text)`;
async function loadArticles(ids: number[]): Promise<Map<number, JevArticle>> {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.url, ${OUTLET} AS outlet_key, src.name AS outlet_name, src.lean AS source_lean, a.published_at, a.fetched_at,
            a.extraction_status, a.word_count, a.syndicated_of_article_id, s.article_summary, s.reacting_to, s.section,
            (s.flags->>'opinionColumn')::boolean AS opinion,
            array_to_string((regexp_split_to_array(btrim(COALESCE(a.clean_text, a.raw_text, '')), '\s+'))[1:120], ' ') AS lede
       FROM articles a JOIN sources src ON src.id = a.source_id LEFT JOIN scores s ON s.article_id = a.id
      WHERE a.id = ANY($1::int[])`, [ids]);
  return new Map(rows.map((r) => [r.id, { id: r.id, title: r.title, url: r.url, outletKey: r.outlet_key, outletName: r.outlet_name, sourceLean: r.source_lean,
    publishedAt: r.published_at, fetchedAt: r.fetched_at, extractionStatus: r.extraction_status, wordCount: r.word_count,
    syndicatedOfArticleId: r.syndicated_of_article_id, articleSummary: r.article_summary ?? null, reactingTo: r.reacting_to ?? null, section: r.section ?? null, lede: r.lede ?? null, opinion: r.opinion ?? null } as JevArticle]));
}

// A: non-first primary members of 3+ member stories. B: one-member stories.
const { rows: aRows } = await pool.query(
  `WITH m AS (
     SELECT sm.story_id, sm.article_id, row_number() OVER (PARTITION BY sm.story_id ORDER BY sm.added_at, sm.article_id) AS n,
            count(*) OVER (PARTITION BY sm.story_id) AS size
       FROM story_members sm JOIN stories st ON st.id = sm.story_id
      WHERE sm.role = 'primary' AND st.status <> 'merged' AND st.updated_at >= now() - interval '2 days')
   SELECT story_id, article_id FROM m WHERE size >= 3 AND n > 1 ORDER BY md5(article_id::text || $2) LIMIT $1`, [PER_SAMPLE, process.env.SEED ?? ""]);
const { rows: bRows } = await pool.query(
  `SELECT sm.story_id, min(sm.article_id) AS article_id FROM story_members sm JOIN stories st ON st.id = sm.story_id
    WHERE sm.role = 'primary' AND st.status <> 'merged' AND st.updated_at >= now() - interval '2 days'
    GROUP BY sm.story_id HAVING count(*) = 1 ORDER BY md5(sm.story_id || $2) LIMIT $1`, [PER_SAMPLE, process.env.SEED ?? ""]);
const articles = await loadArticles([...aRows, ...bRows].map((r) => r.article_id));

const truth = new Map<number, { sample: "A" | "B"; storyId: string }>();
const candidates = new Map<number, StoryCard[]>();
for (const [sample, rows] of [["A", aRows], ["B", bRows]] as const) {
  for (const r of rows) {
    const article = articles.get(r.article_id);
    if (!article) continue;
    const found = await retrieveCandidateStories(article, 25, LOOKBACK_DAYS);
    // The article never sees its own title inside a card.
    const clean = (c: StoryCard): StoryCard => {
      const keep = c.memberArticleIds.map((id, i) => [id, c.memberHeadlines[i]] as const).filter(([id]) => id !== article.id);
      return { ...c, memberArticleIds: keep.map(([id]) => id), memberHeadlines: keep.map(([, h]) => h!) };
    };
    const others = found.filter((c) => c.id !== r.story_id).slice(0, 19).map(clean);
    let list = others;
    if (sample === "A") {
      const own = found.find((c) => c.id === r.story_id) ?? null;
      if (!own) continue; // retrieval never offered its own story; nothing for Jev to find
      list = [...others, clean(own)].sort((x, y) => x.id.localeCompare(y.id));
    }
    if (list.length === 0) continue;
    truth.set(article.id, { sample, storyId: r.story_id });
    candidates.set(article.id, list);
  }
}

// Member summaries for every card any article will see.
const allCardIds = [...new Set([...candidates.values()].flat().map((c) => c.id))];
const { rows: sumRows } = await pool.query(
  `SELECT sm.story_id, array_agg(json_build_object('id', sm.article_id, 's', s.article_summary) ORDER BY sm.added_at, sm.article_id) FILTER (WHERE s.article_summary IS NOT NULL) AS sums
     FROM story_members sm LEFT JOIN scores s ON s.article_id = sm.article_id
    WHERE sm.story_id = ANY($1) AND sm.role = 'primary' GROUP BY sm.story_id`, [allCardIds]);
const summariesById = new Map(sumRows.map((r) => [r.story_id, (r.sums ?? []) as Array<{ id: number; s: string }>]));
const plainArticle = (a: JevArticle): StoryArticle => { const { lede: _l, opinion: _o, ...rest } = a; return rest; };
// The opening text only where there is no summary to read (unscored articles).
const gapFill = (a: JevArticle): JevArticle => (a.articleSummary ? plainArticle(a) : { ...plainArticle(a), lede: a.lede ?? null });
const missingSummary = [...articles.values()].filter((a) => !a.articleSummary).length;
console.log(`articles without a summary: ${missingSummary}/${articles.size}; of those with an opening to give: ${[...articles.values()].filter((a) => !a.articleSummary && a.lede).length}`);

// Hand labels (Claude's reading, 2026-10-02, not Max's) of the joins the first
// run disagreed with Haiku on: these titles Jev should NOT have joined.
const WRONG = ["Mullahs", "Collins Firewall", "Man City to argue", "ActBlue"];
const RIGHT = ["Hochul and James", "WATCH:", "4 takeaways", "Trump's Way", "retail investors", "high-tech government hub", "Mortgage rates soar", "10-year Treasury", "election forecast", "30-year mortgage", "Alito"];
const hit = (title: string, keys: string[]) => keys.some((k) => title.includes(k));

async function arm(name: string, rich: boolean | "gap", opinionNote: boolean, verify: boolean | "moment" | "both" = false, style: "rule" | "sharp" = "rule", perCall?: number) {
  let tokens = 0;
  // richPick: whether the first (pick) call sees the fuller context too; the
  // verification call always gets it when rich is on.
  const offered = [...truth.keys()].map((id) => (rich === "gap" ? gapFill(articles.get(id)!) : rich ? articles.get(id)! : plainArticle(articles.get(id)!)));
  const cands = new Map([...candidates].map(([id, cs]) => [id, rich === true ? cs.map((c): JevCard => {
    const sums = (summariesById.get(c.id) ?? []).filter((m) => m.id !== id).map((m) => m.s);
    return { ...c, memberSummaries: sums };
  }) : cs]));
  const prepass = await jevAssignmentPrepass(offered, cands, async (u) => { tokens += u.inputTokens; }, { opinionNote, verify, style, perCall });
  const decided = new Map(prepass.decided.map((d) => [d.articleId, d]));
  const noMatch = new Set([...prepass.candidatesForHaiku].filter(([, c]) => c.length === 0).map(([id]) => id));
  const t = { A: { n: 0, same: 0, other: 0, none: 0, unsure: 0 }, B: { n: 0, attached: 0, none: 0, unsure: 0 }, wrongJoinsMade: 0, rightJoinsKept: 0 };
  const lines: string[] = [];
  const headline = (articleId: number, storyId: string) => candidates.get(articleId)!.find((c) => c.id === storyId)?.headline ?? storyId;
  for (const [id, tr] of truth) {
    const d = decided.get(id);
    const title = articles.get(id)!.title;
    const joinedElsewhere = d?.action === "attach" && (tr.sample === "B" || d.storyIds[0] !== tr.storyId);
    if (joinedElsewhere && hit(title, WRONG)) t.wrongJoinsMade++;
    if (joinedElsewhere && hit(title, RIGHT)) t.rightJoinsKept++;
    if (tr.sample === "A") {
      t.A.n++;
      if (d?.action === "attach" && d.storyIds[0] === tr.storyId) t.A.same++;
      else if (d?.action === "attach") t.A.other++;
      else if (noMatch.has(id)) t.A.none++;
      else t.A.unsure++;
    } else {
      t.B.n++;
      if (d?.action === "attach") t.B.attached++;
      else if (noMatch.has(id)) t.B.none++;
      else t.B.unsure++;
    }
    if (joinedElsewhere && d?.action === "attach") lines.push(`  ${tr.sample} "${title}" -> ${headline(id, d.storyIds[0]!)} (${d.reason.match(/\((\d+%)\)/)?.[1]})`);
    if (tr.sample === "A" && noMatch.has(id)) lines.push(`  A "${title}" -> Jev: no match; Haiku: ${headline(id, tr.storyId)}`);
  }
  const pct = (x: number, n: number) => (n ? `${Math.round((100 * x) / n)}%` : "n/a");
  console.log(`\n== ${name} (Jev $${((tokens * JEV_INPUT_DOLLARS_PER_MILLION) / 1e6).toFixed(4)})`);
  console.log(`A agree ${pct(t.A.same, t.A.n)}, other story ${pct(t.A.other, t.A.n)}, no match ${pct(t.A.none, t.A.n)}, back to Haiku ${pct(t.A.unsure, t.A.n)}  (n=${t.A.n})`);
  console.log(`B joins ${pct(t.B.attached, t.B.n)}, agrees no match ${pct(t.B.none, t.B.n)}, back to Haiku ${pct(t.B.unsure, t.B.n)}  (n=${t.B.n})`);
  console.log(`stats ${JSON.stringify(prepass.stats)}`);
  for (const w of prepass.windowed) console.log(`  window held back: "${articles.get(w.articleId)!.title}" (${articles.get(w.articleId)!.publishedAt?.toISOString().slice(0, 10)}) -> ${headline(w.articleId, w.storyId)} (first seen ${candidates.get(w.articleId)!.find((c) => c.id === w.storyId)?.firstSeenAt.toISOString().slice(0, 10)})`);
  console.log(`hand-labelled: wrong joins made ${t.wrongJoinsMade}/${WRONG.length}, right joins kept ${t.rightJoinsKept}/${RIGHT.length}`);
  console.log(lines.join("\n"));
}
const arms = (process.env.ARMS ?? "base,rich,rich+note").split(",");
if (arms.includes("base")) await arm("current context", false, false);
if (arms.includes("rich")) await arm("+ opening, opinion flag, member summaries", true, false);
if (arms.includes("rich+note")) await arm("+ the same, plus the opinion note", true, true);
if (arms.includes("verify")) await arm("pick, then yes/no checks on the pick (fuller context, opinion note)", true, true, true);
if (arms.includes("sharp")) await arm("SHARP: options are triggering moments + dates, one plain question, clean titles", false, false, false, "sharp");
if (arms.includes("sharp+moment")) await arm("SHARP + moment-or-reaction check on each pick", false, false, "moment", "sharp");
if (arms.includes("sweep")) {
  // The exhaustive sweep for the one-article stories, timed, as production runs it.
  const open = await listOpenStoryCards(LOOKBACK_DAYS);
  const targets = bRows.map((r) => articles.get(r.article_id)).filter((a): a is JevArticle => !!a).map(process.env.GAP === "1" ? gapFill : plainArticle);
  const seeded = new Map(bRows.map((r) => [r.article_id as number, r.story_id as string]));
  let tokens = 0;
  const t0 = Date.now();
  const r = await jevSweepArticles(targets, open, { seededStoryIds: seeded, onUsage: async (u) => { tokens += u.inputTokens; } });
  const attached = r.decisions.filter((d) => d.action === "attach");
  console.log(`\n== SWEEP: ${targets.length} articles x ${open.length} open stories: ${r.calls} Jev calls, ${((Date.now() - t0) / 1000).toFixed(0)}s, $${((tokens * JEV_INPUT_DOLLARS_PER_MILLION) / 1e6).toFixed(4)}, unfinished ${r.incompleteArticleIds.length}`);
  console.log(`attached ${attached.length}:`);
  for (const d of attached) if (d.action === "attach") console.log(`  "${articles.get(d.articleId)!.title}" -> ${open.find((c) => c.id === d.storyIds[0])?.headline} (${d.reason})`);
}
if (arms.includes("solo")) await arm("SHARP + moment check, ONE article per call", false, false, "moment", "sharp", 1);
if (arms.includes("solo-gap")) await arm("SHARP + check + one per call + opening text when no summary", "gap", false, "moment", "sharp", 1);
if (arms.includes("solo-base")) await arm("current question, ONE article per call", false, false, false, "rule", 1);
if (arms.includes("verify-lean")) await arm("pick, then yes/no checks on the pick (current context)", false, false, true);
await pool.end();
