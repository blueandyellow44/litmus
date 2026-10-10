// What ingest does with one feed item once the page has been fetched. Pure:
// no network, no database. runIngest supplies the fetch result and the
// content-hash lookup; this decides the row.
//
// Plan phase S2 (docs/plans/story-first-build-2026-09-13.md): ingest keeps
// outlets. Before this, an item whose extraction came back empty was skipped
// and an item whose text matched ANY stored article was skipped. Both threw
// away the fact that an outlet covered the story, which is exactly what a
// story page needs to show. Now:
//
//   - A zero-word extraction becomes a HEADLINE-ONLY row: title, url and
//     publication time, nothing else. The feed snippet, if any, was already
//     tried as the body and was empty, so there is no text to withhold. The
//     row can be a story member; it can never be scored or excerpted
//     (extraction_status 'failed' with a zero word count keeps it below every
//     word floor, and 0002_article_syndication makes a body on such a row a
//     constraint violation).
//   - A content-hash match inside the SAME outlet is still a duplicate and is
//     skipped: sister feeds (NYT Politics and NYT US) carry the same piece and
//     it is one telling. The lookup is outlet-aware, so a third outlet holding
//     the same wire text first cannot hide the outlet's own row behind it.
//   - A content-hash match in a DIFFERENT outlet is a wire copy. It is stored,
//     pointing at the original, so the story can list the outlet without
//     counting the copy as an independent telling. The pointer means "same
//     text as", never "originated at": the root is whichever outlet the
//     roster polled first (articlesRepo.findByContentHash explains why the
//     root is not re-ordered by date), so a public "syndicated from X" label
//     needs a wire-outlet preference before it is shown.
//   - A headline-only row is NOT written when one of the outlet's feeds
//     already holds the same piece by URL or by title on the same day. The
//     hollow row and its sibling's body row hash differently, so the
//     content-hash rule cannot see the pair, and without this an outlet gets
//     a filled row and a hollow twin for one article.
//   - A headline-only row is RETRIED, not frozen. Before S2 a zero-word item
//     left no row, so the next run (feeds still list yesterday's items)
//     fetched the page again and usually got the body; a publisher timeout on
//     a slow night healed itself. Storing the row would have ended that, so
//     shouldRetryExtraction sends a stored headline-only row inside the
//     context window back through the extractor, and a body upgrades the row
//     in one statement (articlesRepo.upgradeHeadlineOnlyArticle). Outside the
//     window the row can never reach a page, so it is left alone. A retry that
//     yields nothing while a sister feed has meanwhile stored the piece with a
//     body drops the hollow row, the same one-row-per-piece rule the fresh
//     path enforces by refusing to write it.

import type { NewArticle, RawFeedItem, Source } from "../types.js";
import type { ExtractedContent } from "./extractor.js";
import type { PaywallVerdict } from "./paywallDetector.js";
import { contentHash } from "./deduper.js";

// What the repo knows about the stored article this item's hash matches.
//
// Not simply the earliest row: articlesRepo.findByContentHash is given the
// polling outlet's source ids and returns an in-outlet row when one exists,
// falling back to the earliest row overall. That ordering is what makes
// sameOutlet trustworthy. Selecting the earliest row alone was wrong: with a
// wire piece stored first by a third outlet, EVERY feed of a second outlet saw
// a cross-outlet match and inserted its own copy, so one newsroom landed in a
// story twice.
export interface ContentHashMatch {
  id: number;
  // The outlet holding the matched row, for logs and for the later
  // "syndicated from X" label. Descriptive only.
  outletKey: string;
  // Whether the matched row belongs to the polling outlet. The DECIDING field,
  // rather than an outletKey string comparison: these ids come from the loaded
  // roster, so the answer survives the 0001 rollback window where outlet_key
  // can be null and two feeds of one outlet fall back to different synthetic
  // keys (sourcesRepo.readOutletKey).
  sameOutlet: boolean;
  // The matched row's own syndication pointer, so a new copy points at the
  // root rather than at a copy and the chain stays one hop. Defensive: no
  // writer can currently produce a non-null value here, because a copy is
  // always inserted after its original (so the original is the earliest row)
  // and ON DELETE SET NULL clears the pointer when an original is pruned. It
  // guards a future writer that re-points a surviving copy at a new root.
  syndicatedOfArticleId: number | null;
}

export type ArticleRowPlan =
  // Same outlet already holds this text; nothing new to record.
  | { action: "skip-same-outlet-copy"; originalId: number }
  | { action: "insert"; row: NewArticle; kind: "full" | "headline_only" | "syndicated" };

// Whether this row is stored with a headline and link only. The paywall
// detector assigns 'failed' exactly when the word count is zero, and the
// database constraint holds the two together, so either test is the same test.
export function isHeadlineOnly(a: { extractionStatus: string; wordCount: number }): boolean {
  return a.extractionStatus === "failed" || a.wordCount === 0;
}

// Under the scoring and story floor: stored with some text, too little to use.
export const THIN_WORDS = 200;
export function isThin(a: { extractionStatus: string; wordCount: number }): boolean {
  return !isHeadlineOnly(a) && a.wordCount < THIN_WORDS;
}

// The content hash a row is stored under.
//
// A row WITH a body hashes title + body, as it always has. A headline-only row
// has no body, so it hashes the title against a second term that separates two
// different pieces carrying the same headline: the publication DAY, or the URL
// when the item is undated.
//
// Hashing a headline-only row on its title alone looks simpler and is wrong.
// Outlets reuse headlines on a schedule — "Morning Briefing", "News quiz of the
// week", "What we know so far" — so a title-only hash makes every later
// edition of a recurring column look like a same-outlet duplicate of the first
// one, and it is dropped. That is the exact failure this phase exists to end:
// an outlet that covered a story missing from it. Day granularity, not the
// timestamp, because sister feeds carrying one item can differ by seconds.
export function hashForItem(
  item: Pick<RawFeedItem, "title" | "url" | "publishedAt">,
  extracted: Pick<ExtractedContent, "text" | "wordCount">,
): string {
  if (extracted.wordCount > 0) return contentHash(item.title, extracted.text);
  // Same item on two of an outlet's feeds shares a title and (nearly always)
  // a publication date, so the pair still collapses. An undated item falls
  // back to its URL, which sister feeds also share for the same piece.
  const separator = item.publishedAt ? item.publishedAt.toISOString().slice(0, 10) : item.url;
  return contentHash(item.title, separator);
}

export interface PlanArticleRowInput {
  // Only the id is needed: whether a hash match is this outlet's own row is
  // answered by ContentHashMatch.sameOutlet, which the repo resolves from the
  // outlet's source ids rather than from an outlet-key string.
  source: Pick<Source, "id">;
  item: Pick<RawFeedItem, "url" | "title" | "author" | "publishedAt">;
  extracted: ExtractedContent;
  verdict: PaywallVerdict;
  hash: string;
  // The stored article this hash matches, preferring one inside this outlet
  // (articlesRepo.findByContentHash), or null when there is none.
  existing: ContentHashMatch | null;
  // A row one of this outlet's feeds already holds for the same piece by URL
  // or by title on the same day (articlesRepo.findSameOutletPiece), or null.
  // Consulted only when the item would become a headline-only row. Callers
  // that have not looked it up may omit it.
  sameOutletPiece?: { id: number } | null;
}

export function planArticleRow(input: PlanArticleRowInput): ArticleRowPlan {
  const { source, item, extracted, verdict, hash, existing } = input;
  const headlineOnly = verdict.status === "failed" || extracted.wordCount === 0;

  if (existing && existing.sameOutlet) {
    return { action: "skip-same-outlet-copy", originalId: existing.id };
  }

  const base = {
    sourceId: source.id,
    url: item.url,
    title: item.title,
    author: item.author,
    publishedAt: item.publishedAt,
    paywallFlag: verdict.paywallFlag,
    contentHash: hash,
  };

  if (headlineOnly) {
    // The outlet already holds this piece, most likely with a body from a
    // sister feed. A hollow twin would make the outlet count twice.
    if (input.sameOutletPiece) {
      return { action: "skip-same-outlet-copy", originalId: input.sameOutletPiece.id };
    }
    // A title alone cannot prove one outlet copied another, so a headline-only
    // row is never marked syndicated even when another outlet stored the same
    // title. It is stored as its own (unread) telling.
    return {
      action: "insert",
      kind: "headline_only",
      row: {
        ...base,
        rawText: "",
        wordCount: 0,
        extractionStatus: "failed",
        extractedVia: null,
        syndicatedOfArticleId: null,
      },
    };
  }

  const bodyRow: NewArticle = {
    ...base,
    rawText: extracted.text,
    wordCount: extracted.wordCount,
    extractionStatus: verdict.status,
    extractedVia: extracted.via,
    syndicatedOfArticleId: null,
  };

  if (existing) {
    return {
      action: "insert",
      kind: "syndicated",
      row: { ...bodyRow, syndicatedOfArticleId: existing.syndicatedOfArticleId ?? existing.id },
    };
  }

  return { action: "insert", kind: "full", row: bodyRow };
}

// Whether a (source_id, url) ingest has already stored deserves another pass
// through the extractor. Only a headline-only row does, and only while the
// piece can still reach a page: the edition and scoring windows both measure
// age as publication date falling back to fetch date, so this uses the same
// measure. A row with a body is finished; a hollow row past the window is
// left alone rather than paid for again.
//
// windowDays is passed in (runIngest hands over CONTEXT_WINDOW_DAYS) rather
// than imported, because this module stays free of the database client so
// its tests need no connection.
const MS_PER_DAY = 86_400_000;

export function shouldRetryExtraction(
  stored: { extractionStatus: string; wordCount: number; publishedAt: Date | null; fetchedAt: Date },
  windowDays: number,
  now: Date = new Date(),
  // Retry thin rows too. Only for a free source: a paywalled stub does not
  // improve on a second fetch, and every retry is a page request each run.
  retryThin = false,
): boolean {
  // A thin row is retried too (2026-09-26): NPR pieces stored under 200 words
  // on one run extracted in full later, but only zero-word rows were ever
  // fetched again, so they stayed too thin to score or show.
  if (!isHeadlineOnly(stored) && !(retryThin && isThin(stored))) return false;
  const anchor = stored.publishedAt ?? stored.fetchedAt;
  const ageDays = (now.getTime() - anchor.getTime()) / MS_PER_DAY;
  return ageDays <= windowDays;
}

// The body fields a headline-only row gains when a later run reads the page.
// Everything the constraint articles_headline_only_has_no_body ties together
// travels as one unit: the repo writes it in a single UPDATE so the status
// leaves 'failed' in the same statement that writes the text.
export interface HeadlineUpgrade {
  rawText: string;
  wordCount: number;
  extractionStatus: NewArticle["extractionStatus"];
  extractedVia: NewArticle["extractedVia"];
  paywallFlag: boolean;
  contentHash: string;
  syndicatedOfArticleId: number | null;
}

// What a retried headline-only row becomes, from the same decision a fresh
// item gets. Null means the row is not upgraded: the page still yielded no
// words, or a sister feed of the outlet has meanwhile stored the same text, in
// which case upgrading would give one outlet a second body for one piece. A
// cross-outlet hash match upgrades the row as a syndicated copy, exactly as a
// fresh insert would.
//
// Null is not the end of the decision. runIngest then asks
// articlesRepo.findSameOutletPiece whether a sister feed has covered the piece
// WITH a body, and drops the hollow row if so (deleteHeadlineOnlyArticle). The
// fresh path refuses to write that duplicate; this is the same rule applied to
// a row written before its sister feed caught up. Two hollow rows never delete
// each other: only a sister row carrying a body wins.
export function headlineUpgradeFromPlan(plan: ArticleRowPlan): HeadlineUpgrade | null {
  if (plan.action !== "insert" || plan.kind === "headline_only") return null;
  const { row } = plan;
  return {
    rawText: row.rawText,
    wordCount: row.wordCount,
    extractionStatus: row.extractionStatus,
    extractedVia: row.extractedVia,
    paywallFlag: row.paywallFlag,
    contentHash: row.contentHash,
    syndicatedOfArticleId: row.syndicatedOfArticleId,
  };
}
