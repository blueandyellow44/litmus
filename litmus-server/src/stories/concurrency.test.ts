import { describe, expect, it } from "vitest";
import { mapLimit } from "./concurrency.js";
import { FatalModelError } from "./modelErrors.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapLimit (critic reviews)", () => {
  // Codex review of a9d3a56 (2026-09-26): the critic's reviews record usage
  // as they finish; the run is closed as aborted as soon as mapLimit rejects.
  it("hands out no new item after a fatal error and settles in-flight items before rejecting", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    let finishedAtReject = -1;
    const run = mapLimit(Array.from({ length: 20 }, (_, index) => index), 5, async (item) => {
      started.push(item);
      if (item === 0) {
        await sleep(5);
        throw new FatalModelError("account usage limit reached", new Error("usage limit"));
      }
      await sleep(40);
      finished.push(item);
      return item;
    }).catch((error: unknown) => {
      finishedAtReject = finished.length;
      throw error;
    });
    await expect(run).rejects.toThrow(FatalModelError);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(finishedAtReject).toBe(4);
    await sleep(60);
    expect(started).toHaveLength(5);
  });

  it("returns results in input order when nothing fails", async () => {
    const results = await mapLimit([3, 1, 2], 2, async (item) => {
      await sleep(item);
      return item * 10;
    });
    expect(results).toEqual([30, 10, 20]);
  });
});
