// Public API response shapes. The frontend imports these (manually copied,
// no shared package — see docs/architecture.md decision #1).

import type { Lean, SourceType, PaywallStatus, ExtractionStatus } from "../types.js";
import type { Label, PHMarker } from "../scoring/calibration.js";
import type { DimensionRationale } from "../scoring/phScorer.js";

export type { PHMarker } from "../scoring/calibration.js";

export interface SourceDTO {
  id: number;
  name: string;
  rssUrl: string;
  lean: Lean;
  type: SourceType;
  paywallStatus: PaywallStatus;
  reliability: number;
  enabled: boolean;
}

export interface ScoreDTO {
  headline: number;
  language: number;
  sourcing: number;
  fallacies: number;
  structure: number;
  composite: number;
  label: Label;
  rationale: DimensionRationale;
  markers: PHMarker[];
  excerptIndices: number[];
  politicalLean: number | null; // -100..+100, independent of P/H
  articleSummary: string; // neutral "just the facts"
  section: string | null;
  modelUsed: string;
  scoredAt: string; // ISO
}

// The chosen 3-paragraph excerpt with the markers that fall inside it. Prebuilt
// server-side so the flat feed can expand a row with no extra request.
export interface ArticleExcerptDTO {
  paragraphs: string[];
  markers: PHMarker[];
}

export interface TranslationDTO {
  translatedText: string;
  removedFallacies: string[];
  modelUsed: string;
  generatedAt: string; // ISO
}

export interface ArticleSummaryDTO {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceLean: Lean;
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null; // ISO
  wordCount: number;
  extractionStatus: ExtractionStatus;
  paywallFlag: boolean;
  fetchedAt: string; // ISO
  score: ScoreDTO | null;
  excerpt: ArticleExcerptDTO | null;
}

export interface ArticleDetailDTO extends ArticleSummaryDTO {
  rawText: string;
  translation: TranslationDTO | null;
}

// GET /api/articles — one page of the feed.
export interface ArticlePageDTO {
  articles: ArticleSummaryDTO[];
  // Every eligible article in the edition, not the page size. The feed's
  // "showing X of Y" reads Y from here.
  total: number;
  // Pass back as ?cursor= for the next page. null means this was the last page.
  nextCursor: string | null;
}

export interface ApiError {
  error: string;
  detail?: string;
}

// ── Section pages (GET /api/sections, GET /api/sections/:slug) ──

// The most-covered cluster within one section — "what this desk is chasing".
export interface TrendingClusterDTO {
  clusterId: number;
  topic: string;
  summary: string;
  articleCount: number;
  // Gap between the calmest and hottest telling. The front page picks its lead
  // by this rather than by section order, so it never opens on a story where
  // every outlet agreed and there is nothing to compare.
  phSpread: number;
  topProminence: number;
}

export interface SectionSummaryDTO {
  slug: string; // lowercase section name, e.g. "politics"
  name: string; // canonical name, e.g. "Politics"
  trending: TrendingClusterDTO | null; // null = no multi-outlet cluster yet
  articleCount: number; // total scored articles in this section (drives the digest)
}

export interface SectionArticleDTO {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceLean: Lean;
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null; // ISO
  politicalLean: number | null; // -100..+100
  composite: number | null;
  label: string | null;
  articleSummary: string; // may be ""
  rationale: DimensionRationale | null; // why it scored what it did (the reading)
  excerpt: ArticleExcerptDTO | null;
}

export interface SectionPageDTO {
  section: string; // canonical name, e.g. "Politics"
  trending: TrendingClusterDTO | null;
  // The trending story's coverage: how each outlet told the ONE lead story.
  // Empty when the section has no multi-outlet cluster. Drives the Map + spread.
  articles: SectionArticleDTO[];
  // Every scored article in the section, newest first. The section page renders
  // the lead spread from `articles`, then lists the rest of the desk from here.
  // This is what fills a section that has coverage but no single trending story.
  sectionArticles: SectionArticleDTO[];
}
