// Render a calibration run into ONE self-contained interactive grading page.
//
// The run JSON is the record; this is the surface Max grades from. Every score,
// marker, and metric on the page is read out of the run file — nothing is
// recomputed here, so the page cannot flatter the run.
//
//   node scripts/build-calibration-review.mjs calibration-runs/<run>.json
//
// Output goes to calibration-review/<runId>.html — a new file per run, never an
// overwrite, so an earlier review stays openable.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

// Mirrors litmus-client/src/lib/highlight.ts. The page must show the reader's
// actual colours, or it is grading something the reader will never see.
const RED_RGB = "185, 28, 28";
const GREEN_RGB = "21, 128, 61";
const GREEN_CATEGORIES = new Set(["grounded", "hedging"]);
const ALPHA_BY_INTENSITY = [0.14, 0.24, 0.36, 0.5, 0.66];

function alphaFor(intensity) {
  const i = Math.max(1, Math.min(5, Math.round(intensity || 1)));
  return ALPHA_BY_INTENSITY[i - 1];
}

function backgroundFor(marker) {
  const rgb = GREEN_CATEGORIES.has(marker.category) ? GREEN_RGB : RED_RGB;
  return `rgba(${rgb}, ${alphaFor(marker.intensity)})`;
}

// Mirrors litmus-client/src/lib/loadedLexicon.ts quotedSpans.
function quotedSpans(text) {
  const spans = [];
  const RE = /[“"][^”"]*[”"]/g;
  let m;
  while ((m = RE.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

// Mirrors litmus-client/src/lib/highlight.ts computeHighlightRanges: verbatim
// match, drop anything starting inside a quote, earliest wins and on a tie the
// longest, no overlaps.
function computeRanges(text, markers) {
  const quotes = quotedSpans(text);
  const inQuote = (i) => quotes.some(([a, b]) => i >= a && i < b);
  const found = [];
  for (const marker of markers) {
    if (!marker.text) continue;
    const start = text.indexOf(marker.text);
    if (start === -1 || inQuote(start)) continue;
    found.push({ start, end: start + marker.text.length, marker });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cursor = 0;
  for (const r of found) {
    if (r.start < cursor) continue;
    out.push(r);
    cursor = r.end;
  }
  return out;
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function renderPassage(paragraphs, markers) {
  const text = paragraphs.join("\n\n");
  const ranges = computeRanges(text, markers);
  let html = "";
  let cursor = 0;
  for (const r of ranges) {
    html += esc(text.slice(cursor, r.start));
    const title = `${r.marker.category} · intensity ${r.marker.intensity}`;
    html += `<mark class="mk" style="background:${backgroundFor(r.marker)}" title="${esc(title)}">${esc(
      text.slice(r.start, r.end),
    )}</mark>`;
    cursor = r.end;
  }
  html += esc(text.slice(cursor));
  return html
    .split("\n\n")
    .map((p) => `<p>${p}</p>`)
    .join("");
}

function bandLabel(c) {
  if (c <= 1.4) return "Proportionate";
  if (c <= 2.4) return "Grounded";
  if (c <= 3.4) return "Mixed Signals";
  if (c <= 4.4) return "Running Hot";
  return "Hyperbolic";
}

function bandClass(c) {
  if (c <= 1.4) return "b-practical";
  if (c <= 2.4) return "b-grounded";
  if (c <= 3.4) return "b-mixed";
  if (c <= 4.4) return "b-hot";
  return "b-hyst";
}

// Concrete, checkable observations only — never a verdict dressed up as one.
// The point is to hand Max something to confirm or veto, not a blank survey.
function claudeRead(a) {
  const notes = [];
  const haiku = a.arms.find((x) => x.alias === "haiku");
  const sonnet = a.arms.find((x) => x.alias === "sonnet");
  if (haiku && sonnet) {
    const d = Math.abs(haiku.score.composite - sonnet.score.composite);
    if (d >= 1.0) {
      notes.push(
        `The two models are ${d.toFixed(1)} apart, so this one needs your call. Haiku ${haiku.score.composite.toFixed(
          1,
        )}, Sonnet ${sonnet.score.composite.toFixed(1)}.`,
      );
    }
    if (haiku.score.flags.register !== sonnet.score.flags.register) {
      notes.push(
        `They disagree on register: Haiku read it as ${haiku.score.flags.register}, Sonnet as ${sonnet.score.flags.register}. Register decides whether vivid language is taxed.`,
      );
    }
    const sec = a.baseline?.section ?? haiku.score.section;
    for (const arm of [haiku, sonnet]) {
      if ((sec === "Sports" || sec === "Culture") && arm.score.composite >= 2.8) {
        notes.push(
          `${arm.alias} put a ${sec} piece at ${arm.score.composite.toFixed(
            1,
          )}. Genre colour should not score hot; if this reads as ordinary ${sec.toLowerCase()} writing, that is a miss.`,
        );
      }
    }
  }
  if (a.baseline) {
    for (const arm of a.arms) {
      const d = arm.score.composite - a.baseline.composite;
      if (Math.abs(d) >= 1.2) {
        notes.push(
          `${arm.alias} moved ${d > 0 ? "up" : "down"} ${Math.abs(d).toFixed(1)} from the old score of ${a.baseline.composite.toFixed(1)}.`,
        );
      }
    }
  }
  if (a.extractionStatus === "partial") {
    notes.push("Extraction was partial, so the scorer saw a truncated body. Judge accordingly.");
  }
  if (notes.length === 0) notes.push("Both models agree and nothing looks anomalous. A quick confirm is enough.");
  return notes;
}

function armBlock(arm, a) {
  const s = arm.score;
  const m = arm.metrics;
  const b = s.breakdown ?? {};
  const raised = (b.raised ?? []).length
    ? `<div class="raised">raised for ${esc((b.raised ?? []).join("; "))}</div>`
    : "";
  const flagBits = Object.entries({
    "emotional lede": s.flags?.emotionalLede,
    "loaded headline": s.flags?.loadedHeadline,
    "one-sided sourcing": s.flags?.oneSidedSourcing,
    "opinion column": s.flags?.opinionColumn,
  })
    .filter(([, v]) => v)
    .map(([k]) => `<span class="flag on">${esc(k)}</span>`)
    .join("");
  const fallacies = s.flags?.fallacyCount
    ? `<span class="flag on">${s.flags.fallacyCount} fallac${s.flags.fallacyCount === 1 ? "y" : "ies"}</span>`
    : "";
  const register = `<span class="flag reg">register: ${esc(s.flags?.register ?? "news")}</span>`;

  return `
  <div class="arm">
    <div class="arm-head">
      <span class="arm-name">${esc(arm.alias)}</span>
      <span class="score ${bandClass(s.composite)}">${s.composite.toFixed(1)} ${esc(bandLabel(s.composite))}</span>
      ${s.declaredBand && s.declaredBand !== bandLabel(s.composite) ? `<span class="warn">model read it as ${esc(s.declaredBand)}</span>` : ""}
    </div>
    <div class="dims">
      headline ${s.headline} · language ${s.language} · sourcing ${s.sourcing} · fallacies ${s.fallacies} · structure ${s.structure}
      <span class="sep">|</span> weighted ${b.base ?? "?"}
    </div>
    ${raised}
    <div class="flags">${register}${flagBits}${fallacies}</div>
    <div class="metrics">${m.markerCount} markers, ${m.markersInExcerpt} in the excerpt · ${m.redCount} red / ${m.greenCount} green · ${m.excerptWords} words shown${
      m.markersInQuote ? ` · <span class="bad">${m.markersInQuote} inside quotes</span>` : ""
    }</div>
    <div class="passage">${renderPassage(arm.excerptParagraphs, s.markers)}</div>
    <details class="why"><summary>rationale</summary>
      <div><b>headline.</b> ${esc(s.rationale?.headline)}</div>
      <div><b>language.</b> ${esc(s.rationale?.language)}</div>
      <div><b>sourcing.</b> ${esc(s.rationale?.sourcing)}</div>
      <div><b>fallacies.</b> ${esc(s.rationale?.fallacies)}</div>
      <div><b>structure.</b> ${esc(s.rationale?.structure)}</div>
      <div class="verdict"><b>summary.</b> ${esc(s.rationale?.summary)}</div>
    </details>
  </div>`;
}

function baselineBlock(a) {
  if (!a.baseline) {
    return `<div class="arm baseline"><div class="arm-head"><span class="arm-name">live prompt</span><span class="score none">never scored</span></div>
      <div class="metrics">This article was in the corpus but carried no stored score.</div></div>`;
  }
  const bl = a.baseline;
  const m = bl.metrics;
  return `
  <div class="arm baseline">
    <div class="arm-head">
      <span class="arm-name">live prompt (today)</span>
      <span class="score ${bandClass(bl.composite)}">${bl.composite.toFixed(1)} ${esc(bl.label)}</span>
    </div>
    <div class="dims">headline ${bl.headline} · language ${bl.language} · sourcing ${bl.sourcing} · fallacies ${bl.fallacies} · structure ${bl.structure}</div>
    <div class="metrics">${m.markerCount} markers, ${m.markersInExcerpt} in the excerpt · ${m.redCount} red / ${m.greenCount} green${
      m.markersInQuote ? ` · <span class="bad">${m.markersInQuote} inside quotes</span>` : ""
    }</div>
    <div class="passage">${renderPassage(bl.excerptParagraphs, bl.markers)}</div>
  </div>`;
}

function summaryStats(run) {
  const rows = [];
  const mk = (label, composites, markerCounts, inExcerpt, inQuote) => {
    if (!composites.length) return;
    const sorted = [...composites].sort((x, y) => x - y);
    const med = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
    rows.push(`<tr>
      <td>${esc(label)}</td><td>${composites.length}</td>
      <td>${sorted[0].toFixed(1)}</td><td>${med(composites).toFixed(1)}</td><td>${sorted[sorted.length - 1].toFixed(1)}</td>
      <td>${composites.filter((c) => c >= 3.0).length}</td>
      <td>${composites.filter((c) => c >= 3.5).length}</td>
      <td>${med(markerCounts)}</td><td>${med(inExcerpt)}</td>
      <td>${inQuote.reduce((p, q) => p + q, 0)}</td>
    </tr>`);
  };
  const base = run.articles.map((a) => a.baseline).filter(Boolean);
  mk(
    "live prompt (today)",
    base.map((b) => b.composite),
    base.map((b) => b.metrics.markerCount),
    base.map((b) => b.metrics.markersInExcerpt),
    base.map((b) => b.metrics.markersInQuote),
  );
  const aliases = [...new Set(run.articles.flatMap((a) => a.arms.map((x) => x.alias)))];
  for (const alias of aliases) {
    const arms = run.articles.flatMap((a) => a.arms.filter((x) => x.alias === alias));
    mk(
      `candidate · ${alias}`,
      arms.map((x) => x.score.composite),
      arms.map((x) => x.metrics.markerCount),
      arms.map((x) => x.metrics.markersInExcerpt),
      arms.map((x) => x.metrics.markersInQuote),
    );
  }
  return rows.join("");
}

function build(runPath) {
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  const aliases = [...new Set(run.articles.flatMap((a) => a.arms.map((x) => x.alias)))];

  const cards = run.articles
    .map((a, idx) => {
      const notes = claudeRead(a)
        .map((n) => `<li>${esc(n)}</li>`)
        .join("");
      return `
    <article class="card" id="a${a.articleId}">
      <header>
        <div class="idx">${idx + 1} of ${run.articles.length}</div>
        <h2>${esc(a.title)}</h2>
        <div class="meta">${esc(a.sourceName)} · ${esc(a.baseline?.section ?? a.arms[0]?.score.section ?? "unclassified")} · ${a.wordCount} words${
          a.extractionStatus === "partial" ? ' · <span class="bad">partial extraction</span>' : ""
        } · <a href="${esc(a.url)}" target="_blank" rel="noreferrer">source</a></div>
      </header>
      <ul class="read">${notes}</ul>
      <div class="arms">
        ${baselineBlock(a)}
        ${a.arms.map((arm) => armBlock(arm, a)).join("")}
      </div>
      <div class="verdicts" data-article="${a.articleId}">
        <span class="vlabel">Your call on this article:</span>
        <label><input type="radio" name="v${a.articleId}" value="approve"> the candidate is right</label>
        <label><input type="radio" name="v${a.articleId}" value="revise"> close, needs adjustment</label>
        <label><input type="radio" name="v${a.articleId}" value="reject"> wrong</label>
        <label class="pick">better model:
          <select name="m${a.articleId}">
            <option value="">—</option>
            ${aliases.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}
            <option value="tie">tie</option>
          </select>
        </label>
        <input class="note" name="n${a.articleId}" placeholder="note (what is wrong, in your words)">
      </div>
    </article>`;
    })
    .join("");

  const usage = Object.entries(run.usage ?? {})
    .map(
      ([alias, u]) =>
        `<li><b>${esc(alias)}</b>: ${u.calls} calls, ${u.inputTokens.toLocaleString()} input tokens, ${u.outputTokens.toLocaleString()} output tokens</li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>P/H calibration review — ${esc(run.runId)}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#16181d"/><text x="16" y="23" font-size="19" font-family="Georgia,serif" fill="#fff" text-anchor="middle">P</text></svg>',
  )}"><!-- Inline, not a sibling file: this page is opened from file://, where Chrome
     treats every file URL as a unique origin and blocks a linked icon outright.
     The standing rule against data: URI favicons is about DEPLOYED surfaces. -->
<style>
  :root { --ink:#16181d; --muted:#6b7280; --line:#e5e7eb; --bg:#fbfbfa; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:32px 28px 120px; }
  h1 { font-family:Georgia,serif; font-size:30px; margin:0 0 6px; }
  .sub { color:var(--muted); margin-bottom:26px; }
  .panel { background:#fff; border:1px solid var(--line); border-radius:10px; padding:20px 22px; margin-bottom:22px; }
  .panel h3 { margin:0 0 10px; font-size:15px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .panel p { margin:0 0 10px; }
  .panel ul { margin:6px 0 0 18px; padding:0; }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:22px; margin-bottom:22px; }
  .idx { color:var(--muted); font-size:12px; letter-spacing:.06em; text-transform:uppercase; }
  .card h2 { font-family:Georgia,serif; font-size:21px; margin:4px 0 6px; line-height:1.3; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:14px; }
  .meta a { color:var(--muted); }
  .read { margin:0 0 16px; padding:12px 16px 12px 30px; background:#f4f6f8; border-left:3px solid #9aa4b2; border-radius:0 6px 6px 0; font-size:14px; }
  .read li { margin:3px 0; }
  .arms { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; }
  .arm { border:1px solid var(--line); border-radius:8px; padding:14px; background:#fff; min-width:0; }
  .arm.baseline { background:#fafafa; }
  .arm-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:8px; }
  .arm-name { font-weight:700; font-size:13px; text-transform:uppercase; letter-spacing:.05em; }
  .score { font-weight:700; padding:2px 9px; border-radius:20px; font-size:13px; }
  .b-practical{background:#dcfce7;color:#14532d} .b-grounded{background:#ecfccb;color:#3f6212}
  .b-mixed{background:#fef9c3;color:#713f12} .b-hot{background:#ffedd5;color:#7c2d12}
  .b-hyst{background:#fee2e2;color:#7f1d1d} .score.none{background:#eee;color:#666;font-weight:500}
  .warn { font-size:12px; color:#92400e; background:#fef3c7; padding:2px 7px; border-radius:4px; }
  .dims,.metrics,.raised { font-size:12.5px; color:var(--muted); margin-bottom:5px; }
  .raised { color:#7c2d12; }
  .sep { opacity:.4; margin:0 5px; }
  .bad { color:#b91c1c; font-weight:600; }
  .flags { margin-bottom:9px; display:flex; flex-wrap:wrap; gap:5px; }
  .flag { font-size:11.5px; padding:2px 7px; border-radius:4px; background:#eef1f4; color:#475569; }
  .flag.on { background:#fee2e2; color:#7f1d1d; }
  .flag.reg { background:#e0e7ff; color:#3730a3; }
  .passage { font-family:Georgia,serif; font-size:15px; line-height:1.62; border-top:1px solid var(--line); padding-top:10px; overflow-wrap:break-word; }
  .passage p { margin:0 0 9px; }
  .mk { border-radius:2px; padding:0 1px; }
  .why { margin-top:10px; font-size:13px; color:#374151; }
  .why summary { cursor:pointer; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  .why div { margin:7px 0; }
  .why .verdict { border-top:1px dashed var(--line); padding-top:7px; }
  .verdicts { margin-top:16px; padding-top:14px; border-top:1px solid var(--line);
    display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-size:14px; }
  .vlabel { font-weight:600; }
  .verdicts label { display:flex; align-items:center; gap:5px; cursor:pointer; }
  .note { flex:1; min-width:220px; padding:7px 10px; border:1px solid var(--line); border-radius:6px; font-size:14px; font-family:inherit; }
  select { padding:5px 7px; border:1px solid var(--line); border-radius:6px; font-family:inherit; }
  .bar { position:fixed; left:0; right:0; bottom:0; background:#16181d; color:#fff;
    padding:12px 28px; display:flex; align-items:center; gap:16px; flex-wrap:wrap; z-index:50; }
  .bar b { font-size:14px; }
  .bar select,.bar input { font-size:14px; }
  .bar .spacer { flex:1; }
  button { background:#fff; color:#16181d; border:0; border-radius:6px; padding:8px 15px;
    font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; }
  button.ghost { background:#374151; color:#fff; }
  #save { font-size:13px; color:#9ca3af; }
  #save.err { color:#fca5a5; font-weight:700; }
  #out { width:100%; height:190px; margin-top:12px; font-family:ui-monospace,Menlo,monospace; font-size:12px;
    border:1px solid var(--line); border-radius:6px; padding:10px; display:none; }
</style>
</head><body>
<div class="wrap">
  <h1>P/H calibration review</h1>
  <div class="sub">Run <code>${esc(run.runId)}</code> · ${run.articles.length} articles · started ${esc(run.startedAt)}</div>

  <div class="panel">
    <h3>What changed, and what you are judging</h3>
    <p>Three defects were found in the live scorer and fixed. Judge whether the fixes are right, and which model should run the scorer.</p>
    <ul>
      <li><b>The composite was an average, not the spec.</b> The model was asked to apply a weighted sum with conditional penalties and instead returned the flat mean of its five dimensions, ignoring penalties it had named in its own rationale. On two articles it declared the band "Mixed Signals" and then emitted 2.0 and 2.3, which are Grounded. The arithmetic now runs in code from the model's judgments, and every number on this page can be replayed term by term.</li>
      <li><b>The highlights were a curated reel.</b> The instruction asked for 12 to 25 markers per article through several revisions; the model returned four or five. A second focused pass now marks only the passage the reader is actually shown, which lifted the median from 5 markers to 19.</li>
      <li><b>Quoted speech was leaking into the highlights.</b> The silo was stated three times in the prompt and still violated, more so once density was pushed. It is now enforced in code, matching what the client already refuses to render.</li>
    </ul>
    <p>Vivid sports and culture writing is no longer taxed as manipulation: register is judged per section, so a match report is colour, not hysteria. That is why the World Cup roundup moved off 3.8.</p>
  </div>

  <div class="panel">
    <h3>The rubric, before the verdicts</h3>
    <p>For each article, decide whether the candidate score is the score you would give, and whether the highlighting shows a reader what they need. Then say which model read it better.</p>
    <ul>
      <li><b>The scale.</b> 1.0–1.4 Proportionate, 1.5–2.4 Grounded, 2.5–3.4 Mixed Signals, 3.5–4.4 Running Hot, 4.5–5.0 Hyperbolic.</li>
      <li><b>P/H is how it is told, never what position it takes.</b> A left piece and a right piece can both be 1.2.</li>
      <li><b>Quoted speech is invisible.</b> A calm report of a furious quote is calm writing. Only the outlet's own words count.</li>
      <li><b>Green must be earned.</b> Grounded is a checkable fact in the outlet's voice, not an allegation and not merely composed prose.</li>
      <li><b>Genre colour is not manipulation.</b> Sports and culture writing is vivid by convention.</li>
    </ul>
  </div>

  <div class="panel">
    <h3>The run, measured</h3>
    <table>
      <tr><th>prompt</th><th>n</th><th>min</th><th>median</th><th>max</th><th>≥3.0</th><th>≥3.5</th><th>markers (med)</th><th>in excerpt (med)</th><th>in quotes</th></tr>
      ${summaryStats(run)}
    </table>
    <p style="margin-top:12px"><b>How to read this.</b> The live prompt's scores bunch in the middle and never reach the top bands. The candidate should spread across the scale and put markedly more highlights inside the passage the reader sees, with zero markers inside quotes.</p>
    <ul>${usage}</ul>
    <p style="color:#6b7280;font-size:14px">One limit worth naming: this corpus is mostly technology and science feed volume, and holds only about seventeen political articles. It cannot prove the top of the scale is reachable on genuinely inflammatory writing, because it does not contain much. Treat the top band as untested rather than working.</p>
  </div>

  ${cards}
</div>

<div class="bar">
  <b>Overall</b>
  <label>scorer model:
    <select id="overall-model">
      <option value="">—</option>
      ${aliases.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}
      <option value="neither">neither, keep iterating</option>
    </select>
  </label>
  <label>calibration: <select id="overall-verdict">
    <option value="">—</option>
    <option value="ship">ship it</option>
    <option value="revise">revise</option>
    <option value="reject">reject</option>
  </select></label>
  <input id="overall-note" class="note" placeholder="overall note" style="max-width:340px">
  <span class="spacer"></span>
  <span id="save">saving…</span>
  <button id="copy">Copy results</button>
  <button class="ghost" id="show">Show JSON</button>
</div>
<div class="wrap" style="padding-top:0"><textarea id="out" readonly></textarea></div>

<script>
(function(){
  var KEY = "ph-calib-" + ${JSON.stringify(run.runId)};
  var saveEl = document.getElementById("save");

  function collect(){
    var out = { runId: ${JSON.stringify(run.runId)}, savedAt: new Date().toISOString(), articles: {},
      overall: { model: val("overall-model"), verdict: val("overall-verdict"), note: val("overall-note") } };
    document.querySelectorAll(".verdicts").forEach(function(v){
      var id = v.getAttribute("data-article");
      var picked = v.querySelector('input[name="v'+id+'"]:checked');
      var model = v.querySelector('select[name="m'+id+'"]');
      var note = v.querySelector('input[name="n'+id+'"]');
      if (picked || (model && model.value) || (note && note.value)) {
        out.articles[id] = { verdict: picked ? picked.value : "", betterModel: model ? model.value : "", note: note ? note.value : "" };
      }
    });
    return out;
  }
  function val(id){ var e = document.getElementById(id); return e ? e.value : ""; }

  // Autosave must fail LOUDLY. A silent catch here would let a whole grading
  // pass evaporate with the page still looking healthy.
  function save(){
    try {
      localStorage.setItem(KEY, JSON.stringify(collect()));
      saveEl.className = "";
      saveEl.textContent = "saved " + new Date().toLocaleTimeString();
    } catch (e) {
      saveEl.className = "err";
      saveEl.textContent = "NOT SAVED — " + (e && e.message ? e.message : e) + " — copy your results before leaving";
      alert("Autosave failed: " + e + "\\n\\nUse Copy results before closing this tab.");
    }
  }

  function restore(){
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) {
      saveEl.className = "err"; saveEl.textContent = "storage unavailable — results will not persist"; return;
    }
    if (!raw) { saveEl.textContent = "no saved verdicts yet"; return; }
    var data;
    try { data = JSON.parse(raw); } catch (e) {
      saveEl.className = "err"; saveEl.textContent = "saved verdicts were unreadable and were NOT restored"; return;
    }
    Object.keys(data.articles || {}).forEach(function(id){
      var a = data.articles[id];
      if (a.verdict) { var r = document.querySelector('input[name="v'+id+'"][value="'+a.verdict+'"]'); if (r) r.checked = true; }
      var m = document.querySelector('select[name="m'+id+'"]'); if (m && a.betterModel) m.value = a.betterModel;
      var n = document.querySelector('input[name="n'+id+'"]'); if (n && a.note) n.value = a.note;
    });
    if (data.overall) {
      if (data.overall.model) document.getElementById("overall-model").value = data.overall.model;
      if (data.overall.verdict) document.getElementById("overall-verdict").value = data.overall.verdict;
      if (data.overall.note) document.getElementById("overall-note").value = data.overall.note;
    }
    saveEl.textContent = "restored from " + (data.savedAt || "an earlier session");
  }

  document.addEventListener("change", save);
  document.addEventListener("input", function(e){ if (e.target.classList.contains("note")) save(); });
  document.getElementById("copy").addEventListener("click", function(){
    var txt = JSON.stringify(collect(), null, 2);
    navigator.clipboard.writeText(txt).then(function(){
      var b = document.getElementById("copy"); b.textContent = "Copied"; setTimeout(function(){ b.textContent = "Copy results"; }, 1600);
    }, function(err){
      var o = document.getElementById("out"); o.style.display = "block"; o.value = txt; o.select();
      alert("Clipboard blocked (" + err + "). The JSON is shown below, selected — copy it manually.");
    });
  });
  document.getElementById("show").addEventListener("click", function(){
    var o = document.getElementById("out");
    o.style.display = o.style.display === "block" ? "none" : "block";
    o.value = JSON.stringify(collect(), null, 2);
  });
  restore();
})();
</script>
</body></html>`;
}

const runArg = process.argv[2];
if (!runArg) {
  console.error("usage: node scripts/build-calibration-review.mjs <run.json>");
  process.exit(1);
}
const runPath = resolve(REPO_ROOT, runArg);
const run = JSON.parse(readFileSync(runPath, "utf8"));
const outDir = resolve(REPO_ROOT, "calibration-review");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `${run.runId || basename(runPath, ".json")}.html`);
writeFileSync(outPath, build(runPath));
console.log(outPath);
