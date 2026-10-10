// WCAG 2.1 relative luminance and contrast ratio, plus alpha compositing.
//
// Pure and dependency-free so the palette tests (palette.test.ts, phBand.test.ts)
// compute every ratio they assert rather than copying numbers out of a design
// document. A ratio in a comment can go stale; a ratio computed in a test cannot.

function channel(hex: string, offset: number): number {
  return parseInt(hex.slice(offset, offset + 2), 16);
}

export function isHex6(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

export function relativeLuminance(hex: string): number {
  if (!isHex6(hex)) throw new Error(`relativeLuminance expects #rrggbb, got ${hex}`);
  const [r, g, b] = [1, 3, 5]
    .map((i) => channel(hex, i) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// The opaque colour a translucent #rrggbb at `alpha` produces over `ground`.
// Needed because the ramp marks carry a translucent ink stroke, and a contrast
// ratio is only defined between two opaque colours.
export function composite(hex: string, alpha: number, ground: string): string {
  if (!isHex6(hex) || !isHex6(ground)) throw new Error(`composite expects #rrggbb, got ${hex} over ${ground}`);
  const a = Math.max(0, Math.min(1, alpha));
  const mix = [1, 3, 5].map((i) => Math.round(channel(hex, i) * a + channel(ground, i) * (1 - a)));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// WCAG thresholds, named so a test reads as the rule it enforces.
export const AA_NORMAL_TEXT = 4.5;
export const AA_NON_TEXT = 3;
