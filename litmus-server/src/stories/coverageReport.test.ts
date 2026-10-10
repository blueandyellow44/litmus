import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCoverageReport, writeCoverageReport } from "./coverageReport.js";

describe("coverage report", () => {
  it("is deterministic, sums per-call usage, and contains no article text", () => {
    const report = buildCoverageReport({
      runId: 7,
      startedAt: new Date("2026-09-13T12:00:00Z"),
      finishedAt: new Date("2026-09-13T12:00:02Z"),
      counts: { new: 1, offered: 1 },
      sweepComplete: true,
      usage: [
        { runId: 7, stage: "assignment", callIndex: 2, model: "sonnet", status: "succeeded", error: null, inputTokens: 2, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 1, wallMs: 20 },
        { runId: 7, stage: "assignment", callIndex: 1, model: "sonnet", status: "succeeded", error: null, inputTokens: 3, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 0, wallMs: 10 },
      ],
      stories: [{
        storyId: "st_b",
        headline: "Event",
        members: [{ articleId: 1, outletName: "B", outletKey: "b", kind: "headline_only", role: "primary", reason: "New." }],
        excluded: [{ articleId: 2, outletName: "A", outletKey: "a", reason: "Different event." }],
      }],
      terminalArticles: [],
      criticFindings: [],
      uncheckedOutlets: [{ outletName: "Disabled", reason: "Disabled in the source roster." }],
    });
    expect(report.usage).toEqual([expect.objectContaining({ calls: 2, succeededCalls: 2, failedCalls: 0, inputTokens: 5, outputTokens: 2, wallMs: 30 })]);
    expect(report.wallMs).toBe(2000);
    const serialised = JSON.stringify(report);
    expect(serialised).not.toMatch(/rawText|raw_text|anthropic_api_key/i);
  });

  it("writes valid JSON atomically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "litmus-coverage-"));
    try {
      const output = path.join(dir, "nested", "coverage-report.json");
      const report = buildCoverageReport({
        runId: 1,
        startedAt: new Date("2026-09-13T12:00:00Z"),
        finishedAt: new Date("2026-09-13T12:00:00Z"),
        counts: { offered: 0 },
        sweepComplete: true,
        usage: [],
        stories: [],
        terminalArticles: [],
        criticFindings: [],
        uncheckedOutlets: [],
      });
      await writeCoverageReport(report, output);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(report);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
