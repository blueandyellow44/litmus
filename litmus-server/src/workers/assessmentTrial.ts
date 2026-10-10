// The Haiku 4.5 vs Sonnet 5 assessment trial (Max, 2026-09-26). Reads the
// most-covered stories of the last day, writes each one's assessment with
// both models from the same prompt and inputs, and saves NOTHING to the
// database. Output: blind-v2.md (A and B, no model names) and key-v2.json (which
// is which, tokens and dollars), plus the v2 evidence files: exact inputs,
// sources, prompt hash, outputs and usage (stories/assessmentTrial.ts).
// Stops before any call once spending reaches --max-dollars.
//
//   npm run assessment-trial -- --stories=10 --max-dollars=1 --out=trial-out

import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import path from "node:path";
import { listStoriesUpdatedSince, listStoryMembers } from "../db/repos/storiesRepo.js";
import { getArticleSummariesByIds } from "../db/repos/articlesRepo.js";
import { toMemberPayload } from "../stories/assessment.js";
import {
  blindLabels,
  runTrial,
  trialArtifacts,
  writeTrialArtifacts,
  type TrialSource,
  type TrialStoryInput,
} from "../stories/assessmentTrial.js";
import { resolveStoryLookbackDays } from "../stories/lookbackLimit.js";
import { logger } from "../lib/logger.js";
import { shutdown, crashAndShutdown } from "../lib/shutdown.js";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function gitCommit(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch (error) {
    logger.warn("assessment trial: git commit unknown", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function main(): Promise<void> {
  const storyCount = Number(arg("stories", "10"));
  const maxDollars = Number(arg("max-dollars", "1"));
  const outDir = path.resolve(arg("out", "trial-out"));
  if (!Number.isInteger(storyCount) || storyCount <= 0) throw new Error("--stories must be a positive integer");
  if (!Number.isFinite(maxDollars) || maxDollars <= 0) throw new Error("--max-dollars must be positive");

  const days = resolveStoryLookbackDays(process.env.STORY_LOOKBACK_DAYS);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const candidates = [];
  for (const story of await listStoriesUpdatedSince(since)) {
    const members = await listStoryMembers(story.id);
    const primaries = members.filter((m) => m.role === "primary").length;
    if (primaries >= 2) candidates.push({ story, members, primaries });
  }
  candidates.sort((a, b) => b.primaries - a.primaries || a.story.id.localeCompare(b.story.id));
  const chosen = candidates.slice(0, storyCount);
  logger.info("assessment trial: stories chosen", { days, eligible: candidates.length, chosen: chosen.length });

  const inputs: TrialStoryInput[] = [];
  for (const { story, members } of chosen) {
    const articles = await getArticleSummariesByIds(members.map((m) => m.articleId));
    const byId = new Map(articles.map((a) => [a.id, a]));
    const sources: TrialSource[] = members.map((m) => {
      const article = byId.get(m.articleId);
      return {
        articleId: m.articleId,
        role: m.role,
        outlet: article?.sourceName ?? `Article ${m.articleId}`,
        url: article?.url ?? null,
        title: article?.title ?? null,
        publishedAt: article?.publishedAt ?? null,
      };
    });
    inputs.push({ story, payload: members.map((m) => toMemberPayload(m, byId.get(m.articleId))), sources });
  }

  const run = await runTrial(inputs, { maxDollars });
  const labels = blindLabels(run.entries.map((e) => e.storyId), () => randomInt(2) === 0);
  const files = trialArtifacts(run, new Map(inputs.map((i) => [i.story.id, i.sources])), labels, {
    generatedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    selection: `stories updated in the last ${days} days with at least two primary members, most primaries first, top ${storyCount}`,
  });
  await writeTrialArtifacts(outDir, files);
  logger.info("assessment trial: done", {
    stories: run.entries.length,
    totalDollars: Number(run.spent.toFixed(4)),
    stoppedForBudget: run.stoppedForBudget,
    perModel: run.perModel,
    files: Object.keys(files),
  });
}

main()
  .then(() => shutdown())
  .catch((error) => crashAndShutdown("assessment trial", error));
