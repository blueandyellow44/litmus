// API response shapes — copied (manually) from litmus-server/src/api/types.ts.
// No shared package by design, see docs/architecture.md decision #1.
// If the server's DTOs change, update this file.

export type Lean = "left" | "center-left" | "center" | "center-right" | "right";
export type SourceType = "wire" | "newspaper" | "magazine" | "broadcast" | "digital-native";
export type PaywallStatus = "free" | "metered" | "hard";
export type ExtractionStatus = "full" | "partial" | "failed";
export type Label = "Proportionate" | "Grounded" | "Mixed Signals" | "Running Hot" | "Hyperbolic";

export interface DimensionRationale {
  headline: string;
  language: string;
  sourcing: string;
  fallacies: string;
  structure: string;
  // Null when the scorer's one-liner failed the reason check twice (reasonCheck.ts
  // on the server): the card then shows the band word with no Why line.
  summary: string | null;
}

export type MarkerCategory =
  | "grounded"
  | "hedging"
  | "emotional_language"
  | "loaded_terms"
  | "headline_framing"
  | "language_intensity"
  | "logical_fallacy"
  | "structural_manipulation"
  | "speculation";

export interface PHMarker {
  text: string;
  category: MarkerCategory;
  intensity: number; // 1-5
}

export interface ArticleExcerptDTO {
  paragraphs: string[];
  markers: PHMarker[];
}

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
  articleSummary: string; // neutral "just the facts"; may be ""
  section: string | null;
  modelUsed: string;
  scoredAt: string;
}

export interface TranslationDTO {
  translatedText: string;
  removedFallacies: string[];
  modelUsed: string;
  generatedAt: string;
}

export interface ArticleSummaryDTO {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceLean: Lean;
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  wordCount: number;
  extractionStatus: ExtractionStatus;
  paywallFlag: boolean;
  fetchedAt: string;
  score: ScoreDTO | null;
  excerpt: ArticleExcerptDTO | null;
}

// No rawText: the published snapshot never carries an article's full body (see
// scripts/edition-manifest.mjs bodyTextBlockers). Leaving it out of the type
// makes any client code that tries to render one a compile error.
export interface ArticleDetailDTO extends ArticleSummaryDTO {
  translation: TranslationDTO | null;
}

export interface ClusterDTO {
  id: number;
  topic: string;
  summary: string;
  articleCount: number;
  phMin: number | null;
  phMax: number | null;
  phAvg: number | null;
  leanCounts: Record<string, number>;
  updatedAt: string;
}

export interface ClusterArticleDTO {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceLean: Lean;
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null;
  wordCount: number;
  extractionStatus: ExtractionStatus;
  paywallFlag: boolean;
  fetchedAt: string;
  score: { composite: number; label: string } | null;
}

// --- Section pages ---
// Mirrors GET /api/sections and GET /api/sections/:slug. Slug = lowercase name.

export const SECTION_NAMES = [
  "Politics",
  "World",
  "Business",
  "Technology",
  "Science",
  "Health",
  "Sports",
  "Culture",
] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export interface SectionTrendingDTO {
  clusterId: number;
  topic: string;
  summary: string;
  articleCount: number;
  // Gap between the calmest and hottest telling of this story. The front page
  // leads with the widest, because that gap is what the paper exists to show.
  phSpread: number;
  // Highest editorial prominence among this story's outlets (3 = wire or major
  // national desk). The cover requires a real desk on the story.
  topProminence: number;
}

export interface SectionSummaryDTO {
  slug: string;
  name: string;
  trending: SectionTrendingDTO | null; // null = no multi-outlet cluster yet
  articleCount: number; // total scored articles in this section
}

export interface SectionArticleDTO {
  id: number;
  sourceId: number;
  sourceName: string;
  sourceLean: Lean;
  url: string;
  title: string;
  author: string | null;
  publishedAt: string | null; // ISO | null
  politicalLean: number | null; // -100..+100
  composite: number | null;
  label: string | null;
  articleSummary: string; // may be ""
  rationale: DimensionRationale | null; // why it scored what it did
  excerpt: ArticleExcerptDTO | null;
}

export interface SectionPageDTO {
  section: string;
  trending: SectionTrendingDTO | null; // null = no multi-outlet cluster yet
  articles: SectionArticleDTO[]; // the trending story's coverage (Map + spread)
  sectionArticles: SectionArticleDTO[]; // every scored article in the section
}

export interface ApiError {
  error: string;
  detail?: string;
}
