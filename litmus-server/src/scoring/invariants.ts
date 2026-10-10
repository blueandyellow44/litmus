// The rules the calibration prompt states, enforced where they can actually
// bind: in code, over the values the model returned.
//
// The prompt already carried two "BINDING RULE" paragraphs and neither bound
// anything. A model could return one_sided_sourcing=false beside a sourcing
// score of 3.0 — "no side was suppressed" and "a side was suppressed" in the
// same object — and the composite was computed from it and published. The
// reader was then shown a term-by-term breakdown of an incoherent judgement.
//
// The design rule here: an entry that CONTRADICTS ITSELF is rejected, never
// repaired. Repairing means choosing which half of the contradiction to believe,
// and there is no evidence for that choice — picking one would fabricate a
// finding, which is the failure this whole pass exists to remove. A rejected
// article is simply left unscored; the unscored queue picks it up next cycle,
// and an article missing from an edition is a smaller lie than an invented
// score inside one.
//
// A DISAGREEMENT is different from a contradiction and is graded, not fatal.
// The model's holistic band read against the computed number is a check on the
// dimensions, and the two landing one band apart is the known, documented
// middle-hugging behaviour that computing the composite in code exists to
// correct (see composite.ts). Two bands apart is not that; it means the
// dimensions and flags do not describe the article the model read.

import { bandFor, LABELS, type Label } from "./calibration.js";
import { fallacyFloor, type CompositeDimensions, type CompositeFlags } from "./composite.js";

// How far the model's declared band may sit from the computed band before the
// entry is quarantined rather than published.
//
// 1 = adjacent bands are tolerated and logged. Measured basis: the 2026-08-02
// dual-model run put exact band agreement at 54.3% between models and 33.3% on
// a same-model repeat, with a P90 composite difference of 1.1 — roughly one
// band. Rejecting adjacent disagreement would therefore throw away most of a
// normal edition to no purpose. Two bands apart was not observed at all in that
// run, which is what makes it a usable quarantine line rather than an arbitrary
// one.
export const MAX_BAND_DISAGREEMENT = 1;

// The dimension ceiling that a "no" flag commits the model to. Both binding
// rules in the prompt use the same number, and it is the top of the Grounded
// band's dimension range.
const NEGATIVE_FLAG_CEILING = 2.0;

// Floating-point slack. Dimensions arrive at one decimal, so 0.05 is half a
// step: wide enough that 3.0 vs 2.9999999999999996 never fails, narrow enough
// that 2.1 against a 2.0 ceiling still does.
const EPSILON = 0.05;

export interface InvariantViolation {
  rule: string;
  detail: string;
}

// Contradictions between what the model FLAGGED and what it SCORED. Each one is
// the same judgement asked twice and answered two ways.
export function checkFlagDimensionCoherence(
  d: CompositeDimensions,
  f: CompositeFlags,
): InvariantViolation[] {
  const out: InvariantViolation[] = [];

  // "No side was suppressed" cannot sit beside a sourcing score that says one
  // was. Stated as a BINDING RULE in the prompt since the sourcing recalibration.
  if (!f.oneSidedSourcing && d.sourcing > NEGATIVE_FLAG_CEILING + EPSILON) {
    out.push({
      rule: "sourcing-vs-one_sided_sourcing",
      detail: `one_sided_sourcing is false but sourcing is ${d.sourcing.toFixed(1)}; false commits to 1.0-${NEGATIVE_FLAG_CEILING.toFixed(1)}`,
    });
  }

  // The mirror of the same rule for fallacies. "I counted zero distinct
  // fallacies" cannot sit beside "the reasoning depends on fallacies".
  if (f.fallacyCount === 0 && d.fallacies > NEGATIVE_FLAG_CEILING + EPSILON) {
    out.push({
      rule: "fallacies-vs-fallacy_count",
      detail: `fallacy_count is 0 but fallacies is ${d.fallacies.toFixed(1)}; 0 commits to 1.0-${NEGATIVE_FLAG_CEILING.toFixed(1)}`,
    });
  }

  return out;
}

// The floors the flags PROMISE, checked against the dimensions the composite was
// actually computed from. These can only fail if applyFloors and this file
// disagree, which is exactly the drift worth catching: the floors are the whole
// mechanism by which a flag reaches the reader's number, and a floor that
// quietly stopped applying would be invisible in every other check.
//
// `effective` is breakdown.effectiveDimensions — post-floor, pre-weighting.
export function checkFloorsApplied(
  effective: CompositeDimensions,
  f: CompositeFlags,
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const isNews = f.register === "news";
  const short = (key: keyof CompositeDimensions, floor: number, why: string) => {
    if (effective[key] < floor - EPSILON) {
      out.push({
        rule: `floor-${key}`,
        detail: `${why} requires ${key} >= ${floor.toFixed(1)}, effective ${key} is ${effective[key].toFixed(1)}`,
      });
    }
  };

  if (f.loadedHeadline && isNews) short("headline", 3.0, "loaded_headline");
  if (f.emotionalLede && isNews) short("structure", 3.0, "emotional_lede");
  if (f.oneSidedSourcing) short("sourcing", 3.0, "one_sided_sourcing");
  const ff = fallacyFloor(f.fallacyCount);
  if (ff > 0) short("fallacies", ff, `fallacy_count ${f.fallacyCount}`);

  return out;
}

// How many bands apart two labels sit. Both must be real labels.
export function bandDistance(a: Label, b: Label): number {
  const i = LABELS.indexOf(a);
  const j = LABELS.indexOf(b);
  if (i < 0 || j < 0) return 0;
  return Math.abs(i - j);
}

export interface BandVerdict {
  // "agree" — same band. "tolerated" — adjacent, logged, published.
  // "quarantine" — too far apart to publish.
  verdict: "agree" | "tolerated" | "quarantine";
  distance: number;
  computed: Label;
}

// The model's holistic read against the number computed from its own dimensions.
// A null/absent declared band is not a disagreement; older prompts did not ask
// for one.
export function judgeDeclaredBand(
  declared: Label | null | undefined,
  composite: number,
): BandVerdict {
  const computed = bandFor(composite).label;
  if (!declared) return { verdict: "agree", distance: 0, computed };
  const distance = bandDistance(declared, computed);
  if (distance === 0) return { verdict: "agree", distance, computed };
  return {
    verdict: distance <= MAX_BAND_DISAGREEMENT ? "tolerated" : "quarantine",
    distance,
    computed,
  };
}

export interface ScoreAdmission {
  admit: boolean;
  // Every violation found, whether or not it was fatal. Logged in full so a run
  // can be audited for near-misses, not only for rejections.
  violations: InvariantViolation[];
  bandVerdict: BandVerdict;
}

// The single gate an entry passes before it can be published. Returns the whole
// picture rather than throwing, so the caller logs one line per rejected article
// and keeps scoring the rest of the batch.
export function admitScore(args: {
  dimensions: CompositeDimensions;
  effectiveDimensions: CompositeDimensions;
  flags: CompositeFlags;
  composite: number;
  declaredBand: Label | null | undefined;
}): ScoreAdmission {
  const violations = [
    ...checkFlagDimensionCoherence(args.dimensions, args.flags),
    ...checkFloorsApplied(args.effectiveDimensions, args.flags),
  ];
  const bandVerdict = judgeDeclaredBand(args.declaredBand, args.composite);
  if (bandVerdict.verdict === "quarantine") {
    violations.push({
      rule: "declared-band-distance",
      detail: `model declared ${args.declaredBand} but the dimensions compute to ${bandVerdict.computed} (${bandVerdict.distance} bands apart; the limit is ${MAX_BAND_DISAGREEMENT})`,
    });
  }
  return { admit: violations.length === 0, violations, bandVerdict };
}
