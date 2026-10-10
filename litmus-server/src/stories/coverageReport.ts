import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/client.js";
import type { Queryable, StoryRunUsageWrite } from "../db/repos/storiesRepo.js";

export interface CoverageMember {
  articleId: number;
  outletName: string;
  outletKey: string;
  kind: "full" | "headline_only" | "syndicated";
  role: "primary" | "secondary";
  reason: string;
}

export interface CoverageExclusion {
  articleId: number;
  outletName: string;
  outletKey: string;
  reason: string;
}

export interface CoverageStory {
  storyId: string;
  headline: string;
  members: CoverageMember[];
  excluded: CoverageExclusion[];
}

export interface CoverageReport {
  version: 1;
  runId: number;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  counts: Record<string, number>;
  sweepComplete: boolean;
  usage: Array<{
    stage: string;
    model: string;
    calls: number;
    succeededCalls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    wallMs: number;
    errors: string[];
  }>;
  stories: CoverageStory[];
  terminalArticles: Array<{ articleId: number; state: "flag" | "not_news"; reason: string }>;
  criticFindings: Array<{ storyId: string | null; action: string; reason: string }>;
  uncheckedOutlets: Array<{ outletName: string; reason: string }>;
}

export interface CoverageReportInput {
  runId: number;
  startedAt: Date;
  finishedAt: Date;
  counts: Record<string, number>;
  sweepComplete: boolean;
  usage: StoryRunUsageWrite[];
  stories: CoverageStory[];
  terminalArticles: CoverageReport["terminalArticles"];
  criticFindings: CoverageReport["criticFindings"];
  uncheckedOutlets: CoverageReport["uncheckedOutlets"];
}

function usageSummary(rows: readonly StoryRunUsageWrite[]): CoverageReport["usage"] {
  const grouped = new Map<string, CoverageReport["usage"][number]>();
  for (const row of rows) {
    const key = `${row.stage}\u0000${row.model}`;
    const current = grouped.get(key) ?? {
      stage: row.stage,
      model: row.model,
      calls: 0,
      succeededCalls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      wallMs: 0,
      errors: [],
    };
    current.calls += 1;
    if (row.status === "succeeded") current.succeededCalls += 1;
    else current.failedCalls += 1;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheCreationInputTokens += row.cacheCreationInputTokens;
    current.cacheReadInputTokens += row.cacheReadInputTokens;
    current.wallMs += row.wallMs;
    if (row.error) current.errors.push(row.error);
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((a, b) => a.stage.localeCompare(b.stage) || a.model.localeCompare(b.model));
}

export function buildCoverageReport(input: CoverageReportInput): CoverageReport {
  if (input.finishedAt < input.startedAt) throw new Error("coverage report finish precedes start");
  const stories = input.stories
    .map((story) => ({
      ...story,
      members: [...story.members].sort((a, b) => a.outletKey.localeCompare(b.outletKey) || a.articleId - b.articleId),
      excluded: [...story.excluded].sort((a, b) => a.outletKey.localeCompare(b.outletKey) || a.articleId - b.articleId),
    }))
    .sort((a, b) => a.storyId.localeCompare(b.storyId));
  return {
    version: 1,
    runId: input.runId,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    wallMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    counts: Object.fromEntries(Object.entries(input.counts).sort(([a], [b]) => a.localeCompare(b))),
    sweepComplete: input.sweepComplete,
    usage: usageSummary(input.usage),
    stories,
    terminalArticles: [...input.terminalArticles].sort((a, b) => a.articleId - b.articleId),
    criticFindings: [...input.criticFindings].sort((a, b) =>
      (a.storyId ?? "").localeCompare(b.storyId ?? "") || a.action.localeCompare(b.action)),
    uncheckedOutlets: [...input.uncheckedOutlets].sort((a, b) => a.outletName.localeCompare(b.outletName)),
  };
}

interface MemberRow {
  story_id: string;
  headline: string;
  article_id: number;
  outlet_name: string;
  outlet_key: string;
  kind: CoverageMember["kind"];
  role: CoverageMember["role"];
  reason: string;
}

interface ExclusionRow {
  story_id: string;
  article_id: number;
  outlet_name: string;
  outlet_key: string;
  reason: string;
}

const OUTLET_KEY = `COALESCE(
  src.outlet_key,
  NULLIF(btrim(lower(regexp_replace(split_part(src.name, ' — ', 1), '[^A-Za-z0-9]+', '-', 'g')), '-'), ''),
  'source-' || src.id::text
)`;

export async function loadCoverageReportInput(
  runId: number,
  startedAt: Date,
  finishedAt: Date,
  counts: Record<string, number>,
  sweepComplete: boolean,
  usage: StoryRunUsageWrite[],
  db: Queryable = pool,
): Promise<CoverageReportInput> {
  const [{ rows: members }, { rows: exclusions }, { rows: terminal }, { rows: critic }, { rows: disabled }] = await Promise.all([
    db.query<MemberRow>(
      `SELECT st.id AS story_id, st.headline, sm.article_id, src.name AS outlet_name,
              ${OUTLET_KEY} AS outlet_key, sm.kind, sm.role, sm.reason
       FROM stories st
       JOIN story_members sm ON sm.story_id = st.id
       JOIN articles a ON a.id = sm.article_id
       JOIN sources src ON src.id = a.source_id
       WHERE st.status <> 'merged'
       ORDER BY st.id, outlet_key, sm.article_id`,
    ),
    db.query<ExclusionRow>(
      `SELECT sc.story_id, sc.article_id, src.name AS outlet_name,
              ${OUTLET_KEY} AS outlet_key, sc.reason
       FROM story_sweep_checks sc
       JOIN articles a ON a.id = sc.article_id
       JOIN sources src ON src.id = a.source_id
       WHERE sc.run_id = $1 AND sc.outcome = 'excluded'
         AND NOT EXISTS (
           SELECT 1 FROM story_members sm WHERE sm.story_id = sc.story_id AND sm.article_id = sc.article_id
         )
       ORDER BY sc.story_id, outlet_key, sc.article_id`,
      [runId],
    ),
    db.query<{ article_id: number; state: "flag" | "not_news"; reason: string }>(
      `SELECT article_id, state, reason FROM story_article_states WHERE run_id = $1 ORDER BY article_id`,
      [runId],
    ),
    db.query<{ story_id: string | null; action: string; reason: string }>(
      `SELECT story_id, action, reason FROM story_events_log
       WHERE run_id = $1 AND (action LIKE '%_flag' OR action LIKE '%_error')
       ORDER BY id`,
      [runId],
    ),
    db.query<{ outlet_name: string }>("SELECT name AS outlet_name FROM sources WHERE enabled = FALSE ORDER BY name"),
  ]);
  const byStory = new Map<string, CoverageStory>();
  for (const row of members) {
    const story = byStory.get(row.story_id) ?? {
      storyId: row.story_id,
      headline: row.headline,
      members: [],
      excluded: [],
    };
    story.members.push({
      articleId: row.article_id,
      outletName: row.outlet_name,
      outletKey: row.outlet_key,
      kind: row.kind,
      role: row.role,
      reason: row.reason,
    });
    byStory.set(row.story_id, story);
  }
  for (const row of exclusions) {
    const story = byStory.get(row.story_id);
    if (!story) continue;
    story.excluded.push({
      articleId: row.article_id,
      outletName: row.outlet_name,
      outletKey: row.outlet_key,
      reason: row.reason,
    });
  }
  return {
    runId,
    startedAt,
    finishedAt,
    counts,
    sweepComplete,
    usage,
    stories: [...byStory.values()],
    terminalArticles: terminal.map((row) => ({ articleId: row.article_id, state: row.state, reason: row.reason })),
    criticFindings: critic.map((row) => ({ storyId: row.story_id, action: row.action, reason: row.reason })),
    uncheckedOutlets: disabled.map((row) => ({ outletName: row.outlet_name, reason: "Disabled in the source roster." })),
  };
}

export async function writeCoverageReport(report: CoverageReport, outputPath: string): Promise<void> {
  const target = path.resolve(outputPath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}
