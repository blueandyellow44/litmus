// The head+tail body window handed to the scorer.

import { describe, expect, it } from "vitest";
import { ELISION, buildScoreWindow } from "./scoreWindow.js";

// Paragraphs of a known size, each identifiable by its own text.
function paras(count: number, chars = 100): string[] {
  return Array.from({ length: count }, (_, i) => `p${i}-` + "x".repeat(Math.max(0, chars - `p${i}-`.length)));
}

// Which [P#] indices the rendered body actually carries.
function indicesIn(body: string): number[] {
  return [...body.matchAll(/\[P(\d+)\]/g)].map((m) => Number(m[1]));
}

describe("buildScoreWindow", () => {
  it("returns a short article whole, with no elision", () => {
    const w = buildScoreWindow(paras(5), 6000);
    expect(w.complete).toBe(true);
    expect(w.body).not.toContain(ELISION);
    expect(indicesIn(w.body)).toEqual([0, 1, 2, 3, 4]);
  });

  it("tags every paragraph with its own index", () => {
    const w = buildScoreWindow(["alpha", "beta"], 6000);
    expect(w.body).toBe("[P0] alpha\n\n[P1] beta");
  });

  it("handles an empty article without throwing", () => {
    const w = buildScoreWindow([], 6000);
    expect(w.complete).toBe(true);
    expect(w.body).toBe("");
    expect(w.includedIndices).toEqual([]);
  });

  it("handles a single paragraph", () => {
    const w = buildScoreWindow(["only"], 6000);
    expect(w.complete).toBe(true);
    expect(indicesIn(w.body)).toEqual([0]);
  });

  describe("when the article does not fit", () => {
    // 200 paragraphs of 100 chars is ~20k, comfortably over the 6k budget.
    const long = paras(200);
    const w = buildScoreWindow(long, 6000);

    it("keeps the opening", () => {
      expect(indicesIn(w.body)[0]).toBe(0);
    });

    it("keeps the ending, which the head-only cut always lost", () => {
      // This is the whole point. The old rule was slice(0, 6000): the final
      // paragraph of a long read was never shown to the scorer, so a piece that
      // turned in its last third was judged on its first.
      expect(indicesIn(w.body).at(-1)).toBe(long.length - 1);
    });

    it("says so rather than joining head to tail silently", () => {
      expect(w.complete).toBe(false);
      expect(w.body).toContain(ELISION);
    });

    it("stays inside the budget", () => {
      expect(w.body.length).toBeLessThanOrEqual(6000);
    });

    it("preserves document order and never repeats a paragraph", () => {
      const idx = indicesIn(w.body);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      expect(new Set(idx).size).toBe(idx.length);
    });

    it("shows strictly more of the article than the old head-only cut did", () => {
      const oldWay = long.map((p, i) => `[P${i}] ${p}`).join("\n\n").slice(0, 6000);
      const oldIdx = indicesIn(oldWay);
      expect(indicesIn(w.body).at(-1)!).toBeGreaterThan(oldIdx.at(-1)!);
    });

    it("reports the indices it included", () => {
      expect(w.includedIndices).toEqual(indicesIn(w.body));
    });
  });

  it("does not claim an elision when head and tail happen to meet", () => {
    // Sized so the tail budget swallows everything the head did not take.
    // Joining with an omission marker there would assert a gap that is not real.
    for (let n = 2; n < 60; n++) {
      const w = buildScoreWindow(paras(n, 100), 1400);
      const idx = indicesIn(w.body);
      const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1);
      const covers = idx.length === n;
      if (contiguous && covers) {
        expect(w.body, `n=${n}`).not.toContain(ELISION);
      }
      if (w.body.includes(ELISION)) {
        expect(contiguous && covers, `n=${n} claimed an elision but showed everything`).toBe(false);
      }
    }
  });

  it("survives a first paragraph larger than the whole head budget", () => {
    const w = buildScoreWindow([("y".repeat(9000)), "tail"], 1000);
    expect(w.complete).toBe(false);
    expect(w.body.length).toBeLessThanOrEqual(1000);
    expect(w.body.startsWith("[P0]")).toBe(true);
  });

  it("degrades to a plain cut when the budget cannot even hold the marker", () => {
    const w = buildScoreWindow(paras(50), 10);
    expect(w.complete).toBe(false);
    expect(w.body.length).toBeLessThanOrEqual(10);
  });

  it("never exceeds the budget across a sweep of shapes", () => {
    for (const n of [2, 3, 7, 25, 100, 400]) {
      for (const size of [40, 120, 800, 5000]) {
        for (const budget of [300, 1200, 6000]) {
          const w = buildScoreWindow(paras(n, size), budget);
          expect(w.body.length, `n=${n} size=${size} budget=${budget}`).toBeLessThanOrEqual(budget);
        }
      }
    }
  });
});
