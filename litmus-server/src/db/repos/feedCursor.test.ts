// The feed cursor.
//
// Keyset, not OFFSET, because ORDER BY publication date alone is not a total
// order: dozens of articles in an edition share a timestamp to the second, and
// under OFFSET the database is free to return tied rows in a different order on
// each query. A reader clicking "Load more" then sees some articles twice and
// never sees others — on a feed whose entire claim is that it shows the whole
// edition.
//
// These tests cover the codec and the ordering predicate the SQL implements.
// The query itself is exercised against real Postgres by the migration contract
// suite's database; what can go wrong HERE is decoding, which is the part that
// takes untrusted input straight out of a URL.

import { describe, expect, it } from "vitest";
import { decodeFeedCursor, encodeFeedCursor } from "./articlesRepo.js";

describe("the cursor codec", () => {
  it("round-trips", () => {
    const c = { sortAt: "2026-09-04T12:00:00.000Z", id: 4321 };
    expect(decodeFeedCursor(encodeFeedCursor(c))).toEqual(c);
  });

  it("round-trips a timestamp carrying an offset", () => {
    const c = { sortAt: "2026-09-04T12:00:00.000+02:00", id: 1 };
    expect(decodeFeedCursor(encodeFeedCursor(c))).toEqual(c);
  });

  it("produces a token with nothing a caller can do arithmetic on", () => {
    const token = encodeFeedCursor({ sortAt: "2026-09-04T12:00:00.000Z", id: 7 });
    expect(token).not.toContain("2026");
    expect(token).not.toContain("|");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { sortAt: "x", id: 1 }],
    ["an empty string", ""],
    ["plain text", "next-page"],
    ["base64 of nonsense", Buffer.from("not-a-cursor", "utf8").toString("base64url")],
    ["a missing id", Buffer.from("2026-09-04T12:00:00Z|", "utf8").toString("base64url")],
    ["a non-numeric id", Buffer.from("2026-09-04T12:00:00Z|abc", "utf8").toString("base64url")],
    ["a zero id", Buffer.from("2026-09-04T12:00:00Z|0", "utf8").toString("base64url")],
    ["a negative id", Buffer.from("2026-09-04T12:00:00Z|-3", "utf8").toString("base64url")],
    ["a fractional id", Buffer.from("2026-09-04T12:00:00Z|3.5", "utf8").toString("base64url")],
    ["an unparseable date", Buffer.from("never|3", "utf8").toString("base64url")],
    ["a missing separator", Buffer.from("2026-09-04T12:00:00Z3", "utf8").toString("base64url")],
    ["an over-long token", "A".repeat(500)],
  ])("refuses %s and restarts the feed", (_label, value) => {
    // null means "start from the top", which is the right answer for a
    // navigation token that arrived truncated or hand-edited. Throwing would
    // turn a mangled URL into a 500; ignoring the WHERE clause would re-serve
    // page one as page nine.
    expect(decodeFeedCursor(value)).toBeNull();
  });

  it("splits on the LAST separator, so an id is never mistaken for part of the date", () => {
    // Defensive: no ISO timestamp contains "|", so this can only arise from a
    // hand-built token. Splitting on the FIRST separator would read the id out
    // of the middle of the string; splitting on the last one rejects the token
    // cleanly instead, because the remaining prefix is not a date.
    const handBuilt = Buffer.from("2026-09-04T12:00:00Z|junk|9", "utf8").toString("base64url");
    expect(decodeFeedCursor(handBuilt)).toBeNull();
  });
});

// The row-comparison predicate the query uses:
//   (COALESCE(published_at, fetched_at), id) < (cursor.sortAt, cursor.id)
// over ORDER BY ... DESC, id DESC.
function afterCursor(row: { sortAt: string; id: number }, cursor: { sortAt: string; id: number }): boolean {
  const a = Date.parse(row.sortAt);
  const b = Date.parse(cursor.sortAt);
  if (a !== b) return a < b;
  return row.id < cursor.id;
}

describe("the ordering predicate", () => {
  const T = "2026-09-04T12:00:00.000Z";
  const EARLIER = "2026-09-04T11:00:00.000Z";
  const LATER = "2026-09-04T13:00:00.000Z";

  it("excludes the cursor row itself", () => {
    expect(afterCursor({ sortAt: T, id: 100 }, { sortAt: T, id: 100 })).toBe(false);
  });

  it("includes an older row", () => {
    expect(afterCursor({ sortAt: EARLIER, id: 999 }, { sortAt: T, id: 100 })).toBe(true);
  });

  it("excludes a newer row", () => {
    expect(afterCursor({ sortAt: LATER, id: 1 }, { sortAt: T, id: 100 })).toBe(false);
  });

  it("breaks a timestamp tie on id, which is the whole reason for the tuple", () => {
    // Every row in this block shares one timestamp. Without the id term the
    // page boundary falls in an undefined place inside the tie.
    expect(afterCursor({ sortAt: T, id: 99 }, { sortAt: T, id: 100 })).toBe(true);
    expect(afterCursor({ sortAt: T, id: 101 }, { sortAt: T, id: 100 })).toBe(false);
  });

  it("pages a block of tied timestamps with no duplicate and no omission", () => {
    // 300 rows sharing one second, paged 50 at a time.
    const rows = Array.from({ length: 300 }, (_, i) => ({ sortAt: T, id: 1000 - i }));
    const seen: number[] = [];
    let cursor: { sortAt: string; id: number } | null = null;
    for (let page = 0; page < 10; page++) {
      const available = rows.filter((r) => (cursor ? afterCursor(r, cursor) : true));
      const slice = available.slice(0, 50);
      if (slice.length === 0) break;
      seen.push(...slice.map((r) => r.id));
      cursor = { sortAt: slice[slice.length - 1]!.sortAt, id: slice[slice.length - 1]!.id };
    }
    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);
    expect(seen).toEqual(rows.map((r) => r.id));
  });

  it("proves OFFSET paging is unsafe here, so the tuple is not decoration", () => {
    // Same 300 tied rows. Every one of them sorts equal under ORDER BY the
    // timestamp alone, so the database may legally return them in any order,
    // and it is free to choose a different one for the second query. Rotating
    // the set by 25 is one such legal reordering.
    const rows = Array.from({ length: 300 }, (_, i) => ({ sortAt: T, id: 1000 - i }));
    const reordered = [...rows.slice(-25), ...rows.slice(0, -25)];

    const offsetPage1 = rows.slice(0, 50).map((r) => r.id);
    const offsetPage2 = reordered.slice(50, 100).map((r) => r.id);

    // A reader sees these rows twice...
    const duplicated = offsetPage1.filter((id) => offsetPage2.includes(id));
    expect(duplicated.length).toBeGreaterThan(0);

    // ...and these rows not at all, which is the half nobody notices.
    const served = new Set([...offsetPage1, ...offsetPage2]);
    const missed = rows.slice(0, 100).filter((r) => !served.has(r.id));
    expect(missed.length).toBeGreaterThan(0);
  });
});
