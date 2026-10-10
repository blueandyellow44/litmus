import { describe, it, expect } from "vitest";
import { itemUrl, toRawFeedItem } from "./feedItem.js";

// The Atom case is the one that cost real coverage: jacobin.com/feed returns
// twenty fresh entries a day, every one of which was dropped because Atom puts
// the article URL in <id>, not <link>. The poller counted none of them, so the
// ledger read "feedItems: 0" — identical to a feed that published nothing.
describe("itemUrl", () => {
  it("takes link when an RSS entry has one", () => {
    expect(itemUrl({ link: "https://example.com/a" })).toBe("https://example.com/a");
  });

  it("falls back to id for Atom entries (the Jacobin case)", () => {
    expect(
      itemUrl({ id: "https://jacobin.com/2026/09/michigan-el-sayed-rogers-centrists" }),
    ).toBe("https://jacobin.com/2026/09/michigan-el-sayed-rogers-centrists");
  });

  it("falls back to guid when it is a permalink", () => {
    expect(itemUrl({ guid: "https://example.com/p/1" })).toBe("https://example.com/p/1");
  });

  it("ignores non-URL identifiers rather than storing them as links", () => {
    expect(itemUrl({ id: "tag:example.com,2026:post-1" })).toBeNull();
    expect(itemUrl({ guid: "12345" })).toBeNull();
    expect(itemUrl({})).toBeNull();
  });

  it("prefers link over id when both are present", () => {
    expect(itemUrl({ link: "https://example.com/real", id: "https://example.com/id" })).toBe(
      "https://example.com/real",
    );
  });
});

describe("toRawFeedItem", () => {
  it("decodes HTML entities a feed left in the title", () => {
    // Newsweek and The Verge, 2026-10-08 edition, as Max's phone showed them.
    const r = toRawFeedItem({ title: "&#039;Grandmother Tree&#039; Toppled", link: "https://example.com/t" }, 1);
    const v = toRawFeedItem({ title: "Sam Altman says \u2018some bad things&#8217; will happen", link: "https://example.com/v" }, 1);
    expect("item" in r && r.item.title).toBe("'Grandmother Tree' Toppled");
    expect("item" in v && v.item.title).toBe("Sam Altman says \u2018some bad things\u2019 will happen");
  });

  it("drops a title that is only an encoded space", () => {
    expect(toRawFeedItem({ title: "&nbsp;", link: "https://example.com/x" }, 1)).toEqual({ drop: "no-title" });
  });

  it("builds an item from an Atom entry that has no link field", () => {
    const r = toRawFeedItem(
      {
        title: "  Centrist Democrats Are Trying to Throw the Michigan Race  ",
        id: "https://jacobin.com/2026/09/michigan",
        isoDate: "2026-09-01T19:57:45.230Z",
        summary: "short",
        content: "a much longer body than the summary",
      },
      38,
    );
    expect("item" in r).toBe(true);
    if (!("item" in r)) return;
    expect(r.item.url).toBe("https://jacobin.com/2026/09/michigan");
    expect(r.item.title).toBe("Centrist Democrats Are Trying to Throw the Michigan Race");
    expect(r.item.sourceId).toBe(38);
    expect(r.item.feedSnippet).toBe("a much longer body than the summary");
    expect(r.item.publishedAt?.toISOString()).toBe("2026-09-01T19:57:45.230Z");
  });

  it("reports WHY an entry was dropped instead of vanishing it", () => {
    expect(toRawFeedItem({ title: "no url here" }, 1)).toEqual({ drop: "no-url" });
    expect(toRawFeedItem({ link: "https://example.com/x" }, 1)).toEqual({ drop: "no-title" });
    expect(toRawFeedItem({ link: "https://example.com/x", title: "   " }, 1)).toEqual({
      drop: "no-title",
    });
  });

  it("keeps a null date rather than inventing one", () => {
    const r = toRawFeedItem({ title: "t", link: "https://example.com/x" }, 1);
    expect("item" in r && r.item.publishedAt).toBeNull();
  });
});
