// Recognises shopping content so it is skipped before anything is paid for.
//
// Max, 2026-10-10: "Wait... it's scoring ads???" and "it recognizes an ad and
// skips it". Outlets publish affiliate deal roundups in the same feeds as their
// news ("7 Best Prime Day Kindle Deals", "Apple AirPods are $70 off for Prime
// Day"). The 2026-10-08 edition grouped 61 of them into a story, scored them,
// and the opinion floor read them as Mixed Signals. The front page never
// showed them (it is politics only), but they were paid for and they sat in
// the database beside real scores.
//
// The rules are deliberately narrow, because "deal" is also a news word
// ("Trump rejects Iran deal", "$30 billion tariff deal"). A title must look
// like shopping, not merely mention a deal. Measured on the 2026-10-08
// snapshot: all 61 shopping pieces caught, 0 of the other 2,620
// articles. What this misses, the story ledger's not_news rule is the second
// chance to set aside (stories/prompts.ts).
//
// Pure: no network, no database. Returns which rule matched, for the log.

export type CommerceRule = "shopping-url" | "sale-event" | "deal-roundup" | "sale-slug";

// The outlet's own shopping section.
const SHOPPING_PATH = /\/(shopping|deals|coupons|commerce|gift-guides?)(\/|$)|\/select\//i;
// A retail sale event by name.
const SALE_EVENT = /\b(prime (big deals? )?days?|prime big deals? days?|black friday|cyber monday|big spring sale)\b/i;
// A price cut on a product.
const PRICE_CUT =
  /(\b\d{1,3}\s?(%|percent) off\b|\$\d[\d,]*\+? off\b|\bsave up to\b|\bup to \$?\d[\d,]*%? off\b|\blowest price\b|\b(is|are|for) (just|only|under) \$\d|\bhalf off\b|\bon sale\b)/i;
// A list of deals: "Best ... Deals", "24 Best Prime Day Deals Under $100",
// "deals worth shopping".
const DEAL_ROUNDUP =
  /(\bbest\b.*\bdeals\b|\bdeals\b.*\b(to shop|worth (shopping|snagging|buying)|under \$\d)|\b\d+\+? (best )?.*\bdeals\b)/i;
const DEAL_WORD = /\bdeals?\b/i;
// A sale event in the address together with "deal" or a live tracker.
const SALE_SLUG_EVENT = /prime-day|black-friday|cyber-monday/i;
const SALE_SLUG_KIND = /deals?|tracker/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

export function commerceRule(title: string, url: string): CommerceRule | null {
  const path = pathOf(url);
  if (SHOPPING_PATH.test(path)) return "shopping-url";
  if (SALE_EVENT.test(title) && (DEAL_WORD.test(title) || PRICE_CUT.test(title))) return "sale-event";
  if (DEAL_ROUNDUP.test(title)) return "deal-roundup";
  if (SALE_SLUG_EVENT.test(path) && SALE_SLUG_KIND.test(path)) return "sale-slug";
  return null;
}
