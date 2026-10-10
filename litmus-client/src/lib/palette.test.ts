// The Quiet Reader neutrals: legible where text sits, and identical in the three
// files that each hold a copy (palette.ts, tailwind.config.js, tokens.css).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AA_NON_TEXT, AA_NORMAL_TEXT, contrastRatio } from "./contrast.ts";
import { PALETTE, TEXT_GROUNDS, TEXT_TOKENS, type PaletteToken } from "./palette.ts";
import { PH_BANDS } from "./phBand.ts";

// Read from disk, not imported: a `?raw` import of a stylesheet comes back empty
// under Vitest, which stubs CSS. These two files are the other copies of the
// palette, and a copy is only safe if something notices when one of them moves.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const TAILWIND = read("../../tailwind.config.js");
const TOKENS_CSS = read("../styles/tokens.css");

// palette.ts key -> the name used in tailwind.config.js and as a CSS variable.
const EXTERNAL_NAME: Record<PaletteToken, string> = {
  ground: "ground",
  surface: "surface",
  ink: "ink",
  ink2: "ink2",
  ink3: "ink3",
  rule: "rule",
  grid: "grid",
  ruleStrong: "rule-strong",
  tint: "tint",
  hotLine: "hot-line",
  coolLine: "cool-line",
};

function tailwindHex(name: string): string | undefined {
  const escaped = name.replace(/-/g, "\\-");
  const m = new RegExp(`^\\s*"?${escaped}"?\\s*:\\s*"(#[0-9a-fA-F]{6})"`, "m").exec(TAILWIND);
  return m?.[1]?.toLowerCase();
}

function cssVarHex(name: string): string | undefined {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(TOKENS_CSS);
  return m?.[1]?.toLowerCase();
}

describe("the palette copies agree", () => {
  it.each(Object.entries(EXTERNAL_NAME) as [PaletteToken, string][])("%s matches in tailwind.config.js and tokens.css", (key, name) => {
    const hex = PALETTE[key].toLowerCase();
    expect(tailwindHex(name), `tailwind ${name}`).toBe(hex);
    expect(cssVarHex(name), `--${name}`).toBe(hex);
  });

  it("carries the ramp into tokens.css unchanged", () => {
    const CSS_NAME = ["practical", "grounded", "mixed", "hot", "hysterical"];
    PH_BANDS.forEach((b, i) => {
      expect(cssVarHex(`ph-${CSS_NAME[i]}`), b.label).toBe(b.hex.toLowerCase());
    });
  });

  it("retires the broadsheet palette from both style files", () => {
    for (const retired of ["#f4efe4", "#14120f", "#6b655c", "#cfc8b9", "#8f8a7d", "Times New Roman\", Georgia", "halftone"]) {
      expect(TOKENS_CSS.toLowerCase(), retired).not.toContain(retired.toLowerCase());
    }
    for (const retired of ["paper:", "muted:", "rule-dark"]) {
      expect(TAILWIND, retired).not.toContain(retired);
    }
  });

  it("names the tokens' loud mistake: the highlight classes exist where highlight.ts expects them", () => {
    expect(TOKENS_CSS).toMatch(/\.hl-loaded\s*\{/);
    expect(TOKENS_CSS).toMatch(/\.hl-grounded\s*\{/);
  });
});

describe("text contrast", () => {
  // Computed from the hexes, rounded to two places.
  const MEASURED: Record<string, number> = {
    "ink on ground": 14.46,
    "ink on surface": 15.66,
    "ink on tint": 12.97,
    "ink2 on ground": 8.26,
    "ink2 on surface": 8.95,
    "ink2 on tint": 7.41,
    "ink3 on ground": 5.17,
    "ink3 on surface": 5.6,
    "ink3 on tint": 4.64,
  };

  const pairs = TEXT_TOKENS.flatMap((t) => TEXT_GROUNDS.map((g) => [t, g] as const));
  it.each(pairs)("%s on %s clears AA for normal text", (token, ground) => {
    const ratio = contrastRatio(PALETTE[token], PALETTE[ground]);
    expect(ratio).toBeCloseTo(MEASURED[`${token} on ${ground}`]!, 2);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe("non-text contrast", () => {
  it("gives a control boundary 3:1 on both grounds", () => {
    expect(contrastRatio(PALETTE.ruleStrong, PALETTE.ground)).toBeCloseTo(3.28, 2);
    expect(contrastRatio(PALETTE.ruleStrong, PALETTE.surface)).toBeCloseTo(3.55, 2);
    expect(contrastRatio(PALETTE.ruleStrong, PALETTE.ground)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it("proves the design's dashed grey would not have been enough for a control", () => {
    expect(contrastRatio("#8C8D91", PALETTE.ground)).toBeLessThan(AA_NON_TEXT);
  });

  it("keeps both highlight underlines visible where they are drawn", () => {
    // The loaded underline sits on the tint; the grounded one on the ground.
    expect(contrastRatio(PALETTE.hotLine, PALETTE.tint)).toBeCloseTo(4.04, 2);
    expect(contrastRatio(PALETTE.coolLine, PALETTE.ground)).toBeCloseTo(3.43, 2);
    expect(contrastRatio(PALETTE.hotLine, PALETTE.tint)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(contrastRatio(PALETTE.coolLine, PALETTE.ground)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});
