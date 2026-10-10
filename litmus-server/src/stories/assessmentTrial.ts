// Haiku 4.5 vs Sonnet 5 for the story assessment only (Max, 2026-09-26).
// Grouping stays on Haiku; this compares the prose a reader sees first. The
// pure pieces live here so they can be tested without a database or a model.
//
// v2 artifacts (2026-09-26 audit follow-through): the first trial saved only
// the blind sheet and the key, so no output could be checked against what the
// model was given. v2 also archives the exact requests, the source articles,
// the prompt and its hash, every usage record and the full outputs, and it
// never overwrites a file already in the output folder.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelUsage, StoryModelClient } from "./assignment.js";
import { assessStory, type AssessmentMemberPayload, type AssessmentRequest } from "./assessment.js";
import { ASSESSMENT_SYSTEM } from "./prompts.js";
import type { StoryRecord } from "../db/repos/storiesRepo.js";

export const TRIAL_MODELS = { haiku: "claude-haiku-4-5", sonnet: "claude-sonnet-5" } as const;
export type TrialModel = keyof typeof TRIAL_MODELS;

export const TRIAL_ARTIFACT_VERSION = "v2";

// US dollars per million tokens, list price. Cache fields are priced like
// input: the assessment sets no cache, so they stay zero in practice.
const PRICE_PER_MTOK: Record<TrialModel, { input: number; output: number }> = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 2, output: 10 },
};

export function costOf(usage: ModelUsage, model: TrialModel): number {
  const price = PRICE_PER_MTOK[model];
  const input = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  return (input * price.input + usage.outputTokens * price.output) / 1_000_000;
}

// Which model is "A" for each story, from a caller-supplied coin so the order
// is unpredictable in the sheet Max reads and reproducible in a test.
export function blindLabels(storyIds: readonly string[], coin: () => boolean): Map<string, { A: TrialModel; B: TrialModel }> {
  return new Map(storyIds.map((id) => [id, coin() ? { A: "haiku", B: "sonnet" } : { A: "sonnet", B: "haiku" }]));
}

// One source article behind a story, recorded for provenance only; none of
// these fields reach the model beyond what the member payload already carries.
export interface TrialSource {
  articleId: number;
  role: string;
  outlet: string;
  url: string | null;
  title: string | null;
  publishedAt: string | null;
}

export interface TrialStoryInput {
  story: StoryRecord;
  payload: AssessmentMemberPayload[];
  sources: TrialSource[];
}

export interface TrialOutput {
  text: string | null;
  headline: string | null;
  eventStatement: string | null;
  paragraphs: string[] | null;
  openedWithOutlet: boolean;
  flagReason: string | null;
}

export interface TrialEntry {
  storyId: string;
  headline: string;
  outlets: string[];
  outputs: Partial<Record<TrialModel, TrialOutput>>;
  // The exact user message of the first attempt: the text a grounding check
  // compares against. Identical for both models by construction.
  inputText?: string;
}

export interface TrialRequestRecord extends AssessmentRequest {
  storyId: string;
  callIndex: number;
  trialModel: TrialModel;
}

export interface TrialUsageRecord extends ModelUsage {
  storyId: string;
  trialModel: TrialModel;
  model: string;
  callIndex: number;
  status: "succeeded" | "failed";
  error: string | null;
  wallMs: number;
  dollars: number;
}

// A lexical aid for the reviewer, not a fact check: capitalised words and
// figures in an output that never appear in the saved input. A term that IS
// found can still be misused; a term NOT found is a candidate unsupported
// addition to confirm by reading the input.
const CHECKED_TERM = /\$?\d[\d,.]*%?|\b[A-Z][A-Za-z'’-]+\b/g;

export function termsNotInInput(output: string, input: string): string[] {
  const haystack = input.toLowerCase();
  const missing = new Set<string>();
  for (const match of output.matchAll(CHECKED_TERM)) {
    const term = match[0].replace(/[.,]+$/, "");
    if (term === "") continue;
    if (!haystack.includes(term.toLowerCase())) missing.add(term);
  }
  return [...missing];
}

const PICK_LINE = "**Pick one:** [ ] A  [ ] B  [ ] Tie, both usable  [ ] Neither";

// The sheet Max reads: no model names anywhere in it.
export function blindSheet(
  entries: readonly TrialEntry[],
  labels: ReadonlyMap<string, { A: TrialModel; B: TrialModel }>,
  version: string = TRIAL_ARTIFACT_VERSION,
): string {
  const lines = [
    `# Story assessment trial (${version}): A, B, tie, or neither?`,
    "",
    "Same prompt, same inputs, two models. For each story, tick one choice and say why. Tie means both are usable; Neither means neither should ship as written. The key is in a separate file.",
    "",
    "The mechanical check under each text lists capitalised words and figures that do not appear in the saved inputs (inputs file, same folder). It is lexical only: a listed term is a candidate unsupported addition to confirm against the inputs; an unlisted term can still be misused.",
    "",
  ];
  entries.forEach((entry, index) => {
    const label = labels.get(entry.storyId)!;
    lines.push(`## ${index + 1}. ${entry.headline}`, "", `Outlets: ${entry.outlets.join(", ")}`, "");
    for (const side of ["A", "B"] as const) {
      const output = entry.outputs[label[side]];
      const text = output?.text ?? null;
      lines.push(`### ${side}`, "", text ?? "_(no usable assessment)_", "");
      if (text !== null && entry.inputText !== undefined) {
        const missing = termsNotInInput(text, entry.inputText);
        lines.push(
          missing.length === 0
            ? "_Mechanical check: every capitalised word and figure appears in the saved inputs._"
            : `_Mechanical check, not in the saved inputs: ${missing.join(", ")}_`,
          "",
        );
      }
      if (output?.openedWithOutlet) lines.push("_Opening check: still led with an outlet or a reporter after one retry._", "");
    }
    lines.push(PICK_LINE, "", "Why:", "", "Unsupported additions you spotted (A or B, quote the words):", "", "---", "");
  });
  return lines.join("\n");
}

export interface RunTrialOptions {
  client?: StoryModelClient;
  maxDollars: number;
}

export interface TrialRun {
  entries: TrialEntry[];
  requests: TrialRequestRecord[];
  usage: TrialUsageRecord[];
  perModel: Record<TrialModel, { calls: number; inputTokens: number; outputTokens: number; dollars: number }>;
  spent: number;
  stoppedForBudget: boolean;
}

// Every story written by both models from the same payload. Stops before any
// call once spending reaches maxDollars; a story cut off mid-pair is dropped
// so the sheet never shows one side only.
export async function runTrial(stories: readonly TrialStoryInput[], options: RunTrialOptions): Promise<TrialRun> {
  const run: TrialRun = {
    entries: [],
    requests: [],
    usage: [],
    perModel: {
      haiku: { calls: 0, inputTokens: 0, outputTokens: 0, dollars: 0 },
      sonnet: { calls: 0, inputTokens: 0, outputTokens: 0, dollars: 0 },
    },
    spent: 0,
    stoppedForBudget: false,
  };
  outer: for (const { story, payload } of stories) {
    const entry: TrialEntry = {
      storyId: story.id,
      headline: story.headline,
      outlets: [...new Set(payload.map((p) => p.outlet))],
      outputs: {},
    };
    for (const which of ["haiku", "sonnet"] as const) {
      if (run.spent >= options.maxDollars) {
        run.stoppedForBudget = true;
        break outer;
      }
      const result = await assessStory(story, payload, {
        client: options.client,
        model: TRIAL_MODELS[which],
        onRequest: (request) => {
          run.requests.push({ ...request, trialModel: which });
          if (entry.inputText === undefined) entry.inputText = request.messages[0].content;
        },
        onUsage: (usage) => {
          const dollars = costOf(usage, which);
          run.spent += dollars;
          run.perModel[which].calls += 1;
          run.perModel[which].inputTokens += usage.inputTokens;
          run.perModel[which].outputTokens += usage.outputTokens;
          run.perModel[which].dollars += dollars;
          run.usage.push({ ...usage, trialModel: which, dollars });
        },
      });
      entry.outputs[which] = {
        text: result.assessment?.text ?? null,
        headline: result.assessment?.headline ?? null,
        eventStatement: result.assessment?.eventStatement ?? null,
        paragraphs: result.assessment?.paragraphs ?? null,
        openedWithOutlet: result.openedWithOutlet,
        flagReason: result.flagReason,
      };
    }
    run.entries.push(entry);
  }
  return run;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface TrialMeta {
  generatedAt: string;
  gitCommit: string | null;
  selection: string;
}

// Every file a v2 trial writes, by name. The blind sheet is the only one Max
// reads first; the rest are the evidence behind it.
export function trialArtifacts(
  run: TrialRun,
  sources: ReadonlyMap<string, readonly TrialSource[]>,
  labels: ReadonlyMap<string, { A: TrialModel; B: TrialModel }>,
  meta: TrialMeta,
): Record<string, string> {
  const v = TRIAL_ARTIFACT_VERSION;
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    [`blind-${v}.md`]: blindSheet(run.entries, labels, v),
    [`key-${v}.json`]: json({
      artifactVersion: v,
      models: TRIAL_MODELS,
      labels: Object.fromEntries(labels),
      perModel: run.perModel,
      totalDollars: run.spent,
      stoppedForBudget: run.stoppedForBudget,
      stories: run.entries.map((e) => ({ storyId: e.storyId, headline: e.headline })),
    }),
    [`manifest-${v}.json`]: json({
      artifactVersion: v,
      generatedAt: meta.generatedAt,
      gitCommit: meta.gitCommit,
      selection: meta.selection,
      models: TRIAL_MODELS,
      pricePerMTok: PRICE_PER_MTOK,
      promptSha256: sha256(ASSESSMENT_SYSTEM),
      prompt: ASSESSMENT_SYSTEM,
      files: [`blind-${v}.md`, `key-${v}.json`, `inputs-${v}.json`, `outputs-${v}.json`, `usage-${v}.jsonl`],
    }),
    [`inputs-${v}.json`]: json(run.entries.map((e) => ({
      storyId: e.storyId,
      sources: sources.get(e.storyId) ?? [],
      // Every attempt, retries included, exactly as sent.
      requests: run.requests.filter((r) => r.storyId === e.storyId),
    }))),
    [`outputs-${v}.json`]: json(run.entries.map((e) => ({ storyId: e.storyId, headline: e.headline, outputs: e.outputs }))),
    [`usage-${v}.jsonl`]: run.usage.map((u) => JSON.stringify(u)).join("\n") + (run.usage.length ? "\n" : ""),
  };
}

// "wx": a trial never overwrites an earlier trial's files. A clash fails the
// write loudly instead of replacing evidence.
export async function writeTrialArtifacts(outDir: string, files: Record<string, string>): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(outDir, name), body, { flag: "wx" });
  }
}
