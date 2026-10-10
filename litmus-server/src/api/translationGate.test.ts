import { describe, expect, it } from "vitest";
import { createTranslationGate, parseDailyCap } from "./translationGate.js";

const DAY = 24 * 60 * 60 * 1000;

describe("the on-demand translation gate", () => {
  it("is off unless switched on, for the route and for a paid call", () => {
    const gate = createTranslationGate({ enabled: false, dailyCap: 5 });
    expect(gate.enabled()).toEqual({ status: 403, error: "translation_disabled" });
    expect(gate.reserve()).toEqual({ status: 403, error: "translation_disabled" });
  });

  it("allows paid calls up to the cap, then refuses", () => {
    const gate = createTranslationGate({ enabled: true, dailyCap: 2, now: () => 0 });
    expect(gate.enabled()).toBeNull();
    expect(gate.reserve()).toBeNull();
    expect(gate.reserve()).toBeNull();
    expect(gate.reserve()).toEqual({ status: 429, error: "translation_daily_cap" });
  });

  it("a cap of zero refuses every paid call", () => {
    const gate = createTranslationGate({ enabled: true, dailyCap: 0, now: () => 0 });
    expect(gate.reserve()).toEqual({ status: 429, error: "translation_daily_cap" });
  });

  it("starts a fresh count on the next UTC day", () => {
    let t = 0;
    const gate = createTranslationGate({ enabled: true, dailyCap: 1, now: () => t });
    expect(gate.reserve()).toBeNull();
    expect(gate.reserve()).not.toBeNull();
    t = DAY;
    expect(gate.reserve()).toBeNull();
  });

  it("gives a reservation back when the paid call was never made", () => {
    const gate = createTranslationGate({ enabled: true, dailyCap: 1, now: () => 0 });
    expect(gate.reserve()).toBeNull();
    gate.release();
    expect(gate.reserve()).toBeNull();
    gate.release();
    gate.release();
    expect(gate.reserve()).toBeNull();
    expect(gate.reserve()).not.toBeNull();
  });
});

describe("TRANSLATION_DAILY_CAP", () => {
  it("defaults when unset and reads a whole number", () => {
    expect(parseDailyCap(undefined)).toBe(25);
    expect(parseDailyCap("")).toBe(25);
    expect(parseDailyCap("0")).toBe(0);
    expect(parseDailyCap(" 40 ")).toBe(40);
  });
  it("refuses anything that is not a whole number", () => {
    for (const bad of ["5abc", "-1", "1.5", "ten"]) expect(() => parseDailyCap(bad)).toThrow();
  });
});
