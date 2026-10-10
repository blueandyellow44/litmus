// Turning one parsed feed entry into a RawFeedItem, and saying why when it
// cannot be done. Pure — no network, no database — so the rules below are
// testable against real feed shapes.

import { decodeEntities } from "../lib/entities.js";
import type { RawFeedItem } from "../types.js";

// Why an entry did not become an article. The poller counts these rather than
// dropping entries silently: an item lost with no reason is indistinguishable
// from a feed that published nothing, which is how Jacobin lost twenty fresh
// articles a day without anyone seeing a single error.
export type ItemDropReason = "no-url" | "no-title";

export interface ParsedEntry {
  title?: string;
  link?: string;
  id?: string;
  guid?: string;
  creator?: string;
  author?: string;
  isoDate?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
  ["content:encoded"]?: string;
}

function pickLongest(...candidates: Array<string | undefined | null>): string {
  let best = "";
  for (const c of candidates) {
    if (typeof c === "string" && c.length > best.length) best = c;
  }
  return best;
}

// Atom entries carry their URL in <link href> (which rss-parser surfaces as
// `link` for some feeds and not others) or in <id>, which for every Atom feed in
// this roster is the canonical article URL. RSS entries use `link`, with `guid`
// as a permalink fallback. Taking the first field that looks like an http(s) URL
// handles both without caring which dialect the publisher chose.
export function itemUrl(entry: ParsedEntry): string | null {
  for (const candidate of [entry.link, entry.id, entry.guid]) {
    if (typeof candidate !== "string") continue;
    const v = candidate.trim();
    if (v.startsWith("http://") || v.startsWith("https://")) return v;
  }
  return null;
}

export function toRawFeedItem(
  entry: ParsedEntry,
  sourceId: number,
): { item: RawFeedItem } | { drop: ItemDropReason } {
  const url = itemUrl(entry);
  if (!url) return { drop: "no-url" };
  const title = entry.title ? decodeEntities(entry.title).trim() : "";
  if (!title) return { drop: "no-title" };

  return {
    item: {
      sourceId,
      url,
      title,
      author: entry.creator ?? entry.author ?? null,
      publishedAt: entry.isoDate ? new Date(entry.isoDate) : null,
      // Feeds use either content:encoded (full) or description (snippet).
      // Take whichever is longer — the most useful starting point for a
      // paywalled source.
      feedSnippet: pickLongest(entry["content:encoded"], entry.content, entry.contentSnippet, entry.summary),
    },
  };
}
