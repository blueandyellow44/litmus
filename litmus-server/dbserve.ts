import EmbeddedPostgres from "embedded-postgres";
import { readFile } from "node:fs/promises";
const DATA_DIR = "/private/tmp/claude-501/-Users-maxsheahan-LITMUS2/e68e8be2-68b9-41e9-8faa-608616c60cf7/scratchpad/pgdata2";
const pg = new EmbeddedPostgres({ databaseDir: DATA_DIR, user: "litmus", password: "litmus", port: 5432, persistent: true });
const fresh = !(await import("node:fs")).existsSync(DATA_DIR + "/PG_VERSION");
if (fresh) { await pg.initialise(); }
await pg.start();
if (fresh) { await pg.createDatabase("litmus"); }
const { pool } = await import("./src/db/client.js");
const { insertArticle, listUnscoredArticles } = await import("./src/db/repos/articlesRepo.js");
const { insertScores } = await import("./src/db/repos/scoresRepo.js");
const { runBatches } = await import("./src/scoring/batchRunner.js");
await pool.query(await readFile("./src/db/schema.sql", "utf-8"));
const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM articles");
if (rows[0].n === 0) {
  const src = await pool.query(`INSERT INTO sources (name,rss_url,lean,type,paywall_status,reliability,enabled) VALUES ('The Wire Report','http://t/1','center','wire','free',5,true),('National Pulse Opinion','http://t/2','right','digital-native','free',3,true),('Capitol Ledger','http://t/3','center-left','newspaper','free',4,true) RETURNING id`);
  const ids = src.rows.map((r:any)=>r.id);
  const P=(a:string[])=>a.join("\n\n");
  const arts=[
   {s:ids[0],t:"Senate passes $1.2 trillion infrastructure bill in 69-30 vote",b:P(["The Senate on Tuesday passed a $1.2 trillion infrastructure bill by a vote of 69 to 30, sending the measure to the House.","The bill allocates $110 billion for roads and bridges and $65 billion for broadband expansion, according to a committee summary.","Eighteen Republicans joined all Democrats in supporting the measure. Senator Collins said it reflected months of bipartisan negotiation.","Opponents said the spending was not fully offset. The CBO estimated the bill would add $256 billion to the deficit over ten years.","The House is expected to take up the bill next month. The White House said the president would sign it if it reached his desk."])},
   {s:ids[1],t:"This reckless spending spree will destroy our children's future",b:P(["Make no mistake: the swamp just detonated a $1.2 trillion bomb under your family's future, and the sellout politicians are cheering.","In a shameless betrayal, 18 so-called conservatives caved to the radical agenda, torching every principle they ever pretended to hold.","The Senate passed the infrastructure bill 69 to 30 on Tuesday. It includes funding for roads, bridges, and broadband.","This is nothing short of generational theft. They are mortgaging your grandchildren's lives to bureaucrats who never built anything but debt.","Wake up, America. If we do not stop this madness now, there will be nothing left to save."])},
   {s:ids[2],t:"Infrastructure bill clears Senate as both sides claim wins and warn of costs",b:P(["The Senate approved a sweeping infrastructure package Tuesday, a hard-fought win that supporters hailed as historic and critics blasted as bloated.","The 69-30 vote sends the bill to a divided House, where its fate is far from certain despite the show of bipartisan support.","Backers pointed to $110 billion for crumbling roads. Detractors seized on the deficit impact, warning of a reckoning to come.","Analysts said the real fight is only beginning. The coming weeks could determine whether the fragile coalition holds or collapses."])},
  ];
  for(let i=0;i<arts.length;i++){await insertArticle({sourceId:arts[i].s,url:`http://t/a${i}`,title:arts[i].t,author:null,publishedAt:new Date(Date.now()-i*3600000),rawText:arts[i].b,wordCount:arts[i].b.split(/\s+/).length,extractionStatus:"full",paywallFlag:false,contentHash:`h${i}`,extractedVia:"publisher"});}
  const un=await listUnscoredArticles(50);
  const {scores}=await runBatches(un);
  await insertScores(scores);
  console.log(`SEEDED+SCORED ${scores.length}`);
} else { console.log("DB already seeded"); }
console.log("DB READY on :5432");
process.on("SIGINT", async()=>{await pg.stop();process.exit(0);});
process.on("SIGTERM", async()=>{await pg.stop();process.exit(0);});
await new Promise(()=>{}); // stay alive
