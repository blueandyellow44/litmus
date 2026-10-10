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
