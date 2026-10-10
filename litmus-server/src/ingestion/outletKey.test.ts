import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OUTLET_KEY_PATTERN, outletKeyFromName, resolveOutletKey } from "./outletKey.js";

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, "..", "..", "sources", "seed.json"), "utf-8")) as {
  sources: Array<{ name: string; rssUrl: string; lean: string; outletKey?: string }>;
};

function keyOf(name: string): string {
  const entry = seed.sources.find((s) => s.name === name);
  if (!entry) throw new Error(`seed.json has no source named "${name}"; update this test with the roster`);
  if (!entry.outletKey) throw new Error(`seed.json source "${name}" has no outletKey`);
  return entry.outletKey;
}

describe("outletKeyFromName", () => {
  it("drops the desk after the em dash, so sister feeds derive one key", () => {
    expect(outletKeyFromName("New York Times — Politics")).toBe("new-york-times");
    expect(outletKeyFromName("New York Times — US")).toBe("new-york-times");
  });

  it("keeps a name with no desk whole", () => {
    expect(outletKeyFromName("The Hill")).toBe("the-hill");
    expect(outletKeyFromName("FactCheck.org")).toBe("factcheck-org");
  });

  it("does not treat a plain hyphen as the desk separator", () => {
    expect(outletKeyFromName("Foo - Bar")).toBe("foo-bar");
  });

  it("strips non-ASCII before lowercasing, matching the SQL backfill", () => {
    // U+212A KELVIN SIGN lowercases to ASCII "k" in JavaScript; it must be
    // removed first, as Postgres removes it, not turned into a letter.
    expect(outletKeyFromName("Kelvin Times")).toBe("elvin-times");
    expect(outletKeyFromName("Le Monde Économie")).toBe("le-monde-conomie");
  });

  it("returns null when nothing usable is left", () => {
    expect(outletKeyFromName("")).toBeNull();
    expect(outletKeyFromName(" — Politics")).toBeNull();
    // A dash that is not the separator is just punctuation in the outlet's name.
    expect(outletKeyFromName("— Politics")).toBe("politics");
    expect(outletKeyFromName("!!!")).toBeNull();
  });
});

describe("resolveOutletKey", () => {
  it("prefers the explicit key", () => {
    expect(resolveOutletKey({ name: "BBC Sport", outletKey: "bbc" })).toBe("bbc");
  });

  it("falls back to the derivation when the key is absent or null", () => {
    expect(resolveOutletKey({ name: "NPR — News" })).toBe("npr");
    expect(resolveOutletKey({ name: "NPR — News", outletKey: null })).toBe("npr");
  });

  it("REFUSES a malformed explicit key instead of writing a row the database rejects", () => {
    expect(() => resolveOutletKey({ name: "X", outletKey: "New York Times" })).toThrow(/invalid outletKey/);
    expect(() => resolveOutletKey({ name: "X", outletKey: "" })).toThrow(/invalid outletKey/);
    expect(() => resolveOutletKey({ name: "X", outletKey: "nyt--us" })).toThrow(/invalid outletKey/);
  });

  it("REFUSES a source with no key and an underivable name", () => {
    expect(() => resolveOutletKey({ name: "!!!" })).toThrow(/none can be derived/);
  });
});

describe("the seed mapping", () => {
  it("gives every feed an explicit, well-formed outletKey", () => {
    const missing = seed.sources.filter((s) => !s.outletKey || !OUTLET_KEY_PATTERN.test(s.outletKey));
    expect(missing.map((s) => s.name)).toEqual([]);
  });

  it("puts the known sister feeds under one outlet", () => {
    expect(keyOf("New York Times — Politics")).toBe(keyOf("New York Times — US"));
    expect(keyOf("NPR — News")).toBe(keyOf("NPR — Politics"));
    expect(keyOf("Wall Street Journal — World")).toBe(keyOf("Wall Street Journal — Politics"));
    expect(keyOf("BBC News — World")).toBe(keyOf("BBC News — US & Canada"));
    // Same newsroom, a name the derivation cannot join on its own.
    expect(keyOf("BBC Sport")).toBe(keyOf("BBC News — World"));
  });

  it("keeps distinct outlets apart, including near-namesakes", () => {
    expect(keyOf("Washington Post — Politics")).not.toBe(keyOf("Washington Times"));
    expect(keyOf("NBC News")).not.toBe(keyOf("CNBC"));
    expect(keyOf("Wall Street Journal — World")).not.toBe(keyOf("MarketWatch"));
  });

  it("only departs from the derivation where the name cannot say it is a sister feed", () => {
    // Every override is a deliberate editorial call. Listing them here means a
    // new one cannot slip into seed.json unreviewed.
    const overrides = seed.sources
      .filter((s) => s.outletKey !== outletKeyFromName(s.name))
      .map((s) => s.name)
      .sort();
    expect(overrides).toEqual(["BBC News — US & Canada", "BBC News — World", "BBC Sport"]);
  });

  it("never gives one outlet two leans, which would make the matrix contradict itself", () => {
    const leans = new Map<string, Set<string>>();
    for (const s of seed.sources) {
      const set = leans.get(s.outletKey!) ?? new Set<string>();
      set.add(s.lean);
      leans.set(s.outletKey!, set);
    }
    const split = [...leans.entries()].filter(([, set]) => set.size > 1).map(([key]) => key);
    expect(split).toEqual([]);
  });
});
