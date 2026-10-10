// The gate that decides whether a scored entry is publishable.

import { describe, expect, it } from "vitest";
import {
  MAX_BAND_DISAGREEMENT,
  admitScore,
  bandDistance,
  checkFlagDimensionCoherence,
  checkFloorsApplied,
  judgeDeclaredBand,
} from "./invariants.js";
import { computeComposite, type CompositeDimensions, type CompositeFlags } from "./composite.js";

const calmDims: CompositeDimensions = {
  headline: 1.2,
  language: 1.3,
  sourcing: 1.4,
  fallacies: 1.1,
  structure: 1.2,
};

const noFlags: CompositeFlags = {
  emotionalLede: false,
  loadedHeadline: false,
  fallacyCount: 0,
  oneSidedSourcing: false,
  opinionColumn: false,
  register: "news",
};

// Run an entry the way scoreBatch does: compute, then gate.
function gate(d: CompositeDimensions, f: CompositeFlags, declared: Parameters<typeof admitScore>[0]["declaredBand"] = null) {
  const breakdown = computeComposite(d, f);
  return {
    breakdown,
    admission: admitScore({
      dimensions: d,
      effectiveDimensions: breakdown.effectiveDimensions,
      flags: f,
      composite: breakdown.composite,
      declaredBand: declared,
    }),
  };
}

describe("flag / dimension coherence", () => {
  it("admits a plainly consistent calm article", () => {
    expect(checkFlagDimensionCoherence(calmDims, noFlags)).toEqual([]);
    expect(gate(calmDims, noFlags).admission.admit).toBe(true);
  });

  it("rejects 'no side was suppressed' beside a sourcing score that says one was", () => {
    // The prompt has stated this as a BINDING RULE since the sourcing
    // recalibration and nothing enforced it. 3.0 is the value that used to be
    // published unchallenged.
    const v = checkFlagDimensionCoherence({ ...calmDims, sourcing: 3.0 }, noFlags);
    expect(v).toHaveLength(1);
    expect(v[0]!.rule).toBe("sourcing-vs-one_sided_sourcing");
    expect(gate({ ...calmDims, sourcing: 3.0 }, noFlags).admission.admit).toBe(false);
  });

  it("allows sourcing right at the ceiling the flag commits to", () => {
    expect(checkFlagDimensionCoherence({ ...calmDims, sourcing: 2.0 }, noFlags)).toEqual([]);
  });

  it("tolerates float noise at the ceiling rather than rejecting on a rounding step", () => {
    expect(checkFlagDimensionCoherence({ ...calmDims, sourcing: 2.0000000001 }, noFlags)).toEqual([]);
  });

  it("rejects 'zero distinct fallacies' beside a high fallacies dimension", () => {
    const v = checkFlagDimensionCoherence({ ...calmDims, fallacies: 3.5 }, noFlags);
    expect(v).toHaveLength(1);
    expect(v[0]!.rule).toBe("fallacies-vs-fallacy_count");
  });

  it("admits a high fallacies dimension once a count backs it", () => {
    const flags = { ...noFlags, fallacyCount: 2 };
    expect(checkFlagDimensionCoherence({ ...calmDims, fallacies: 3.5 }, flags)).toEqual([]);
    expect(gate({ ...calmDims, fallacies: 3.5 }, flags).admission.admit).toBe(true);
  });

  it("reports both contradictions at once rather than stopping at the first", () => {
    const v = checkFlagDimensionCoherence({ ...calmDims, sourcing: 4.0, fallacies: 4.0 }, noFlags);
    expect(v.map((x) => x.rule).sort()).toEqual([
      "fallacies-vs-fallacy_count",
      "sourcing-vs-one_sided_sourcing",
    ]);
  });
});

describe("the floors actually bound", () => {
  it("passes when applyFloors did its job", () => {
    const flags: CompositeFlags = { ...noFlags, loadedHeadline: true, emotionalLede: true, oneSidedSourcing: true, fallacyCount: 3 };
    const { breakdown, admission } = gate({ ...calmDims, sourcing: 3.0, fallacies: 4.0 }, flags, null);
    expect(checkFloorsApplied(breakdown.effectiveDimensions, flags)).toEqual([]);
    expect(admission.admit).toBe(true);
    // And the floors really did move the numbers, so this is not a vacuous pass.
    expect(breakdown.effectiveDimensions.headline).toBeGreaterThanOrEqual(3.0);
    expect(breakdown.effectiveDimensions.structure).toBeGreaterThanOrEqual(3.0);
    expect(breakdown.effectiveDimensions.fallacies).toBeGreaterThanOrEqual(4.0);
  });

  it("catches a floor that did not apply", () => {
    // Simulates applyFloors regressing: the flag is set, the effective
    // dimension is still below the floor it promises.
    const flags: CompositeFlags = { ...noFlags, loadedHeadline: true };
    const v = checkFloorsApplied({ ...calmDims }, flags);
    expect(v).toHaveLength(1);
    expect(v[0]!.rule).toBe("floor-headline");
  });

  it("does not demand the news-only floors in a non-news register", () => {
    const flags: CompositeFlags = { ...noFlags, loadedHeadline: true, emotionalLede: true, register: "sports" };
    expect(checkFloorsApplied(calmDims, flags)).toEqual([]);
  });

  it("still demands the register-independent floors in a non-news register", () => {
    const flags: CompositeFlags = { ...noFlags, oneSidedSourcing: true, fallacyCount: 1, register: "sports" };
    const rules = checkFloorsApplied(calmDims, flags).map((v) => v.rule).sort();
    expect(rules).toEqual(["floor-fallacies", "floor-sourcing"]);
  });
});

describe("the declared band", () => {
  it("treats an absent declared band as agreement, not as a disagreement", () => {
    expect(judgeDeclaredBand(null, 2.0).verdict).toBe("agree");
    expect(judgeDeclaredBand(undefined, 2.0).verdict).toBe("agree");
  });

  it("agrees when the model named the band the arithmetic reached", () => {
    expect(judgeDeclaredBand("Grounded", 2.0).verdict).toBe("agree");
  });

  it("tolerates one band of disagreement and publishes it", () => {
    // 2.0 computes Grounded; the model said Mixed Signals. This is the known
    // middle-hugging behaviour, and rejecting it would empty an edition.
    const v = judgeDeclaredBand("Mixed Signals", 2.0);
    expect(v.verdict).toBe("tolerated");
    expect(v.distance).toBe(1);
  });

  it("quarantines two bands of disagreement", () => {
    const v = judgeDeclaredBand("Running Hot", 2.0);
    expect(v.verdict).toBe("quarantine");
    expect(v.distance).toBe(2);
  });

  it("quarantines the extreme case the old code merely logged", () => {
    const { admission } = gate(calmDims, noFlags, "Hyperbolic");
    expect(admission.admit).toBe(false);
    expect(admission.violations.map((v) => v.rule)).toContain("declared-band-distance");
  });

  it("measures distance symmetrically across the label order", () => {
    expect(bandDistance("Proportionate", "Hyperbolic")).toBe(4);
    expect(bandDistance("Hyperbolic", "Proportionate")).toBe(4);
    expect(bandDistance("Grounded", "Grounded")).toBe(0);
  });

  it("keeps the tolerance at the documented value", () => {
    // If someone widens this, the test names it rather than letting a two-band
    // gap start publishing quietly.
    expect(MAX_BAND_DISAGREEMENT).toBe(1);
  });
});
