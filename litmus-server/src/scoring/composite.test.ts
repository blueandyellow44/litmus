// The composite's own floors: the loaded-headline + emotional-lede floor, and
// the Hyperbolic pairing floor added 2026-09-27 so the top band is reachable.
import { describe, expect, it } from "vitest";
import { computeComposite, HYSTERICAL_PAIR, type CompositeDimensions, type CompositeFlags } from "./composite.js";
import { bandFor } from "./calibration.js";

const flags: CompositeFlags = { emotionalLede: false, loadedHeadline: false, fallacyCount: 0, oneSidedSourcing: false, opinionColumn: false, register: "news" };
const dims = (d: Partial<CompositeDimensions>): CompositeDimensions => ({ headline: 1, language: 1, sourcing: 1, fallacies: 1, structure: 1, ...d });

describe("the Hyperbolic pairing floor", () => {
  it("lifts an alarm headline with extreme language into the top band", () => {
    // 5/5/1/1/5 used to compute to 3.9: Running Hot, never Hyperbolic.
    const b = computeComposite(dims({ headline: 5, language: 5, structure: 5 }), flags);
    expect(b.composite).toBe(HYSTERICAL_PAIR);
    expect(bandFor(b.composite).label).toBe("Hyperbolic");
    expect(b.raised).toContain("alarm headline together with extreme language");
  });

  it("needs BOTH the headline and the language at the Hyperbolic level", () => {
    expect(computeComposite(dims({ headline: 5, language: 4.4, structure: 5 }), flags).composite).toBeLessThan(HYSTERICAL_PAIR);
    expect(computeComposite(dims({ headline: 4.4, language: 5, structure: 5 }), flags).composite).toBeLessThan(HYSTERICAL_PAIR);
  });

  it("does not apply outside hard news, where vivid language is the genre", () => {
    const b = computeComposite(dims({ headline: 5, language: 5 }), { ...flags, register: "sports" });
    expect(b.composite).toBeLessThan(HYSTERICAL_PAIR);
    expect(b.raised).not.toContain("alarm headline together with extreme language");
  });

  it("never lowers a composite that is already higher", () => {
    const b = computeComposite(dims({ headline: 5, language: 5, sourcing: 5, fallacies: 5, structure: 5 }), flags);
    expect(b.composite).toBe(5);
    expect(b.raised).not.toContain("alarm headline together with extreme language");
  });

  it("leaves calm writing exactly where it was", () => {
    expect(computeComposite(dims({ headline: 1.2, language: 1.3, sourcing: 1.4, fallacies: 1.1, structure: 1.2 }), flags).composite).toBe(1.2);
  });
});

// Max, 2026-10-10: "You can be persuasive and grounded. You can be persuasive
// and proportional." The opinion floor (2.5) is gone; the flag is a label.
describe("an opinion column carries no floor", () => {
  const opinion = { ...flags, opinionColumn: true };

  it("scores a calm, sourced column on its language, below 2.5", () => {
    const b = computeComposite(dims({ headline: 1.5, language: 1.5, sourcing: 1.5, fallacies: 1, structure: 1.5 }), opinion);
    expect(b.composite).toBe(1.4);
    expect(bandFor(b.composite).label).toBe("Proportionate");
    expect(b.raised).toEqual([]);
  });

  it("gives the same number whether or not the piece is flagged as opinion", () => {
    for (const d of [dims({}), dims({ headline: 2, language: 2.2, sourcing: 2 }), dims({ headline: 4, language: 4, fallacies: 3 })]) {
      expect(computeComposite(d, opinion).composite).toBe(computeComposite(d, flags).composite);
    }
  });

  it("still lets a heated column reach its number through the floors that read the writing", () => {
    const b = computeComposite(dims({ headline: 2, language: 2 }), { ...opinion, fallacyCount: 3, oneSidedSourcing: true, loadedHeadline: true, emotionalLede: true });
    expect(b.composite).toBe(3.5);
    expect(b.raised).not.toContain("opinion column");
  });
});
