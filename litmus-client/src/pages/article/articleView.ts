// The article page's derived values and copy, shared by ArticleDetailDesktop.tsx
// and ArticleDetailMobile.tsx. Pure: no React, no fetching. The two versions lay
// out what this returns and decide nothing themselves, so they can never
// disagree about whether an article has an excerpt, a facts summary, or a
// paywall note.
//
// Legal posture (the excerpt policy): the published paper never carries an
// article's full body. ArticleDetailDTO has no rawText field, and the only body
// text this module passes on is the capped excerpt the snapshot already carries.
// There is deliberately no "read the full article here" state to derive.

import type { ArticleDetailDTO, ArticleExcerptDTO, ScoreDTO } from "../../lib/types.ts";

// ── Copy ───────────────────────────────────────────────────────────────────
// Written once so the desktop and mobile versions say the same thing.

export const ARTICLE_COPY = {
  back: "← Top stories",
  loading: "Loading…",
  loadError: "Could not load that article.",
  invalidId: "Invalid article id",
  why: "Why this score: ",
  facts: "The Facts",
  excerptLabel: "Most illustrative excerpt",
  noExcerpt: "LITMUS shows a short excerpt, never the full article, and has no excerpt for this one.",
} as const;

// The link out is the only way to the whole piece, so its wording names the
// outlet every time.
export function readAtSourceLabel(sourceName: string): string {
  return `Read the full article at ${sourceName} →`;
}

// ── Route parameter ────────────────────────────────────────────────────────

// A positive integer id, or null. `Number("")` is 0 and `Number("1.5")` is not
// an integer, so both are refused here rather than sent to the API.
export function parseArticleId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Derived view ───────────────────────────────────────────────────────────

export interface ArticleView {
  article: ArticleDetailDTO;
  score: ScoreDTO | null;
  // The scorer's section, when it assigned one.
  section: string | null;
  // Whether the meta line carries a paywall or extraction note. Mirrors the
  // condition PaywallState itself uses, so the separator is never orphaned.
  showPaywall: boolean;
  // The rationale summary behind "Why this score". Present only with a score.
  why: string | null;
  // The just-the-facts summary, or null when the scorer left it empty.
  facts: string | null;
  // The capped excerpt, or null when there is nothing to show. An excerpt
  // record with zero paragraphs is the no-excerpt state, not an empty block.
  excerpt: ArticleExcerptDTO | null;
}

export function articleView(article: ArticleDetailDTO): ArticleView {
  const score = article.score ?? null;
  const facts = score?.articleSummary?.trim() ? score.articleSummary : null;
  const excerpt = article.excerpt && article.excerpt.paragraphs.length > 0 ? article.excerpt : null;
  return {
    article,
    score,
    section: score?.section || null,
    showPaywall: article.paywallFlag || article.extractionStatus !== "full",
    // A score whose rationale is missing still shows the badge; the label
    // stays, with nothing after it, as it did before the split.
    why: score ? (score.rationale?.summary ?? "") : null,
    facts,
    excerpt,
  };
}
