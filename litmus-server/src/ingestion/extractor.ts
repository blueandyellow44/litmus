import { extractFromHtml } from "@extractus/article-extractor";
import { getCharset } from "@extractus/article-extractor/src/utils/html.js";
import { decodeEntities } from "../lib/entities.js";
import { logger } from "../lib/logger.js";
import { safeGet, PUBLIC_ONLY, type FetchPolicy } from "../lib/safeFetch.js";
import type { ExtractedVia } from "../types.js";

export interface ExtractedContent {
  text: string;
  wordCount: number;
  // Where the usable text came from. "publisher" = the live page, "feed" = the
  // RSS snippet fallback (often a one-sentence stub for paywalled sources).
  // There is deliberately no third source: text comes from the publisher or
  // the publisher's own feed, never from a copy hosted by someone else.
  via: ExtractedVia;
}

// Below this an extract is too thin to score. Matches the paywall "partial"
// threshold in paywallDetector.
const MIN_FULL_WORDS = 200;

// Strip HTML tags to plain text WHILE preserving paragraph boundaries. Block
// closers and <br> become "\n\n" BEFORE tags are dropped; horizontal whitespace
// is collapsed but newlines are not. Downstream code splits on /\n{2,}/ — see
// lib/paragraphs.ts. This structure is load-bearing for the excerpt + highlight
// features, so do not go back to a blanket \s+ collapse.
// Exported for tests.
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n\n")
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|section|article)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    // Every entity feeds emit, numeric ones included ("Shapiro&#8217;s" reached
    // the page as written, 2026-10-09). A decoded no-break space is collapsed
    // with the other spaces below.
    .replace(/&[#a-z0-9]+;/gi, (m) => decodeEntities(m))
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ") // collapse spaces/tabs, keep newlines
    .replace(/ *\n */g, "\n") // trim spaces hugging newlines
    .replace(/\n{2,}/g, "\n\n") // normalize any run of breaks to one paragraph break
    .trim();
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// @extractus applies no timeout of its own. A server that accepts the
// connection and then never responds leaves this call pending forever, and a
// hang is not an exception, so the catch below never fires. runIngest processes
// sources and items strictly sequentially, so a single such URL freezes the
// entire run — which is how a cloud refresh burned to its job timeout having
// written nothing after its last article. Every fetch is bounded.
const FETCH_TIMEOUT_MS = 15_000;

// Backstop for a stall that happens outside the abortable fetch (parsing, DNS
// in some runtimes). The timer is unref'd so it can never hold the process open.
function withTimeout<T>(work: Promise<T>, ms: number, url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`extraction timed out after ${ms}ms: ${url}`)), ms);
    timer.unref?.();
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Article pages are fetched by lib/safeFetch.ts and only PARSED by @extractus.
// @extractus used to fetch the URL itself, wherever a feed entry or a redirect
// pointed, with no size limit (security baseline, 2026-10-07). The request it
// made is kept: its browser User-Agent, node-fetch's Accept headers and its
// limit of 20 redirects. So is what it did with the bytes (lib main.js
// `extract`): a status of 400 or more is a failure, the charset comes from the
// page's own meta tag, and the page is parsed against the URL that was asked
// for, which is what the AMP canonical check compares against.
const ARTICLE_HEADERS = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0",
  Accept: "*/*",
  "Accept-Encoding": "gzip,deflate",
};
const ARTICLE_MAX_REDIRECTS = 20;
// A ceiling on memory. 40 live article pages, one per feed, read identically
// under it and under the old unbounded fetch (2026-10-07).
export const ARTICLE_MAX_BYTES = 20 * 1024 * 1024;

async function fetchHtml(url: string, policy: FetchPolicy): Promise<string | null> {
  const res = await safeGet(url, {
    headers: ARTICLE_HEADERS,
    maxRedirects: ARTICLE_MAX_REDIRECTS,
    maxBytes: ARTICLE_MAX_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    policy,
  });
  if (res.status >= 400) throw new Error(`Request failed with error code ${res.status}`);
  const text = res.body.toString().trim();
  if (!text) return null;
  return new TextDecoder(getCharset(text)).decode(res.body);
}

// Fetch and parse one page, returning plain text, or null if nothing usable.
async function extractFromUrl(
  url: string,
  policy: FetchPolicy,
): Promise<{ text: string; wordCount: number; canonical: string | null } | null> {
  try {
    const result = await withTimeout(
      fetchHtml(url, policy).then((html) => (html ? extractFromHtml(html, url) : null)),
      FETCH_TIMEOUT_MS + 5_000,
      url,
    );
    const html = result?.content;
    if (html) {
      const text = stripHtml(html);
      if (text.length > 0) return { text, wordCount: countWords(text), canonical: result?.url ?? null };
    }
  } catch (err) {
    logger.debug("extractor failed", {
      url,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

// The publisher's own AMP page, the usual "<url>/amp/" form. Some newsrooms
// (The Hill, 2026-09-26) answer a non-browser request for the article with a
// 403 but serve the same article's AMP page, 322 to 1,624 words in a probe of
// five pieces. Same publisher, same article, not a copy hosted elsewhere.
export function ampUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (/\/amp\/?$/.test(u.pathname)) return null;
    u.pathname = `${u.pathname.replace(/\/$/, "")}/amp/`;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function articlePath(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/amp\/?$/, "").replace(/\/$/, "").toLowerCase();
  } catch {
    return null;
  }
}

// An AMP page counts only if it says it is this article: its canonical link
// points back to the same path. Found 2026-09-26: the Washington Examiner
// answers "<article>/amp/" with an unrelated old NASCAR story, which would
// have been stored and scored as the article. No canonical link, no trust.
export function ampMatchesArticle(articleUrl: string, ampCanonical: string | null): boolean {
  if (!ampCanonical) return false;
  const want = articlePath(articleUrl);
  return want !== null && want !== "" && articlePath(ampCanonical) === want;
}

// Pull the article body from the publisher. Three candidates, all the
// publisher's own: the article page, its AMP page (tried only when the page is
// thin or refused), and the publisher's feed text. The longest wins
// (2026-09-26: the Washington Examiner's page yields 127 to 163 words while its
// own feed carries the whole article, 420 to 490). Never a copy hosted by
// someone else; the Internet Archive fallback was removed on 2026-09-13, see
// the excerpt policy.
export async function extractArticle(
  url: string,
  feedSnippetHtml: string,
  policy: FetchPolicy = PUBLIC_ONLY,
): Promise<ExtractedContent> {
  let page = await extractFromUrl(url, policy);

  if (!page || page.wordCount < MIN_FULL_WORDS) {
    const amp = ampUrl(url);
    const fromAmp = amp ? await extractFromUrl(amp, policy) : null;
    if (fromAmp && fromAmp.wordCount > (page?.wordCount ?? 0) && ampMatchesArticle(url, fromAmp.canonical)) page = fromAmp;
    else if (fromAmp) logger.debug("amp page rejected", { url, amp, canonical: fromAmp.canonical });
  }

  const feedText = stripHtml(feedSnippetHtml);
  const feed = { text: feedText, wordCount: countWords(feedText) };

  if (page && page.wordCount >= feed.wordCount && page.wordCount > 0) return { text: page.text, wordCount: page.wordCount, via: "publisher" };
  return { ...feed, via: "feed" };
}
