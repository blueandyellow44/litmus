// The non-article gate, tested against pages that really were published.
//
// The fixtures are not invented. They are the verbatim extracted bodies of
// snapshot articles 1440, 1441, 1442 and 1444 — four copies of NBC's Nightly
// News video index page — beside four genuinely short or unusual real articles
// that must survive the gate. Anything else would be testing a description of
// the problem rather than the problem.

import { describe, expect, it } from "vitest";
import fixtures from "./__fixtures__/nonArticleFixtures.json" with { type: "json" };
import {
  CONTENT_TYPES,
  admitContent,
  isPublishableType,
  judgeShape,
  measureShape,
  parseContentType,
} from "./contentType.js";

// The four index pages carry what LITMUS actually published for them; the four
// real articles are body-only. Optional fields rather than two types, so a
// lookup never needs a cast.
interface Fixture {
  id: number;
  sourceName: string;
  title: string;
  rawText: string;
  wordCount: number;
  publishedComposite?: number;
  publishedLabel?: string;
  publishedSection?: string;
  rationaleSummary?: string;
}
const FIXTURES = fixtures as unknown as Record<string, Fixture>;
const f = (id: number) => FIXTURES[String(id)]!;

// The four index pages, and what LITMUS actually published for each.
const INDEX_PAGES = [1440, 1441, 1442, 1444];
// Real articles chosen for being the hardest cases in the bundled edition: the
// lowest prose-paragraph fractions and the shortest bodies that are nevertheless
// genuine reporting.
const REAL_ARTICLES = [1124, 983, 887, 1519];

describe("the published evidence this gate exists for", () => {
  it("shows one index page scored three bands apart from its own duplicate", () => {
    const a = f(1440);
    const b = f(1444);
    expect(a.publishedLabel).toBe("Running Hot");
    expect(b.publishedLabel).toBe("Practical");
    expect(Math.abs(a.publishedComposite! - b.publishedComposite!)).toBeGreaterThan(2);
  });

  it("shows the model naming the problem in prose while the score was published anyway", () => {
    for (const id of [1440, 1444]) {
      expect(f(id).rationaleSummary!.toLowerCase()).toContain("not a news article");
    }
    // Which is why the gate is a structured field and a shape check, and reads
    // none of this text.
  });
});

describe("parseContentType", () => {
  it.each(CONTENT_TYPES)("accepts %s", (t) => {
    expect(parseContentType(t)).toBe(t);
  });

  it.each([undefined, null, "", "Article", "ARTICLE", "news", 1, true, {}, []])(
    "refuses %s",
    (v) => {
      expect(parseContentType(v)).toBeNull();
    },
  );

  it("publishes only article and transcript", () => {
    expect(CONTENT_TYPES.filter(isPublishableType)).toEqual(["article", "transcript"]);
  });
});

describe("the deterministic shape check", () => {
  it.each(INDEX_PAGES)("recognises snapshot article %s as an index page", (id) => {
    const v = judgeShape(f(id).rawText);
    expect(v.looksLikeListing).toBe(true);
    expect(v.reason).toBeTruthy();
  });

  it("fires on all three signals for the index pages, not on a single lucky one", () => {
    // A one-signal detector would be a coin flip on the next feed that breaks.
    for (const id of INDEX_PAGES) {
      expect(measureShape(f(id).rawText).fired.sort()).toEqual([
        "no-sentences",
        "playlist-cues",
        "timestamp-paragraphs",
      ]);
    }
  });

  it.each(REAL_ARTICLES)("leaves genuine article %s alone", (id) => {
    expect(judgeShape(f(id).rawText).looksLikeListing).toBe(false);
  });

  it("keeps a wide margin on every signal", () => {
    // Measured across all 152 bundled articles: the index pages sit at 0.456
    // timestamp ratio with 4 cues and 0 prose paragraphs; the closest real
    // article is 0.048 with 0 cues. If this margin ever narrows, the thresholds
    // need re-measuring rather than nudging.
    for (const id of INDEX_PAGES) {
      const s = measureShape(f(id).rawText);
      expect(s.timestampRatio).toBeGreaterThan(0.4);
      expect(s.playlistCues).toBeGreaterThanOrEqual(4);
      expect(s.proseRatio).toBe(0);
    }
    for (const id of REAL_ARTICLES) {
      const s = measureShape(f(id).rawText);
      expect(s.timestampRatio, `article ${id}`).toBeLessThan(0.1);
      expect(s.playlistCues, `article ${id}`).toBe(0);
    }
  });

  it("does not flag a short body with no paragraphs to measure", () => {
    expect(judgeShape("").looksLikeListing).toBe(false);
    expect(judgeShape("One short sentence.").looksLikeListing).toBe(false);
  });

  it("keeps a video transcript, which carries timestamps but also sentences", () => {
    const transcript = Array.from(
      { length: 12 },
      (_, i) =>
        `0${i}:15\n\nThe reporter explains what happened next in a full sentence that runs on for a while.`,
    ).join("\n\n");
    const s = measureShape(transcript);
    // Timestamps fire, but the prose signal does not, and there are no playlist
    // cues, so one signal is not two.
    expect(s.fired).toEqual(["timestamp-paragraphs"]);
    expect(judgeShape(transcript).looksLikeListing).toBe(false);
  });
});

describe("admitContent", () => {
  it.each(INDEX_PAGES)(
    "refuses snapshot article %s even when the model calls it an article",
    (id) => {
      // The important case: the model cooperating badly. On these four pages it
      // filled in five dimensions and a band, so a gate that trusted only the
      // model's classification would have let them through.
      const r = admitContent("article", f(id).rawText);
      expect(r.admit).toBe(false);
      expect(r.reasons.join(" ")).toContain("index page");
    },
  );

  it.each(INDEX_PAGES)("refuses snapshot article %s when the model classifies it honestly", (id) => {
    const r = admitContent("listing", f(id).rawText);
    expect(r.admit).toBe(false);
    expect(r.reasons.some((x) => x.includes("not publishable"))).toBe(true);
  });

  it.each(REAL_ARTICLES)("admits genuine article %s", (id) => {
    expect(admitContent("article", f(id).rawText).admit).toBe(true);
  });

  it("admits a transcript", () => {
    expect(admitContent("transcript", f(983).rawText).admit).toBe(true);
  });

  it.each(["listing", "navigation", "furniture", "other"])("refuses content_type %s", (t) => {
    const r = admitContent(t, f(983).rawText);
    expect(r.admit).toBe(false);
  });

  it.each([undefined, null, "", "news", 3, {}])(
    "refuses a missing or unrecognised content_type (%s) rather than assuming article",
    (v) => {
      const r = admitContent(v, f(983).rawText);
      expect(r.admit).toBe(false);
      expect(r.reasons.join(" ")).toContain("content_type is missing or not one of");
    },
  );

  it("reports every reason, so a log line names both gates when both fired", () => {
    const r = admitContent("listing", f(1440).rawText);
    expect(r.reasons).toHaveLength(2);
  });
});
