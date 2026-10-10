import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StoryModelClient } from "./assignment.js";
import type { StoryRecord } from "../db/repos/storiesRepo.js";
import { ASSESSMENT_SYSTEM } from "./prompts.js";
import {
  blindLabels,
  blindSheet,
  costOf,
  runTrial,
  sha256,
  termsNotInInput,
  trialArtifacts,
  writeTrialArtifacts,
  type TrialStoryInput,
} from "./assessmentTrial.js";

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });

const output = (text: string | null) => ({
  text, headline: null, eventStatement: null, paragraphs: null, openedWithOutlet: false, flagReason: null,
});

describe("assessment trial", () => {
  it("prices each model at its own list rate", () => {
    expect(costOf(usage(1_000_000, 0), "haiku")).toBe(1);
    expect(costOf(usage(0, 1_000_000), "sonnet")).toBe(10);
    expect(costOf(usage(3000, 500), "haiku")).toBeCloseTo(0.0055, 6);
  });

  it("assigns A and B per story from the coin", () => {
    const flips = [true, false];
    const labels = blindLabels(["s1", "s2"], () => flips.shift()!);
    expect(labels.get("s1")).toEqual({ A: "haiku", B: "sonnet" });
    expect(labels.get("s2")).toEqual({ A: "sonnet", B: "haiku" });
  });

  it("never names a model in the sheet Max reads", () => {
    const labels = blindLabels(["s1"], () => false);
    const sheet = blindSheet(
      [{ storyId: "s1", headline: "Event", outlets: ["NPR"], outputs: { haiku: output("First text."), sonnet: output("Second text.") } }],
      labels,
    );
    expect(sheet).not.toMatch(/haiku|sonnet|claude/i);
    // coin false: A is the second model's text, B the first's.
    expect(sheet.indexOf("Second text.")).toBeLessThan(sheet.indexOf("First text."));
  });

  it("shows a missing assessment as missing, not blank", () => {
    const sheet = blindSheet(
      [{ storyId: "s1", headline: "Event", outlets: [], outputs: { haiku: output(null), sonnet: output("Text.") } }],
      blindLabels(["s1"], () => true),
    );
    expect(sheet).toContain("_(no usable assessment)_");
  });

  it("offers tie and neither as explicit choices on every story", () => {
    const sheet = blindSheet(
      [
        { storyId: "s1", headline: "One", outlets: [], outputs: { haiku: output("a"), sonnet: output("b") } },
        { storyId: "s2", headline: "Two", outlets: [], outputs: { haiku: output("c"), sonnet: output("d") } },
      ],
      blindLabels(["s1", "s2"], () => true),
    );
    expect(sheet.match(/\[ \] A {2}\[ \] B {2}\[ \] Tie, both usable {2}\[ \] Neither/g)).toHaveLength(2);
  });

  it("lists capitalised words and figures an output has that its input does not", () => {
    const input = JSON.stringify({ members: [{ title: "Senate passes the budget", summary: "The vote was 51 to 49." }] });
    expect(termsNotInInput("The Senate passed the budget 51 to 49.", input)).toEqual([]);
    expect(termsNotInInput("Senator Collins said the Senate cut 8% on Friday.", input)).toEqual(["Senator", "Collins", "8%", "Friday"]);
  });
});

// Fixtures shaped like the 2026-09-26 trial's weak cases: a thin story whose
// material gives only a title, not a name, and a story about an outlet that is
// not itself a member.
function story(id: string, headline: string): StoryRecord {
  return {
    id, slug: id, section: "politics", headline, eventStatement: `${headline}.`, assessment: null, membershipHash: null, touchesPolitics: null,
    firstSeenAt: new Date("2026-09-26T10:00:00Z"), updatedAt: new Date("2026-09-26T11:00:00Z"),
    status: "open", mergedInto: null, anchorArticleId: 1,
  };
}

const FIXTURES: TrialStoryInput[] = [
  {
    story: story("st_thin", "State lieutenant governor resigns"),
    payload: [
      { outlet: "Outlet One", title: "Lieutenant governor resigns after ethics report", publishedAt: "2026-09-26T09:00:00Z", summary: null, excerptLead: null },
      { outlet: "Outlet Two", title: "Lieutenant governor steps down", publishedAt: "2026-09-26T09:30:00Z", summary: "The lieutenant governor resigned after an ethics report.", excerptLead: null },
    ],
    sources: [
      { articleId: 101, role: "primary", outlet: "Outlet One", url: "https://one.example/a", title: "Lieutenant governor resigns after ethics report", publishedAt: "2026-09-26T09:00:00Z" },
      { articleId: 102, role: "primary", outlet: "Outlet Two", url: "https://two.example/b", title: "Lieutenant governor steps down", publishedAt: "2026-09-26T09:30:00Z" },
    ],
  },
  {
    story: story("st_pool", "Council bars newspaper from meetings"),
    payload: [
      { outlet: "Outlet Three", title: "Council bars the Herald", publishedAt: null, summary: "The city council barred the Herald from its meetings on Tuesday.", excerptLead: null },
      { outlet: "Outlet Four", title: "Herald shut out", publishedAt: null, summary: "The Herald said it was barred from council meetings.", excerptLead: null },
    ],
    sources: [
      { articleId: 201, role: "primary", outlet: "Outlet Three", url: "https://three.example/c", title: "Council bars the Herald", publishedAt: null },
      { articleId: 202, role: "primary", outlet: "Outlet Four", url: null, title: "Herald shut out", publishedAt: null },
    ],
  },
];

// A scripted model: per (story, model), a list of responses for successive
// attempts. The pool story's first Haiku attempt opens "The Herald reported",
// which the attribution check must catch and retry.
function scriptedClient(): StoryModelClient & { seen: Array<{ model: string; content: string }> } {
  const counts = new Map<string, number>();
  const seen: Array<{ model: string; content: string }> = [];
  const scripts: Record<string, string[][]> = {
    "st_thin|claude-haiku-4-5": [["The lieutenant governor resigned after an ethics report.", "Outlet Two reported the resignation the same morning."]],
    "st_thin|claude-sonnet-5": [["Lieutenant Governor Jane Roe resigned on Friday after an ethics report.", "The resignation marks a significant development."]],
    "st_pool|claude-haiku-4-5": [
      ["The Herald reported that the city council barred it from meetings.", "The council acted on Tuesday."],
      ["The city council barred the Herald from its meetings on Tuesday.", "The Herald said it was barred."],
    ],
    "st_pool|claude-sonnet-5": [["The city council barred the Herald from its meetings on Tuesday.", "The Herald said it was barred."]],
  };
  return {
    seen,
    messages: {
      create: async (params: Record<string, unknown>) => {
        const messages = params.messages as Array<{ content: string }>;
        const content = messages[0]!.content;
        const storyId = content.includes("lieutenant") || content.includes("Lieutenant") ? "st_thin" : "st_pool";
        const key = `${storyId}|${params.model as string}`;
        const n = counts.get(key) ?? 0;
        counts.set(key, n + 1);
        seen.push({ model: params.model as string, content });
        const paragraphs = scripts[key]![Math.min(n, scripts[key]!.length - 1)]!;
        return {
          stop_reason: "tool_use",
          usage: { input_tokens: 1000, output_tokens: 200 },
          content: [{ type: "tool_use", name: "submit_story_assessment", input: { headline: "h", event_statement: "e", paragraphs, touches_politics: true } }],
        };
      },
    },
  } as unknown as StoryModelClient & { seen: Array<{ model: string; content: string }> };
}

describe("assessment trial run (fixtures, fake model)", () => {
  it("archives the exact requests, sources, prompt, outputs and usage, and flags unsupported terms", async () => {
    const client = scriptedClient();
    const run = await runTrial(FIXTURES, { client, maxDollars: 1 });
    expect(run.entries).toHaveLength(2);
    expect(run.stoppedForBudget).toBe(false);

    // Both models got byte-identical first-attempt input for each story.
    for (const id of ["st_thin", "st_pool"]) {
      const firsts = run.requests.filter((r) => r.storyId === id && r.messages[0].content.startsWith("{"));
      expect(new Set(firsts.map((r) => r.messages[0].content)).size).toBe(1);
      expect(new Set(firsts.map((r) => r.model))).toEqual(new Set(["claude-haiku-4-5", "claude-sonnet-5"]));
    }
    // The attribution opening was retried, and the retry request is archived.
    const poolHaiku = run.requests.filter((r) => r.storyId === "st_pool" && r.trialModel === "haiku");
    expect(poolHaiku).toHaveLength(2);
    expect(poolHaiku[1]!.messages[0].content).toMatch(/^Correction: .*who reported/);
    expect(run.entries[1]!.outputs.haiku?.text).toMatch(/^The city council barred the Herald/);

    const labels = blindLabels(run.entries.map((e) => e.storyId), () => true);
    const files = trialArtifacts(run, new Map(FIXTURES.map((f) => [f.story.id, f.sources])), labels, {
      generatedAt: "2026-09-26T12:00:00Z", gitCommit: "abc123", selection: "fixtures",
    });
    expect(Object.keys(files).sort()).toEqual(["blind-v2.md", "inputs-v2.json", "key-v2.json", "manifest-v2.json", "outputs-v2.json", "usage-v2.jsonl"]);

    const manifest = JSON.parse(files["manifest-v2.json"]!);
    expect(manifest.promptSha256).toBe(sha256(ASSESSMENT_SYSTEM));
    expect(manifest.prompt).toBe(ASSESSMENT_SYSTEM);
    expect(manifest.gitCommit).toBe("abc123");

    const inputs = JSON.parse(files["inputs-v2.json"]!);
    expect(inputs[0].sources.map((s: { articleId: number; url: string | null }) => [s.articleId, s.url])).toEqual([[101, "https://one.example/a"], [102, "https://two.example/b"]]);
    expect(inputs[0].requests[0].system).toBe(ASSESSMENT_SYSTEM);

    const usageLines = files["usage-v2.jsonl"]!.trim().split("\n").map((l) => JSON.parse(l));
    expect(usageLines).toHaveLength(5); // 2 stories x 2 models + 1 retry
    expect(usageLines.every((u) => typeof u.dollars === "number" && u.status === "succeeded")).toBe(true);

    // The invented name and weekday surface in the sheet. (A content-free
    // significance sentence is lowercase and does not; that is the prompt's job.)
    const sheet = files["blind-v2.md"]!;
    expect(sheet).toContain("not in the saved inputs: Jane, Roe, Friday");
    expect(sheet).not.toMatch(/haiku|sonnet|claude/i);
  });

  it("stops before any call past the budget and drops a half-written pair", async () => {
    const run = await runTrial(FIXTURES, { client: scriptedClient(), maxDollars: 0.001 });
    expect(run.stoppedForBudget).toBe(true);
    expect(run.entries).toHaveLength(0);
    expect(run.usage).toHaveLength(1);
  });

  it("refuses to overwrite an earlier trial's files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "trial-"));
    await writeFile(path.join(dir, "blind-v2.md"), "earlier trial");
    await expect(writeTrialArtifacts(dir, { "blind-v2.md": "new" })).rejects.toThrow(/EEXIST/);
    expect(await readFile(path.join(dir, "blind-v2.md"), "utf8")).toBe("earlier trial");
    await writeTrialArtifacts(dir, { "key-v2.json": "{}" });
    expect((await readdir(dir)).sort()).toEqual(["blind-v2.md", "key-v2.json"]);
  });
});
