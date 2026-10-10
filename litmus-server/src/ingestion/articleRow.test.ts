import { describe, it, expect } from "vitest";
import {
  planArticleRow,
  hashForItem,
  isHeadlineOnly,
  shouldRetryExtraction,
  headlineUpgradeFromPlan,
  type ContentHashMatch,
} from "./articleRow.js";
import { detectPaywall } from "./paywallDetector.js";
import { contentHash } from "./deduper.js";
import type { ExtractedContent } from "./extractor.js";
import type { Source } from "../types.js";

// The S2 rules, each as a branch a future edit could quietly reverse:
// an empty extraction is a headline-only ROW, not a skip; a same-outlet hash
// match is still a skip; a cross-outlet hash match is a syndicated row.

const BODY = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");

function source(over: Partial<Source> = {}): Source {
  return {
    id: 7,
    name: "New York Times — Politics",
    outletKey: "new-york-times",
    rssUrl: "https://example.test/nyt/politics.xml",
    lean: "center-left",
    type: "newspaper",
    paywallStatus: "metered",
    reliability: 4,
    prominence: 3,
    enabled: true,
    register: null,
    ...over,
  };
}

const item = {
  url: "https://example.test/nyt/story",
  title: "Senate passes the stopgap funding bill",
  author: "A. Reporter",
  publishedAt: new Date("2026-09-13T12:00:00Z"),
};

function extracted(over: Partial<ExtractedContent> = {}): ExtractedContent {
  return { text: BODY, wordCount: 300, via: "publisher", ...over };
}

function plan(over: {
  source?: Source;
  extracted?: ExtractedContent;
  existing?: ContentHashMatch | null;
  sameOutletPiece?: { id: number } | null;
}) {
  const src = over.source ?? source();
  const ext = over.extracted ?? extracted();
  return planArticleRow({
    source: src,
    item,
    extracted: ext,
    verdict: detectPaywall(ext.wordCount, src),
    hash: hashForItem(item, ext),
    existing: over.existing ?? null,
    sameOutletPiece: over.sameOutletPiece ?? null,
  });
}

describe("planArticleRow: headline-only rows", () => {
  it("stores a zero-word extraction as a headline-only row instead of skipping it", () => {
    const p = plan({ extracted: extracted({ text: "", wordCount: 0, via: "feed" }) });
    expect(p.action).toBe("insert");
    if (p.action !== "insert") return;
    expect(p.kind).toBe("headline_only");
    expect(p.row).toMatchObject({
      sourceId: 7,
      url: item.url,
      title: item.title,
      publishedAt: item.publishedAt,
      rawText: "",
      wordCount: 0,
      extractionStatus: "failed",
      extractedVia: null,
      syndicatedOfArticleId: null,
    });
    expect(isHeadlineOnly(p.row)).toBe(true);
  });

  it("carries the paywall flag through, so the row can say why it was not read", () => {
    const paywalled = plan({ extracted: extracted({ text: "", wordCount: 0, via: "feed" }) });
    const free = plan({
      source: source({ paywallStatus: "free" }),
      extracted: extracted({ text: "", wordCount: 0, via: "feed" }),
    });
    expect(paywalled.action === "insert" && paywalled.row.paywallFlag).toBe(true);
    expect(free.action === "insert" && free.row.paywallFlag).toBe(false);
  });

  it("never marks a headline-only row syndicated: a title alone proves no copy", () => {
    const p = plan({
      extracted: extracted({ text: "", wordCount: 0, via: "feed" }),
      existing: { id: 1, outletKey: "associated-press", sameOutlet: false, syndicatedOfArticleId: null },
    });
    expect(p.action).toBe("insert");
    if (p.action !== "insert") return;
    expect(p.kind).toBe("headline_only");
    expect(p.row.syndicatedOfArticleId).toBeNull();
  });

  it("still skips a headline-only duplicate inside the same outlet", () => {
    const p = plan({
      extracted: extracted({ text: "", wordCount: 0, via: "feed" }),
      existing: { id: 1, outletKey: "new-york-times", sameOutlet: true, syndicatedOfArticleId: null },
    });
    expect(p).toEqual({ action: "skip-same-outlet-copy", originalId: 1 });
  });

  it("is not written when a sister feed of the outlet already holds the piece", () => {
    const p = plan({
      extracted: extracted({ text: "", wordCount: 0, via: "feed" }),
      sameOutletPiece: { id: 88 },
    });
    expect(p).toEqual({ action: "skip-same-outlet-copy", originalId: 88 });
  });

  it("ignores the same-outlet piece when the item has a body: the hash rule owns that case", () => {
    const p = plan({ sameOutletPiece: { id: 88 } });
    expect(p.action).toBe("insert");
    if (p.action !== "insert") return;
    expect(p.kind).toBe("full");
  });

  it("hashes a headline-only row on its title and publication day", () => {
    const ext = extracted({ text: "", wordCount: 0, via: "feed" });
    expect(hashForItem(item, ext)).toBe(contentHash(item.title, "2026-09-13"));
  });

  it("keeps a recurring headline on a later day as its own row, not a duplicate", () => {
    const ext = extracted({ text: "", wordCount: 0, via: "feed" });
    const monday = { ...item, url: "https://example.test/nyt/briefing-mon", title: "Morning Briefing", publishedAt: new Date("2026-09-14T10:00:00Z") };
    const tuesday = { ...item, url: "https://example.test/nyt/briefing-tue", title: "Morning Briefing", publishedAt: new Date("2026-09-15T10:00:00Z") };
    expect(hashForItem(monday, ext)).not.toBe(hashForItem(tuesday, ext));
  });

  it("still collapses one item carried by two of an outlet's feeds, minutes apart", () => {
    const ext = extracted({ text: "", wordCount: 0, via: "feed" });
    const politics = { ...item, url: "https://example.test/nyt/politics/story", publishedAt: new Date("2026-09-14T10:00:00Z") };
    const us = { ...item, url: "https://example.test/nyt/us/story", publishedAt: new Date("2026-09-14T10:07:00Z") };
    expect(hashForItem(politics, ext)).toBe(hashForItem(us, ext));
  });

  it("falls back to the url when an item carries no date", () => {
    const ext = extracted({ text: "", wordCount: 0, via: "feed" });
    const undated = { ...item, publishedAt: null };
    expect(hashForItem(undated, ext)).toBe(contentHash(undated.title, undated.url));
    // Two undated pieces sharing a headline stay separate rows.
    expect(hashForItem(undated, ext)).not.toBe(
      hashForItem({ ...undated, url: "https://example.test/nyt/other" }, ext),
    );
  });
});

describe("planArticleRow: content-hash matches", () => {
  it("skips a match inside the same outlet (sister feeds are one telling)", () => {
    const p = plan({ existing: { id: 41, outletKey: "new-york-times", sameOutlet: true, syndicatedOfArticleId: null } });
    expect(p).toEqual({ action: "skip-same-outlet-copy", originalId: 41 });
  });

  it("stores a match from another outlet as a syndicated copy of the original", () => {
    const p = plan({ existing: { id: 41, outletKey: "associated-press", sameOutlet: false, syndicatedOfArticleId: null } });
    expect(p.action).toBe("insert");
    if (p.action !== "insert") return;
    expect(p.kind).toBe("syndicated");
    expect(p.row.syndicatedOfArticleId).toBe(41);
    // The copy keeps its own text and status: it is a real row, just not an
    // independent telling.
    expect(p.row.rawText).toBe(BODY);
    expect(p.row.extractionStatus).toBe("full");
    expect(p.row.extractedVia).toBe("publisher");
  });

  // Defensive, not a state the repo can currently reach: a copy is always
  // inserted after its original, and ON DELETE SET NULL clears a surviving
  // copy's pointer when the original is pruned. The branch guards a future
  // writer that re-points a copy at a new root, so the chain stays one hop.
  it("points at the root when the match is itself a copy, so pointers stay one hop", () => {
    const p = plan({ existing: { id: 41, outletKey: "associated-press", sameOutlet: false, syndicatedOfArticleId: 12 } });
    expect(p.action === "insert" && p.row.syndicatedOfArticleId).toBe(12);
  });

  // sameOutlet comes from the polling outlet's source ids, not from a string
  // comparison, so the skip survives the 0001 rollback window where outlet_key
  // is null and two feeds of one outlet fall back to different synthetic keys.
  it("skips on sameOutlet even when the match's outlet key reads differently", () => {
    const p = plan({ existing: { id: 41, outletKey: "source-9", sameOutlet: true, syndicatedOfArticleId: null } });
    expect(p).toEqual({ action: "skip-same-outlet-copy", originalId: 41 });
  });

  it("syndicates on sameOutlet false even when the match's outlet key reads the same", () => {
    const p = plan({ existing: { id: 41, outletKey: "new-york-times", sameOutlet: false, syndicatedOfArticleId: null } });
    expect(p.action).toBe("insert");
    if (p.action !== "insert") return;
    expect(p.kind).toBe("syndicated");
    expect(p.row.syndicatedOfArticleId).toBe(41);
  });

  it("inserts an ordinary row when nothing matches", () => {
    const p = plan({});
    expect(p.action).toBe("insert");
    if (p.action !== "insert") return;
    expect(p.kind).toBe("full");
    expect(p.row).toMatchObject({
      rawText: BODY,
      wordCount: 300,
      extractionStatus: "full",
      extractedVia: "publisher",
      syndicatedOfArticleId: null,
      contentHash: contentHash(item.title, BODY),
    });
  });

  it("keeps a thin extract as a partial row with its text, not as headline-only", () => {
    const thin = extracted({ text: "Forty words of feed snippet.", wordCount: 5, via: "feed" });
    const p = plan({ extracted: thin });
    expect(p.action).toBe("insert");
    if (p.action !== "insert") return;
    expect(p.kind).toBe("full");
    expect(p.row.extractionStatus).toBe("partial");
    expect(p.row.wordCount).toBe(5);
    expect(isHeadlineOnly(p.row)).toBe(false);
  });
});

// A stored headline-only row is retried while it can still reach a page, and
// a body from the retry becomes the row's upgrade. Before S2 the retry was
// free: a zero-word item left no row, so the next run fetched it again. The
// row must not end that.
describe("shouldRetryExtraction", () => {
  const WINDOW = 14;
  const now = new Date("2026-09-13T12:00:00Z");
  const hollow = { extractionStatus: "failed", wordCount: 0 };

  it("retries a thin row inside the window, but not a full one (2026-09-26)", () => {
    const at = { publishedAt: new Date("2026-09-12T12:00:00Z"), fetchedAt: new Date("2026-09-12T13:00:00Z") };
    // Only when asked, which runIngest does for free sources only.
    expect(shouldRetryExtraction({ extractionStatus: "partial", wordCount: 127, ...at }, WINDOW, now, true)).toBe(true);
    expect(shouldRetryExtraction({ extractionStatus: "partial", wordCount: 127, ...at }, WINDOW, now)).toBe(false);
    expect(shouldRetryExtraction({ extractionStatus: "full", wordCount: 450, ...at }, WINDOW, now, true)).toBe(false);
  });

  it("retries a headline-only row published inside the window", () => {
    const stored = { ...hollow, publishedAt: new Date("2026-09-12T12:00:00Z"), fetchedAt: new Date("2026-09-12T13:00:00Z") };
    expect(shouldRetryExtraction(stored, WINDOW, now)).toBe(true);
  });

  it("leaves a headline-only row alone once it is past the window", () => {
    const stored = { ...hollow, publishedAt: new Date("2026-08-01T12:00:00Z"), fetchedAt: new Date("2026-09-12T13:00:00Z") };
    expect(shouldRetryExtraction(stored, WINDOW, now)).toBe(false);
  });

  it("measures an undated row from its fetch time, the same fallback the edition uses", () => {
    const fresh = { ...hollow, publishedAt: null, fetchedAt: new Date("2026-09-10T12:00:00Z") };
    const stale = { ...hollow, publishedAt: null, fetchedAt: new Date("2026-08-10T12:00:00Z") };
    expect(shouldRetryExtraction(fresh, WINDOW, now)).toBe(true);
    expect(shouldRetryExtraction(stale, WINDOW, now)).toBe(false);
  });

  it("never retries a row that already has a body, however thin", () => {
    const partial = { extractionStatus: "partial", wordCount: 5, publishedAt: now, fetchedAt: now };
    const full = { extractionStatus: "full", wordCount: 900, publishedAt: now, fetchedAt: now };
    expect(shouldRetryExtraction(partial, WINDOW, now)).toBe(false);
    expect(shouldRetryExtraction(full, WINDOW, now)).toBe(false);
  });
});

describe("headlineUpgradeFromPlan", () => {
  it("turns a full plan into the body fields the row gains, and nothing else", () => {
    const upgrade = headlineUpgradeFromPlan(plan({}));
    expect(upgrade).toEqual({
      rawText: BODY,
      wordCount: 300,
      extractionStatus: "full",
      extractedVia: "publisher",
      paywallFlag: false,
      contentHash: contentHash(item.title, BODY),
      syndicatedOfArticleId: null,
    });
  });

  it("carries the syndication pointer when the retried body matches another outlet", () => {
    const upgrade = headlineUpgradeFromPlan(
      plan({ existing: { id: 41, outletKey: "associated-press", sameOutlet: false, syndicatedOfArticleId: null } }),
    );
    expect(upgrade?.syndicatedOfArticleId).toBe(41);
  });

  it("leaves the row as it is when the retry still yields no words", () => {
    expect(headlineUpgradeFromPlan(plan({ extracted: extracted({ text: "", wordCount: 0, via: "feed" }) }))).toBeNull();
  });

  it("leaves the row as it is when a sister feed has meanwhile stored the same text", () => {
    expect(
      headlineUpgradeFromPlan(plan({ existing: { id: 41, outletKey: "new-york-times", sameOutlet: true, syndicatedOfArticleId: null } })),
    ).toBeNull();
  });
});
