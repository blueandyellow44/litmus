import { describe, it, expect } from "vitest";
import { stripHtml } from "./extractor.js";

// 2026-10-09, Max's phone: "Ben Shapiro&#8217;s latest foray" reached a card as
// written, because stripHtml decoded only five named entities.
describe("stripHtml entities", () => {
  it("decodes numeric and named entities in body text", () => {
    expect(stripHtml("<p>Ben Shapiro&#8217;s film &amp; the &#039;tree&#039; &ldquo;raid&rdquo;</p>")).toBe(
      "Ben Shapiro’s film & the 'tree' “raid”",
    );
  });
  it("turns a no-break space into an ordinary collapsed space", () => {
    expect(stripHtml("<p>a&nbsp;&nbsp; b</p>")).toBe("a b");
  });
  it("decodes once, so an escaped entity stays an entity", () => {
    expect(stripHtml("<p>write &amp;#039; for an apostrophe</p>")).toBe("write &#039; for an apostrophe");
  });
  it("leaves unknown entities as written", () => {
    expect(stripHtml("<p>AT&T &bogus;</p>")).toBe("AT&T &bogus;");
  });
});
