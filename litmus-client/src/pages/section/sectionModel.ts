// Everything a section page SAYS, derived once from the snapshot and the reader's
// lens, so the desktop and mobile versions can differ in layout without ever
// differing in content. Pure: no React, no fetching. useSectionPage.ts wraps it.
//
// The spread's selection rules (which telling leads, which pair is contrasted,
// what the consensus strip says, what may be claimed about political breadth)
// are NOT re-derived here. They live in components/StorySpread.tsx, beside the
// rulings that govern them, and this file only calls them. A second copy of that
// logic is exactly the kind of drift the band table was consolidated to prevent.

import { decodeEntities } from "../../lib/entities.ts";
import type { SectionArticleDTO, SectionPageDTO } from "../../lib/types.ts";
import {
  breadthNote,
  consensusReading,
  contrastIsReal,
  noPairReason,
  pairBreadthState,
  pickContrast,
  pickLead,
  type PairBreadthState,
} from "../../components/StorySpread.tsx";

// ── Copy ───────────────────────────────────────────────────────────────────

export function leadEyebrow(section: string): string {
  return `${section} · Widest P/H gap`;
}

// The desk's lead is selected by the widest gap between the calmest and hottest
// telling, not by readership, which LITMUS does not measure.
export const LEAD_NOTE =
  "The story on this desk whose coverage differs most in Proportionate-to-Hyperbolic temperature. Not a measure of how much attention it got.";

export const PAIR_NOTE = "Paired by how hot each telling runs, not by politics.";

export const EMPTY_TITLE = "No coverage yet in this section.";
export const EMPTY_BODY = "As outlets publish here, their stories will appear on this page.";

export function articleCount(n: number): string {
  return `${n} ${n === 1 ? "article" : "articles"}`;
}

export function coverageDirection(readingAs: string): string {
  return readingAs === "conservative" ? "right → left" : "left → right";
}

// ── Coverage order ─────────────────────────────────────────────────────────

// Ascending article framing for mixed/liberal, descending for conservative. This
// orders by the SCORER's reading of each piece, not by the outlet's baseline —
// every row shows both, labelled. Unscored framing sorts last in either lens.
export function sortCoverage(articles: SectionArticleDTO[], readingAs: string): SectionArticleDTO[] {
  const dir = readingAs === "conservative" ? -1 : 1;
  return [...articles].sort((a, b) => {
    if (a.politicalLean === null && b.politicalLean === null) return 0;
    if (a.politicalLean === null) return 1;
    if (b.politicalLean === null) return -1;
    return dir * (a.politicalLean - b.politicalLean);
  });
}

// ── The spread, as data ────────────────────────────────────────────────────

function hasExcerpt(a: SectionArticleDTO | null): a is SectionArticleDTO {
  return !!a && !!a.excerpt && a.excerpt.paragraphs.length > 0;
}

// Which tellings the lens shows, in the same four cases StorySpread renders:
// a calmest/hottest pair (Mixed, pair exists); Mixed with no pair, which says
// why; a side lens's single telling; or nothing to show.
export type TellingsModel =
  | {
      kind: "pair";
      left: SectionArticleDTO;
      right: SectionArticleDTO;
      // Below a half-band gap the captions drop the calmest/hottest claim.
      real: boolean;
      breadth: PairBreadthState;
      breadthText: string | null;
    }
  | { kind: "only-one"; reason: string; lead: SectionArticleDTO | null }
  | { kind: "lead"; lead: SectionArticleDTO }
  | { kind: "none" };

export interface SpreadModel {
  clusterId: number;
  topic: string;
  summary: string;
  // DISTINCT SOURCES, not article rows. One publisher filing twice on a story
  // would otherwise overstate breadth.
  outletCount: number;
  articleCount: number;
  consensus: ReturnType<typeof consensusReading>;
  // Claim receipts only link to members that carry a URL.
  receiptMembers: { id: number; url: string }[];
  tellings: TellingsModel;
}

export function buildSpread(data: SectionPageDTO, readingAs: string): SpreadModel | null {
  const { trending, articles } = data;
  if (!trending) return null;

  const contrast = pickContrast(articles);
  const lead = pickLead(articles, readingAs);

  let tellings: TellingsModel;
  if (readingAs === "mixed" && contrast) {
    // Political breadth is measured across the COMPLETE article set, separately
    // from the pair, which is chosen on temperature and knows nothing about lean.
    const breadth = pairBreadthState(contrast, articles);
    tellings = {
      kind: "pair",
      left: contrast.left,
      right: contrast.right,
      real: contrastIsReal(contrast),
      breadth,
      breadthText: breadthNote(breadth),
    };
  } else if (readingAs === "mixed" && articles.length > 0) {
    tellings = { kind: "only-one", reason: noPairReason(articles), lead: hasExcerpt(lead) ? lead : null };
  } else if (hasExcerpt(lead)) {
    tellings = { kind: "lead", lead };
  } else {
    tellings = { kind: "none" };
  }

  return {
    clusterId: trending.clusterId,
    topic: trending.topic,
    summary: trending.summary,
    outletCount: new Set(articles.map((a) => a.sourceName)).size,
    articleCount: articles.length,
    consensus: consensusReading(articles),
    receiptMembers: articles.filter((a) => !!a.url).map((a) => ({ id: a.id, url: a.url })),
    tellings,
  };
}

// ── Headline text ──────────────────────────────────────────────────────────

// Entity decoding lives in lib/entities.ts; re-exported for existing callers.
export { decodeEntities };

function withDecodedText(a: SectionArticleDTO): SectionArticleDTO {
  const title = decodeEntities(a.title);
  const articleSummary = decodeEntities(a.articleSummary);
  return title === a.title && articleSummary === a.articleSummary ? a : { ...a, title, articleSummary };
}

// ── The page, as data ──────────────────────────────────────────────────────

export interface SectionModel {
  data: SectionPageDTO;
  section: string;
  readingAs: string;
  hasLead: boolean;
  spread: SpreadModel | null;
  // The lead story's coverage, sorted by the active lens: how each outlet told
  // the ONE story the spread is about. Reordered by lens, never filtered.
  coverage: SectionArticleDTO[];
  // The rest of the desk: every other scored article in the section minus the
  // lead story's coverage, in server order (newest first).
  rest: SectionArticleDTO[];
  totalInSection: number;
}

export function buildSectionModel(raw: SectionPageDTO, readingAs: string): SectionModel {
  // Decoded once here, so the spread (StorySpread, the Map), the coverage and
  // the desk all show the same headline text on both versions.
  const data: SectionPageDTO = {
    ...raw,
    articles: raw.articles.map(withDecodedText),
    // Guard against a snapshot frozen before this field existed: an older cached
    // build serves section pages with no `sectionArticles`, and the desk list
    // simply stays empty rather than throwing.
    sectionArticles: (raw.sectionArticles ?? []).map(withDecodedText),
  };
  // Without a lead story no coverage block renders, so nothing may be held
  // back from the desk on its account.
  const leadIds = new Set(data.trending ? data.articles.map((a) => a.id) : []);
  const rest = data.sectionArticles.filter((a) => !leadIds.has(a.id));
  return {
    data,
    section: data.section,
    readingAs,
    hasLead: !!data.trending,
    spread: buildSpread(data, readingAs),
    coverage: sortCoverage(data.articles, readingAs),
    rest,
    // The header counts what the page LISTS: the lead story's coverage plus the
    // rest of the desk. The lead story can carry members the section list does
    // not (a story clustered across desks), so sectionArticles.length alone
    // undercounted ("50 articles" over 53 cards). Only counted when the coverage
    // is actually shown, which requires a lead.
    totalInSection: leadIds.size + rest.length,
  };
}
