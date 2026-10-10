import { describe, expect, it } from "vitest";
import { ampMatchesArticle, ampUrl } from "./extractor.js";

// The Hill answers a non-browser request for an article with a 403 but serves
// its AMP page (2026-09-26); the AMP form is the publisher's own "<url>/amp/".
describe("ampUrl", () => {
  it("appends /amp/ to an article path, with or without a trailing slash", () => {
    expect(ampUrl("https://thehill.com/media/6112790-trump-cnn-barred-air-force-one/")).toBe("https://thehill.com/media/6112790-trump-cnn-barred-air-force-one/amp/");
    expect(ampUrl("https://thehill.com/homenews/6113000-trump-iran")).toBe("https://thehill.com/homenews/6113000-trump-iran/amp/");
  });
  it("drops query strings and never doubles an AMP path", () => {
    expect(ampUrl("https://example.test/a/b?utm=1#top")).toBe("https://example.test/a/b/amp/");
    expect(ampUrl("https://example.test/a/b/amp/")).toBeNull();
  });
  it("returns null for something that is not a URL", () => {
    expect(ampUrl("not a url")).toBeNull();
  });
});

// The Washington Examiner answers "<article>/amp/" with an unrelated old story
// (2026-09-26); only an AMP page whose canonical link is the article counts.
describe("ampMatchesArticle", () => {
  const article = "https://thehill.com/media/6112790-trump-cnn-barred-air-force-one/";
  it("accepts an AMP page whose canonical link is the article", () => {
    expect(ampMatchesArticle(article, "https://thehill.com/media/6112790-trump-cnn-barred-air-force-one/")).toBe(true);
    expect(ampMatchesArticle(article, "https://thehill.com/media/6112790-trump-cnn-barred-air-force-one")).toBe(true);
  });
  it("rejects a different story, and a page with no canonical link", () => {
    expect(ampMatchesArticle("https://www.washingtonexaminer.com/news/crime/4744297/four-americans-dead", "https://www.washingtonexaminer.com/sports/amp-energy-500")).toBe(false);
    expect(ampMatchesArticle(article, null)).toBe(false);
  });
});
