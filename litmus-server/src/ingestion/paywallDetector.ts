import type { Source, ExtractionStatus } from "../types.js";

export interface PaywallVerdict {
  status: ExtractionStatus;
  paywallFlag: boolean;
}

// Decide whether an extracted article is `full`, `partial`, or `failed`.
//
// Rules (from the build prompt):
//   - Word count < 200 AND source paywalls           → partial + paywall flag
//   - Word count < 200 AND source is free            → partial, no paywall flag
//                                                       (probably a wire snippet or short bulletin)
//   - Word count == 0                                → failed
//   - Otherwise                                      → full
//
// 200 words is the threshold for "we have meaningful text to score".
// 300 words is the separate threshold for "we can also generate a translation"
// — that lives in the scoring/translation pipelines, not here.
export function detectPaywall(wordCount: number, source: Source): PaywallVerdict {
  if (wordCount === 0) {
    return { status: "failed", paywallFlag: source.paywallStatus !== "free" };
  }
  if (wordCount < 200) {
    return {
      status: "partial",
      paywallFlag: source.paywallStatus === "metered" || source.paywallStatus === "hard",
    };
  }
  return { status: "full", paywallFlag: false };
}
