// Shared domain types for Litmus. Single source of truth — repos, pipelines,
// and API handlers all import from here.

export type Lean = "left" | "center-left" | "center" | "center-right" | "right";
export type SourceType = "wire" | "newspaper" | "magazine" | "broadcast" | "digital-native";
export type PaywallStatus = "free" | "metered" | "hard";
export type ExtractionStatus = "full" | "partial" | "failed";
// Where an article's usable text came from. Nullable on legacy rows.
// "archive" was a third value until the Internet Archive fallback was removed
// on 2026-09-13. Production never wrote it; a local database from before then
// may still hold such rows, which are history, not a live source.
export type ExtractedVia = "publisher" | "feed";
// Kept in sync with REGISTERS in scoring/composite.ts. Declared here because a
// source can pin one, and types.ts is the domain vocabulary the repos speak.
export type Register = "news" | "sports" | "culture" | "feature";

export interface Source {
  id: number;
  name: string;
  // One identity per outlet across its sister feeds, so a story counts a
  // newsroom once. Derived from the name when a source does not pin one; see
  // ingestion/outletKey.ts.
  outletKey: string;
  rssUrl: string;
  lean: Lean;
  type: SourceType;
  paywallStatus: PaywallStatus;
  reliability: number; // 1-5
  prominence: number; // 1=default, 2=major national, 3=wire/front-page desk
  enabled: boolean;
  // When set, every article from this source scores in this register and the
  // scorer's own guess is overridden. NULL for a mixed outlet.
  register: Register | null;
}

export interface NewSource {
  name: string;
  // Optional: seed.json pins one per feed, and the derivation covers anything
  // that does not.
  outletKey?: string;
  rssUrl: string;
  lean: Lean;
  type: SourceType;
  paywallStatus: PaywallStatus;
  reliability: number;
  enabled?: boolean;
  prominence?: number;
  register?: Register | null;
}

export interface Article {
  id: number;
  sourceId: number;
  url: string;
  title: string;
  author: string | null;
  publishedAt: Date | null;
  rawText: string;
  wordCount: number;
  extractionStatus: ExtractionStatus;
  paywallFlag: boolean;
  contentHash: string;
  extractedVia: ExtractedVia | null;
  // The original this row is a copy of (wire syndication across outlets), or
  // null when the row is its own telling. See ingestion/articleRow.ts.
  syndicatedOfArticleId: number | null;
  fetchedAt: Date;
  // Denormalised from the source at query time. Null means "no pin, scorer decides".
  sourceRegister?: Register | null;
  // True when rawText above is the furniture filter's story text (migration 0006).
  cleaned?: boolean;
}

export interface NewArticle {
  sourceId: number;
  url: string;
  title: string;
  author: string | null;
  publishedAt: Date | null;
  rawText: string;
  wordCount: number;
  extractionStatus: ExtractionStatus;
  paywallFlag: boolean;
  contentHash: string;
  // Null only on a headline-only row, which has no text and so no text source.
  extractedVia: ExtractedVia | null;
  syndicatedOfArticleId: number | null;
}

// RSS poll output before extraction has run
export interface RawFeedItem {
  sourceId: number;
  url: string;
  title: string;
  author: string | null;
  publishedAt: Date | null;
  feedSnippet: string; // whatever the RSS feed gave us in <description>/<content:encoded>
}
