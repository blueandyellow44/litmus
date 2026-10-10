import { describe, it, expect } from "vitest";
import {
  STORY_ID_PATTERN,
  STORY_SLUG_MAX_WORDS_CHARS,
  STORY_SLUG_PATTERN,
  membershipHash,
  mintStoryId,
  storySlug,
} from "./identity.js";

const ZERO_RANDOM = new Uint8Array(10);
const FULL_RANDOM = new Uint8Array(10).fill(0xff);

describe("mintStoryId", () => {
  it("matches the database's id format", () => {
    for (let i = 0; i < 200; i++) expect(mintStoryId()).toMatch(STORY_ID_PATTERN);
  });

  it("encodes time and randomness exactly, at both extremes", () => {
    expect(mintStoryId(0, ZERO_RANDOM)).toBe("st_" + "0".repeat(26));
    expect(mintStoryId(2 ** 48 - 1, FULL_RANDOM)).toBe("st_" + "7ZZZZZZZZZ" + "Z".repeat(16));
  });

  it("encodes a known ULID vector", () => {
    // 1469918176385 ms is the timestamp of the reference ULID 01ARYZ6S41...
    expect(mintStoryId(1469918176385, ZERO_RANDOM).slice(3, 13)).toBe("01ARYZ6S41");
  });

  it("sorts by creation time", () => {
    const earlier = mintStoryId(1_757_800_000_000, FULL_RANDOM);
    const later = mintStoryId(1_757_800_000_001, ZERO_RANDOM);
    expect(earlier < later).toBe(true);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => mintStoryId(1_757_800_000_000)));
    expect(ids.size).toBe(5000);
  });

  it("REFUSES a time or a random buffer it cannot encode faithfully", () => {
    expect(() => mintStoryId(-1)).toThrow(/48-bit/);
    expect(() => mintStoryId(2 ** 48)).toThrow(/48-bit/);
    expect(() => mintStoryId(1.5)).toThrow(/48-bit/);
    expect(() => mintStoryId(0, new Uint8Array(9))).toThrow(/exactly 10/);
  });
});

describe("storySlug", () => {
  const id = mintStoryId(1_757_800_000_000, FULL_RANDOM);
  const tail = id.slice(-6).toLowerCase();

  it("reads as the headline and ends in the id tail", () => {
    expect(storySlug("Senate passes the stopgap funding bill", id)).toBe(
      `senate-passes-the-stopgap-funding-bill-${tail}`,
    );
  });

  it("drops accents and punctuation", () => {
    expect(storySlug("Zelenskyy's Pétition: 'No' — again?", id)).toBe(`zelenskyy-s-petition-no-again-${tail}`);
  });

  it("caps length on a word boundary", () => {
    const long = "word ".repeat(40);
    const slug = storySlug(long, id);
    expect(slug.length).toBeLessThanOrEqual(STORY_SLUG_MAX_WORDS_CHARS + 1 + tail.length);
    expect(slug).toMatch(/^(word-)+[a-z0-9]{6}$/);
  });

  it("cuts a single enormous word hard rather than emitting nothing", () => {
    const slug = storySlug("x".repeat(200), id);
    expect(slug).toBe(`${"x".repeat(STORY_SLUG_MAX_WORDS_CHARS)}-${tail}`);
  });

  it("falls back when the headline has no usable characters", () => {
    expect(storySlug("— !!! —", id)).toBe(`story-${tail}`);
    expect(storySlug("", id)).toBe(`story-${tail}`);
  });

  it("always matches the database's slug format", () => {
    for (const h of ["A", "  spaced  out  ", "日本語のみ", "a--b", "-lead and trail-", "x".repeat(61)]) {
      expect(storySlug(h, mintStoryId())).toMatch(STORY_SLUG_PATTERN);
    }
  });

  it("REFUSES something that is not a story id", () => {
    expect(() => storySlug("Headline", "12")).toThrow(/not a story id/);
  });
});

describe("membershipHash", () => {
  const a = { articleId: 10, role: "primary" as const, kind: "full" as const };
  const b = { articleId: 7, role: "secondary" as const, kind: "headline_only" as const };

  it("ignores order", () => {
    expect(membershipHash([a, b])).toBe(membershipHash([b, a]));
  });

  it("changes when a member joins or leaves", () => {
    expect(membershipHash([a, b])).not.toBe(membershipHash([a]));
  });

  it("changes when a member's role or kind changes", () => {
    expect(membershipHash([a, b])).not.toBe(membershipHash([a, { ...b, role: "primary" }]));
    expect(membershipHash([a, b])).not.toBe(membershipHash([a, { ...b, kind: "full" }]));
  });

  it("is a sha256 hex digest", () => {
    expect(membershipHash([a])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("REFUSES an empty story, a duplicate article and a bad id", () => {
    expect(() => membershipHash([])).toThrow(/no members/);
    expect(() => membershipHash([a, { ...a, role: "secondary" }])).toThrow(/appears twice/);
    expect(() => membershipHash([{ ...a, articleId: 0 }])).toThrow(/positive integer/);
    expect(() => membershipHash([{ ...a, articleId: 1.5 }])).toThrow(/positive integer/);
  });
});
