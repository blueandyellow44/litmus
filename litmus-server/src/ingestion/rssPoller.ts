import Parser from "rss-parser";
import type { Source, RawFeedItem } from "../types.js";
import { toRawFeedItem, type ItemDropReason } from "./feedItem.js";
import { logger } from "../lib/logger.js";
import { safeGet, PUBLIC_ONLY, type FetchPolicy } from "../lib/safeFetch.js";

// Feeds are fetched by lib/safeFetch.ts and only PARSED by rss-parser.
//
// rss-parser used to do its own fetching, which caused three separate problems:
//
// - It went through Node's global keep-alive agents, which held the ingest
//   process open until the job timeout on half of all runs (2026-08-10). The
//   fix pinned keep-alive-off agents; safeFetch keeps keep-alive off.
// - Pinning an agent by the ORIGINAL scheme broke every feed that redirects
//   across protocols: Fox News and both BBC News feeds contributed zero
//   articles from 2026-08-10 until a second resolver pass was added. safeFetch
//   follows redirects itself, so an http -> https feed just works.
// - It would fetch any address a feed URL or a redirect pointed at, and read a
//   body of any size (security baseline, 2026-10-07). safeFetch allows public
//   destinations only, re-checks every redirect, and bounds the body.
//
// Request headers, the redirect limit and the charset rule are rss-parser's
// own, kept so publishers see the same request they always have.
const parser = new Parser();

const FEED_HEADERS = { "User-Agent": "Litmus/0.1 (RSS reader)", Accept: "application/rss+xml" };
// rss-parser's default.
const FEED_MAX_REDIRECTS = 5;
// The largest feed in the roster measured 1.04 MB (all 66 polled, 2026-10-07);
// this is a ceiling on memory, not a size any publisher serves.
export const FEED_MAX_BYTES = 20 * 1024 * 1024;
// Without a deadline a feed that accepts a connection and then stalls would hang
// the whole sequential ingest — the class of failure the socket-leak work was
// about. Covers every redirect, not each hop.
export const FEED_TIMEOUT_MS = 15000;

// rss-parser's rule for choosing a text encoding from Content-Type
// (lib/utils.js getEncodingFromContentType), unchanged.
const SUPPORTED_ENCODINGS = ["ascii", "utf8", "utf16le", "ucs2", "base64", "latin1", "binary", "hex"] as const;
const ENCODING_ALIASES: Record<string, string> = { "utf-8": "utf8", "iso-8859-1": "latin1" };
function encodingFor(contentType: string | undefined): BufferEncoding {
  const match = (contentType ?? "").match(/(encoding|charset)\s*=\s*(\S+)/);
  let encoding = ((match ?? [])[2] ?? "").toLowerCase();
  encoding = ENCODING_ALIASES[encoding] ?? encoding;
  return (SUPPORTED_ENCODINGS as readonly string[]).includes(encoding) ? (encoding as BufferEncoding) : "utf8";
}

async function fetchFeed(url: string, policy: FetchPolicy): Promise<{ feed: Parser.Output<Record<string, unknown>>; finalUrl: string }> {
  const res = await safeGet(url, {
    headers: FEED_HEADERS,
    maxRedirects: FEED_MAX_REDIRECTS,
    maxBytes: FEED_MAX_BYTES,
    timeoutMs: FEED_TIMEOUT_MS,
    policy,
  });
  if (res.status >= 300) throw new Error("Status code " + res.status);
  const xml = res.body.toString(encodingFor(res.headers["content-type"]));
  return { feed: await parser.parseString(xml), finalUrl: res.url };
}

// Polls a single source's RSS feed and returns the items as RawFeedItems.
// Does not touch the database — that's runIngest's job.
export async function pollFeed(source: Source, policy: FetchPolicy = PUBLIC_ONLY): Promise<RawFeedItem[]> {
  const { items } = await pollFeedDetailed(source, policy);
  return items;
}

export interface PollResult {
  items: RawFeedItem[];
  entries: number;
  dropped: Record<ItemDropReason, number>;
  /** Set when the feed could not be read at all — distinct from a feed with no entries. */
  error: string | null;
  /** Set when the configured URL redirects elsewhere; the seed should be canonicalised. */
  resolvedUrl: string | null;
}

export async function pollFeedDetailed(source: Source, policy: FetchPolicy = PUBLIC_ONLY): Promise<PollResult> {
  const dropped: Record<ItemDropReason, number> = { "no-url": 0, "no-title": 0 };
  let feed;
  let resolvedUrl: string | null = null;

  try {
    const fetched = await fetchFeed(source.rssUrl, policy);
    feed = fetched.feed;
    // Only a scheme change is reported, as before: that is the case the seed
    // must be corrected for.
    if (new URL(fetched.finalUrl).protocol !== new URL(source.rssUrl).protocol) {
      resolvedUrl = fetched.finalUrl;
      logger.warn("feed redirects across protocols; update its URL in sources/seed.json", {
        sourceId: source.id,
        name: source.name,
        configured: source.rssUrl,
        resolved: resolvedUrl,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("rss poll failed", { sourceId: source.id, name: source.name, err: msg });
    return { items: [], entries: 0, dropped, error: msg, resolvedUrl };
  }

  const items: RawFeedItem[] = [];
  for (const entry of feed.items) {
    const r = toRawFeedItem(entry, source.id);
    if ("drop" in r) {
      dropped[r.drop]++;
      continue;
    }
    items.push(r.item);
  }

  // An entry that parsed but produced nothing used to disappear without trace.
  // Saying so is what separates "this feed published nothing" from "we could not
  // read what it published".
  if (dropped["no-url"] > 0 || dropped["no-title"] > 0) {
    logger.warn("feed entries dropped before ingest", {
      sourceId: source.id,
      name: source.name,
      entries: feed.items.length,
      ...dropped,
    });
  }

  return { items, entries: feed.items.length, dropped, error: null, resolvedUrl };
}
