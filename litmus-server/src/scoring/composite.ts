// The composite is computed HERE, in code, from the model's judgments — it is
// not a number the model reports.
//
// Why: the spec has always defined the composite as a weighted sum with
// conditional penalties (headline and language weighted HIGH, a +0.5
// sensationalism tax, a cumulative fallacy penalty, an opinion floor). Asking
// the model to apply that arithmetic does not work. Measured on the 2026-08-02
// smoke run: on every article the returned composite was within a rounding step
// of the flat mean of the five dimensions, and the penalties the model itself
// named in its own rationale were never added. The clearest proof was the band
// field — on two articles the model declared "Mixed Signals" and then emitted
// 2.0 and 2.3, which are Grounded. It reached the right holistic judgment and
// then overrode it with an average.
//
// So the split is: the model does judgment (five dimensions, plus the trigger
// flags below, plus a holistic band), and code does arithmetic. That is also
// what makes the scale auditable — a composite can be recomputed from stored
// inputs and explained to a reader term by term, which a model's private
// averaging never could.

import type { Label } from "./calibration.js";
import type { Register as DomainRegister } from "../types.js";

// The registers where vivid language is genre convention rather than an attempt
// to move the reader's civic judgment. See the register rule in calibration.ts.
export const REGISTERS = ["news", "sports", "culture", "feature"] as const;
export type Register = (typeof REGISTERS)[number];

export interface CompositeDimensions {
  headline: number;
  language: number;
  sourcing: number;
  fallacies: number;
  structure: number;
}

// Structured observations that drive the conditional penalties. Each is a
// yes/no or a count — the kind of call a model makes reliably — never a number
// the model has to do arithmetic with.
export interface CompositeFlags {
  emotionalLede: boolean;
  loadedHeadline: boolean;
  fallacyCount: number;
  oneSidedSourcing: boolean;
  opinionColumn: boolean;
  register: Register;
}

export interface CompositeBreakdown {
  composite: number;
  base: number;
  // Dimensions after any flag-driven floor was applied, so the arithmetic can
  // be replayed from the stored record.
  effectiveDimensions: CompositeDimensions;
  // Each floor that actually bound, in reader-facing words.
  raised: string[];
}

// Weights: headline and language HIGH (2), the rest MEDIUM (1). The headline is
// what most readers see, so it carries the same weight as the whole body's
// language. In a non-news register the language dimension drops to MEDIUM —
// colorful writing is the genre's convention there, so it should not dominate.
function weightedBase(d: CompositeDimensions, register: Register): number {
  const languageWeight = register === "news" ? 2 : 1;
  const total =
    2 * d.headline +
    languageWeight * d.language +
    d.sourcing +
    d.fallacies +
    d.structure;
  return total / (2 + languageWeight + 3);
}

// How many distinct fallacies floor the fallacies dimension. Cumulative, not
// linear: the spec says three hurt more than three times one. A single lapse is
// a lapse; a stack of them is a method.
//
// Exported so invariants.ts can assert the floor was actually applied without
// restating the ladder. Two copies of these numbers would drift, and a floor
// that quietly stopped binding is invisible in every other check.
export function fallacyFloor(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 2.5;
  if (count === 2) return 3.2;
  return 4.0;
}

// Each flag raises the FLOOR of the dimension it belongs to. It does not add a
// separate penalty on top.
//
// This is the correction for a first attempt that got it wrong. Adding a
// penalty per flag double-counted, because every flag already lives inside a
// dimension: a loaded headline IS the headline dimension, a fallacy count IS
// the fallacies dimension. Stacked additively they saturated the scale — a
// polemical but genuinely reported opinion column computed to 5.0 Hysterical,
// which the top band is not for.
//
// As floors they do exactly one job, which is the job actually needed: the
// model reliably makes the binary call ("is this headline loaded?") while
// being reluctant to push the continuous score above 3, so its own yes/no
// answer sets the minimum its number was unwilling to reach. Where the model
// already scored the dimension high, the floor does nothing.
function applyFloors(
  d: CompositeDimensions,
  f: CompositeFlags,
): { dims: CompositeDimensions; raised: string[] } {
  const dims = { ...d };
  const raised: string[] = [];
  const raise = (key: keyof CompositeDimensions, floor: number, why: string) => {
    if (dims[key] < floor) {
      dims[key] = floor;
      raised.push(why);
    }
  };
  const isNews = f.register === "news";

  // A loaded headline cannot be a sub-3 headline. Outside hard news a punchy
  // headline is the genre's convention, so the floor does not apply there.
  if (f.loadedHeadline && isNews) {
    raise("headline", 3.0, "loaded headline");
  }
  // The sensationalism tax, expressed where it belongs. Making the reader feel
  // something before giving them facts is a STRUCTURAL move, so it floors the
  // structure dimension. A feature or match report opening with a scene is the
  // form of its genre, not manipulation of civic judgment.
  if (f.emotionalLede && isNews) {
    raise("structure", 3.0, "emotional lede before facts");
  }
  // Fallacies and lopsided sourcing are not conventions of any genre, so these
  // two floors apply in every register.
  const ff = fallacyFloor(f.fallacyCount);
  if (ff > 0) {
    raise("fallacies", ff, `${f.fallacyCount} distinct logical fallac${f.fallacyCount === 1 ? "y" : "ies"}`);
  }
  if (f.oneSidedSourcing) {
    raise("sourcing", 3.0, "one-sided sourcing");
  }
  return { dims, raised };
}

// Override the model's per-article register with the source's pin, when it has
// one. A null pin means the source files more than one kind of piece and the
// model's judgement stands.
//
// Exported so the pin can be asserted directly; a guard whose behaviour is only
// visible through a paid model call is a guard nobody checks.
export function applyRegisterPin(
  flags: CompositeFlags,
  pinned: DomainRegister | null,
): CompositeFlags {
  if (!pinned || !REGISTERS.includes(pinned)) return flags;
  if (flags.register === pinned) return flags;
  return { ...flags, register: pinned };
}

// The bottom of the Hysterical band, and the level both the headline and the
// language must reach for the pairing floor to apply.
export const HYSTERICAL_PAIR = 4.5;

export function computeComposite(
  d: CompositeDimensions,
  f: CompositeFlags,
): CompositeBreakdown {
  const register = REGISTERS.includes(f.register) ? f.register : "news";
  const flags = { ...f, register };
  const { dims, raised } = applyFloors(d, flags);
  const base = weightedBase(dims, register);
  let value = base;

  // The one effect that belongs to no single dimension: a loaded headline
  // TOGETHER WITH an emotional lede is a piece built to land a feeling before a
  // fact, and the spec puts that pairing in Running Hot. Neither dimension
  // alone carries the interaction, so it floors the composite itself.
  if (flags.loadedHeadline && flags.emotionalLede && register === "news" && value < 3.5) {
    value = 3.5;
    raised.push("loaded headline together with an emotional lede");
  }

  // The top band was unreachable (Max, 2026-09-27: 1 Hysterical in 576 scores).
  // A weighted mean dilutes an alarm headline and panicked narration with
  // ordinary sourcing and structure: 5/5/1/1/5 computes to 3.9, so no article
  // could reach 4.5 however it was written. When the headline AND the outlet's
  // own language are both at the Hysterical level in hard news, that pairing is
  // what the band describes ("the headline is an alarm, the narration carries
  // contempt or panic"), so it floors the composite there. Effective (post-floor)
  // dimensions, so the pairing is judged on the same numbers the reader sees.
  if (register === "news" && dims.headline >= HYSTERICAL_PAIR && dims.language >= HYSTERICAL_PAIR && value < HYSTERICAL_PAIR) {
    value = HYSTERICAL_PAIR;
    raised.push("alarm headline together with extreme language");
  }

  // Opinion columns are inherently persuasive; the spec floors them at 2.5.
  if (flags.opinionColumn && value < 2.5) {
    value = 2.5;
    raised.push("opinion column");
  }

  const composite = Math.max(1.0, Math.min(5.0, Math.round(value * 10) / 10));
  return {
    composite,
    base: Math.round(base * 100) / 100,
    effectiveDimensions: dims,
    raised,
  };
}

// A one-line, reader-facing account of how the number was reached. The whole
// point of computing this in code is that it can be shown.
export function explainComposite(b: CompositeBreakdown): string {
  const head = `weighted dimensions ${b.base.toFixed(2)}`;
  const why = b.raised.length ? ` (raised for ${b.raised.join("; ")})` : "";
  return `${head}${why} = ${b.composite.toFixed(1)}`;
}

// Whether the model's holistic band read agrees with the computed number.
//
// Kept for callers that only need the yes/no — the calibration harness reports
// exact agreement rates. The SCORING path does not use it: a boolean cannot
// distinguish adjacent disagreement (the known middle-hugging behaviour, worth
// logging and publishing) from a two-band gap (the dimensions do not describe
// the article, worth quarantining), and the difference decides whether an
// article is published. That judgement lives in invariants.ts.
export function bandAgrees(declared: Label | null | undefined, computedLabel: Label): boolean {
  return !declared || declared === computedLabel;
}
