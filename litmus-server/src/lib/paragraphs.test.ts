import { describe, expect, it } from "vitest";
import type { PHMarker } from "../scoring/calibration.js";
import {
  buildExcerptWindow,
  capExcerpt,
  excerptWordCap,
  splitParagraphs,
  wordWindow,
  EXCERPT_MAX_WORDS,
} from "./paragraphs.js";

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const shownWords = (ps: string[]) => ps.reduce((n, p) => n + words(p.replaceAll("…", "")), 0);
const marker = (text: string): PHMarker => ({ text, category: "grounded", intensity: 3 }) as PHMarker;

// A paragraph of `n` sentences, each `per` words long, uniquely tagged.
function para(tag: string, n: number, per = 10): string {
  return Array.from({ length: n }, (_, i) => {
    const body = Array.from({ length: per - 1 }, (_, j) => `${tag}${i}w${j}`).join(" ");
    return `Sentence ${body}.`;
  }).join(" ");
}

describe("excerptWordCap", () => {
  it("caps long articles at the word maximum", () => {
    expect(excerptWordCap(5000)).toBe(EXCERPT_MAX_WORDS);
  });
  it("caps short articles at a quarter of their length", () => {
    expect(excerptWordCap(400)).toBe(100);
  });
  it("never goes negative", () => {
    expect(excerptWordCap(0)).toBe(0);
  });
});

describe("buildExcerptWindow display cap", () => {
  // 960 words, so the 200-word cap binds rather than the 25% share (240).
  const longArticle = ["a", "b", "c", "d", "e", "f", "g", "h"].map((t) => para(t, 12)).join("\n\n");

  it("never shows more than 200 words of a long article", () => {
    const w = buildExcerptWindow(longArticle, [0], [])!;
    expect(shownWords(w.paragraphs)).toBeLessThanOrEqual(200);
    expect(shownWords(w.paragraphs)).toBeGreaterThan(150);
  });

  it("never shows more than a quarter of a short article", () => {
    const short = [para("s", 12), para("t", 12)].join("\n\n"); // 240 words -> cap 60
    const w = buildExcerptWindow(short, [0], [])!;
    expect(shownWords(w.paragraphs)).toBeLessThanOrEqual(60);
  });

  it("keeps the stretch with the most highlights", () => {
    const text = longArticle;
    const late = ["c5w1", "c6w2", "c7w3", "c8w4"].map(marker);
    const w = buildExcerptWindow(text, [0], late)!;
    expect(w.markers.map((m) => m.text).sort()).toEqual(late.map((m) => m.text).sort());
  });

  it("shows only verbatim text from the article, with ellipses at mid-paragraph cuts", () => {
    const originals = splitParagraphs(longArticle);
    const w = buildExcerptWindow(longArticle, [0], [marker("b6w1")])!;
    for (const p of w.paragraphs) {
      const bare = p.replace(/^…/, "").replace(/…$/, "");
      expect(originals.some((o) => o.includes(bare))).toBe(true);
    }
    expect(w.paragraphs.join(" ")).toContain("…");
  });

  it("opens on the start of a paragraph, not mid-paragraph, when one fits", () => {
    // Highlights sit in the back half of paragraph c; the window still starts at c's opening.
    const w = buildExcerptWindow(longArticle, [0], ["c8w1", "c9w2", "c10w3"].map(marker))!;
    expect(w.paragraphs[0]!.startsWith("…")).toBe(false);
    expect(w.markers.length).toBeGreaterThan(0);
  });

  it("does not split or rewrite abbreviations like U.S.", () => {
    const text = `${"Lead words here that pad the start of the article. ".repeat(30)}The U.S. Senate voted. ${"Tail words that pad the end of the article here. ".repeat(30)}`;
    const w = buildExcerptWindow(text, [0], [marker("The U.S. Senate voted.")])!;
    expect(w.paragraphs.join(" ")).toContain("The U.S. Senate voted.");
    expect(w.markers).toHaveLength(1);
  });

  it("truncates a single sentence longer than the cap", () => {
    const giant = `${Array.from({ length: 900 }, (_, i) => `w${i}`).join(" ")}.`;
    const w = buildExcerptWindow(giant, [0], [])!;
    expect(w.paragraphs).toHaveLength(1);
    expect(shownWords(w.paragraphs)).toBeLessThanOrEqual(200);
    expect(w.paragraphs[0]!.endsWith("…")).toBe(true);
  });

  it("leaves an excerpt already under the cap untouched", () => {
    const small = ["one two three four.", "five six seven eight."];
    expect(capExcerpt(small, [], 200)).toEqual(small);
  });
});

describe("wordWindow (the marking window scoring depends on)", () => {
  it("still selects a 250-500 word passage, unchanged by the display cap", () => {
    const paragraphs = splitParagraphs([para("a", 12), para("b", 12), para("c", 12), para("d", 12)].join("\n\n"));
    const idx = wordWindow(paragraphs, [0], []);
    const n = idx.reduce((sum, i) => sum + words(paragraphs[i]!), 0);
    expect(n).toBeGreaterThanOrEqual(250);
    expect(n).toBeLessThanOrEqual(500);
  });
});
