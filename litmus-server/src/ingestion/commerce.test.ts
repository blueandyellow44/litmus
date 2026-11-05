import { describe, it, expect } from "vitest";
import { commerceRule } from "./commerce.js";
import { toRawFeedItem } from "./feedItem.js";

// Real titles and addresses from the 2026-10-08 edition, where 61 shopping
// pieces were grouped into a story and scored.
const SHOPPING: Array<[string, string]> = [
  ["7 Best Prime Day Kindle Deals (2026): Save Up to $150", "https://www.wired.com/story/best-kindle-prime-day-deals-10-06-2026/"],
  ["Apple AirPods are $70 off for Prime Day — grab them before they sell out", "https://www.nbcnews.com/select/shopping/amazon-october-prime-day-2026-airpods-deal"],
  ["These Prime Big Deal Day finds are under $100 — and totally underrated", "https://nypost.com/shopping/amazon-prime-big-deal-days-deals-under-100-october"],
  ["The New Kindle Is Down to $100 for Amazon Prime Big Deals Day", "https://variety.com/2026/shopping/news/prime-day-2026-kindle-deals-shop-online"],
  ["117 Best Prime Day Deals We’re Shopping This October (2026)", "https://www.wired.com/story/absolute-best-amazon-prime-day-deals-10-07-2026/"],
  ["Amazon’s last-gen Kindle Paperwhite is 30 percent off", "https://www.theverge.com/gadgets/1006020/amazon-kindle-paperwhite-prime-day-deal-sale"],
  ["We’re Tracking October Prime Day Live (2026)", "https://www.wired.com/live/amazon-prime-day-live-tracker-october-06-2026/"],
  ["The Best Anti–Prime Day Deals for Amazon Haters", "https://www.wired.com/story/anti-prime-day-deals-october-2026/"],
  ["Everything we bought during October Prime Day (so far)", "https://www.nbcnews.com/select/shopping/editor-favorites-october-prime-day-2026"],
];

// "Deal" is a news word. Every one of these was a real headline in the same
// edition and must still be ingested.
const NEWS: Array<[string, string]> = [
  ["Trump Rejects Iran Deal to Reopen Strait of Hormuz", "https://www.newsweek.com/trump-rejects-iran-deal-hormuz"],
  ["U.S., China reach $30 billion tariff deal after Trump-Xi summit", "https://www.axios.com/2026/10/07/us-china-tariff-deal"],
  ["Paramount closes historic $110B deal for Warner Bros. Discovery to create Skydance", "https://www.axios.com/2026/10/06/paramount-warner-deal"],
  ["Emmy Awards leave broadcast TV for Prime Video in 2027 under six-year deal", "https://www.cnbc.com/2026/10/07/emmy-awards-prime-video.html"],
  ["Trump administration announces Medicaid drug savings deals", "https://thehill.com/policy/healthcare/medicaid-drug-savings-deals/"],
  ["Google enters massive 3.6-GW power deal with Constellation Energy", "https://www.cnbc.com/2026/10/06/google-constellation-power-deal.html"],
  ["Senate tees up college sports bill aimed at regulating NIL deals", "https://www.cnbc.com/2026/10/05/senate-college-sports-nil.html"],
  ["Oil soars above $107 after Trump rejects Iran peace deal", "https://nypost.com/2026/10/06/business/oil-soars-above-107/"],
  // A sale event as a business story, with no shopping in the address.
  ["Amazon Prime Day sales growth slows as shoppers pull back", "https://www.cnbc.com/2026/10/08/amazon-prime-day-sales-growth-slows.html"],
];

describe("commerceRule", () => {
  it.each(SHOPPING)("skips shopping: %s", (title, url) => {
    expect(commerceRule(title, url)).not.toBeNull();
  });
  it.each(NEWS)("keeps news: %s", (title, url) => {
    expect(commerceRule(title, url)).toBeNull();
  });
  it("names the rule that matched, for the log", () => {
    expect(commerceRule("Anything", "https://nypost.com/shopping/x")).toBe("shopping-url");
    expect(commerceRule("Apple AirPods are $70 off for Prime Day", "https://example.com/a")).toBe("sale-event");
    expect(commerceRule("24 Best Laptop Deals Under $500", "https://example.com/b")).toBe("deal-roundup");
    expect(commerceRule("The mask is cheaper than ever", "https://example.com/story/mask-prime-day-deal")).toBe("sale-slug");
  });
  it("does not throw on an address it cannot parse", () => {
    expect(commerceRule("Senate passes the stopgap funding bill", "not a url")).toBeNull();
  });
});

describe("toRawFeedItem with shopping content", () => {
  it("drops a deals roundup with its own reason, so the poller can count it", () => {
    expect(toRawFeedItem({ title: "7 Best Prime Day Kindle Deals (2026)", link: "https://www.wired.com/story/best-kindle-prime-day-deals/" }, 1)).toEqual({ drop: "commerce" });
  });
  it("still builds an item for a news headline that says deal", () => {
    const r = toRawFeedItem({ title: "Trump Rejects Iran Deal", link: "https://example.com/iran" }, 1);
    expect("item" in r).toBe(true);
  });
});
