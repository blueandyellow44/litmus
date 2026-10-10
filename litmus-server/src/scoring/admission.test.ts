// Parsers that are allowed to say no, and the ID reconciliation that runs before
// any of them.

import { describe, expect, it } from "vitest";
import {
  parseDeclaredBand,
  parseFlags,
  parsePoliticalLean,
  reconcileIds,
} from "./admission.js";

const goodFlags = {
  emotional_lede: false,
  loaded_headline: false,
  fallacy_count: 0,
  one_sided_sourcing: false,
  opinion_column: false,
  register: "news",
};

// The pre-fix implementations, verbatim, so each counterfactual is faithful
// rather than a description of one.
function sanitizeFlags_OLD(raw: unknown) {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown) => v === true;
  const count =
    typeof o.fallacy_count === "number" && Number.isFinite(o.fallacy_count)
      ? Math.max(0, Math.min(10, Math.round(o.fallacy_count)))
      : 0;
  const register = typeof o.register === "string" && ["news", "sports", "culture", "feature"].includes(o.register)
    ? o.register
    : "news";
  return {
    emotionalLede: bool(o.emotional_lede),
    loadedHeadline: bool(o.loaded_headline),
    fallacyCount: count,
    oneSidedSourcing: bool(o.one_sided_sourcing),
    opinionColumn: bool(o.opinion_column),
    register,
  };
}
function clampLean_OLD(n: unknown): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(-100, Math.min(100, Math.round(n)));
}

describe("parseFlags", () => {
  it("accepts a well-formed flags object", () => {
    const r = parseFlags(goodFlags);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toEqual({
      emotionalLede: false,
      loadedHeadline: false,
      fallacyCount: 0,
      oneSidedSourcing: false,
      opinionColumn: false,
      register: "news",
    });
  });

  it.each([undefined, null, "flags", 5, [], true])("refuses a non-object flags value (%s)", (v) => {
    const r = parseFlags(v);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems[0]).toContain("flags must be an object");
  });

  it("refuses an entirely absent flags object rather than defaulting every flag to false", () => {
    // The old code returned a complete, plausible, entirely invented answer here:
    // no emotional lede, no loaded headline, no one-sided sourcing, zero
    // fallacies, register news. Five published claims the model never made.
    const old = sanitizeFlags_OLD(undefined);
    expect(old.oneSidedSourcing).toBe(false);
    expect(old.register).toBe("news");
    expect(parseFlags(undefined).ok).toBe(false);
  });

  it.each([
    ["emotional_lede", "true"],
    ["loaded_headline", 1],
    ["one_sided_sourcing", "yes"],
    ["opinion_column", null],
  ])("refuses %s when it is not an actual boolean (%s)", (key, bad) => {
    const r = parseFlags({ ...goodFlags, [key]: bad });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.join(" ")).toContain(`flags.${key} must be a boolean`);
  });

  it("proves the old truthiness check read the string \"true\" as FALSE", () => {
    // v === true is strict about the wrong thing. A model returning the STRING
    // "true" was recorded as having said the opposite.
    expect(sanitizeFlags_OLD({ ...goodFlags, loaded_headline: "true" }).loadedHeadline).toBe(false);
  });

  it.each([undefined, null, "3", NaN, Infinity, -1, {}])(
    "refuses a fallacy_count of %s",
    (v) => {
      expect(parseFlags({ ...goodFlags, fallacy_count: v }).ok).toBe(false);
    },
  );

  it("clamps a fallacy_count that overshoots, where the intent is unambiguous", () => {
    const r = parseFlags({ ...goodFlags, fallacy_count: 40 });
    expect(r.ok && r.value.fallacyCount).toBe(10);
    const rounded = parseFlags({ ...goodFlags, fallacy_count: 2.4 });
    expect(rounded.ok && rounded.value.fallacyCount).toBe(2);
  });

  it.each([undefined, null, "", "News", "sport", "opinion", 3])(
    "refuses an invalid register (%s) rather than assuming news",
    (v) => {
      const r = parseFlags({ ...goodFlags, register: v });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.problems.join(" ")).toContain("flags.register must be one of");
    },
  );

  it.each(["news", "sports", "culture", "feature"])("accepts register %s", (v) => {
    expect(parseFlags({ ...goodFlags, register: v }).ok).toBe(true);
  });

  it("proves the old code turned an invalid register into news, which is load-bearing", () => {
    // A non-news register halves the language weight and switches off two floors,
    // so "news" is not a neutral fallback; it is the strictest possible reading,
    // applied to an answer nobody gave.
    expect(sanitizeFlags_OLD({ ...goodFlags, register: "sport" }).register).toBe("news");
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const r = parseFlags({ emotional_lede: "x", register: "nope" });
    expect(!r.ok && r.problems.length).toBeGreaterThanOrEqual(5);
  });
});

describe("parsePoliticalLean", () => {
  it.each([0, -100, 100, -37, 42])("accepts %s", (v) => {
    expect(parsePoliticalLean(v)).toEqual({ ok: true, value: v });
  });

  it("rounds and clamps a number, where the intent is unambiguous", () => {
    expect(parsePoliticalLean(140)).toEqual({ ok: true, value: 100 });
    expect(parsePoliticalLean(-140)).toEqual({ ok: true, value: -100 });
    expect(parsePoliticalLean(12.6)).toEqual({ ok: true, value: 13 });
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, "0", "center", {}, []])(
    "refuses %s instead of calling it Center",
    (v) => {
      const r = parsePoliticalLean(v);
      expect(r.ok).toBe(false);
    },
  );

  it("proves the old default published a specific claim, not an absence", () => {
    // 0 is not "unknown". It renders as "Article framing: Center", plots dead
    // centre on The Map, and satisfies a reader filtering for centrist coverage.
    for (const v of [undefined, null, NaN, "left"]) {
      expect(clampLean_OLD(v)).toBe(0);
    }
  });
});

describe("parseDeclaredBand", () => {
  it.each(["Proportionate", "Grounded", "Mixed Signals", "Running Hot", "Hyperbolic"])(
    "accepts %s",
    (v) => {
      expect(parseDeclaredBand(v)).toEqual({ ok: true, value: v });
    },
  );
  it.each([["Practical", "Proportionate"], ["Hysterical", "Hyperbolic"]])(
    "reads the pre-rename name %s as %s (Max, 2026-10-02)",
    (old, renamed) => {
      const r = parseDeclaredBand(old);
      expect(r.ok && r.value).toBe(renamed);
    },
  );

  it.each([undefined, null, "", "proportionate", "GROUNDED", "Mixed", 3, {}])(
    "refuses %s, because an optional check is one the checked thing can switch off",
    (v) => {
      expect(parseDeclaredBand(v).ok).toBe(false);
    },
  );
});

describe("reconcileIds", () => {
  const entry = (article_id: unknown, tag = "a") => ({ article_id, tag });

  it("passes a clean batch through", () => {
    const r = reconcileIds([1, 2, 3], [entry(1), entry(2), entry(3)]);
    expect([...r.usable.keys()].sort()).toEqual([1, 2, 3]);
    expect(r.duplicated).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.unrequested).toEqual([]);
  });

  it("drops BOTH entries when one article is answered twice", () => {
    // Last-write-wins was silent. Once two answers disagree neither is
    // trustworthy, and there is no evidence for picking one.
    const r = reconcileIds([1, 2], [entry(1, "first"), entry(1, "second"), entry(2)]);
    expect(r.duplicated).toEqual([1]);
    expect(r.usable.has(1)).toBe(false);
    expect(r.usable.has(2)).toBe(true);
  });

  it("proves the old Map silently kept the last duplicate", () => {
    const scores = [entry(1, "first"), entry(1, "second")];
    const old = new Map(scores.map((s) => [s.article_id, s]));
    expect((old.get(1) as { tag: string }).tag).toBe("second");
    expect(old.size).toBe(1); // and nothing recorded that a first answer existed
  });

  it("names the articles the model skipped", () => {
    const r = reconcileIds([1, 2, 3], [entry(2)]);
    expect(r.missing).toEqual([1, 3]);
    expect([...r.usable.keys()]).toEqual([2]);
  });

  it("refuses an id that was never requested", () => {
    // A transposed article number would attach one article's score to another's
    // body, which is worse than a missing score.
    const r = reconcileIds([1, 2], [entry(1), entry(999)]);
    expect(r.unrequested).toEqual([999]);
    expect(r.usable.has(999)).toBe(false);
    expect([...r.usable.keys()]).toEqual([1]);
  });

  it("keeps the valid articles from a mixed-validity batch", () => {
    const r = reconcileIds(
      [1, 2, 3, 4],
      [entry(1), entry(2), entry(2), entry(77), entry(4)],
    );
    expect([...r.usable.keys()].sort()).toEqual([1, 4]);
    expect(r.duplicated).toEqual([2]);
    expect(r.missing).toEqual([3]);
    expect(r.unrequested).toEqual([77]);
  });

  it.each([undefined, null, "1", 1.5, NaN, {}])("ignores a non-integer article_id (%s)", (v) => {
    const r = reconcileIds([1], [entry(v), entry(1)]);
    expect([...r.usable.keys()]).toEqual([1]);
    expect(r.unrequested).toEqual([]);
  });

  it("handles an empty batch and an empty request", () => {
    expect(reconcileIds([], []).usable.size).toBe(0);
    expect(reconcileIds([1, 2], []).missing).toEqual([1, 2]);
    expect(reconcileIds([], [entry(1)]).unrequested).toEqual([1]);
  });

  it("reports a triplicate once, not twice", () => {
    const r = reconcileIds([1], [entry(1), entry(1), entry(1)]);
    expect(r.duplicated).toEqual([1]);
    expect(r.usable.size).toBe(0);
  });
});
