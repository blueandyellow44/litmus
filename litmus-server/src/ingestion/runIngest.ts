// Phase 1 ingestion orchestrator. Run with: npm run ingest
//
// Pipeline per source:
//   1. Poll the RSS feed
//   2. For each item:
//      - Skip if (source_id, url) already in DB with a body; a stored
//        headline-only row inside the context window is retried instead, and
//        a body upgrades it in place. A hollow row a sister feed has since
//        covered with a body is dropped, so the outlet is one row per piece
//      - Try full-page extraction; fall back to feed snippet
//      - Detect paywall / partial / failed
//      - Compute content hash
//      - Skip if content_hash collides with an article from the SAME outlet
//        (sister-feed dedupe); a collision with another outlet is stored as a
//        syndicated copy pointing at the original
//      - Insert article row; a zero-word extraction is inserted as a
//        headline-only row (title, url, date, no body), never skipped, unless
//        a sister feed of the outlet already holds the piece
//
// The per-item decision is pure and lives in articleRow.ts, with its tests.
// No Claude calls happen here. Scoring runs as a separate worker.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listEnabledSources, upsertSource } from "../db/repos/sourcesRepo.js";
import {
  findStoredBySourceUrl,
  findByContentHash,
  findSameOutletPiece,
  insertArticle,
  upgradeHeadlineOnlyArticle,
  upgradeThinArticle,
  deleteHeadlineOnlyArticle,
} from "../db/repos/articlesRepo.js";
import { pollFeedDetailed } from "./rssPoller.js";
import { extractArticle } from "./extractor.js";
import { detectPaywall } from "./paywallDetector.js";
import { hashForItem, headlineUpgradeFromPlan, isThin, planArticleRow, shouldRetryExtraction, THIN_WORDS } from "./articleRow.js";
import { CONTEXT_WINDOW_DAYS } from "../db/repos/articlesRepo.js";
import { logger } from "../lib/logger.js";
import { shutdown, crashAndShutdown } from "../lib/shutdown.js";
import type { NewSource } from "../types.js";

// Load seed.json from disk and upsert each source. Idempotent: safe to call on
// every ingest run; existing rows are updated, not duplicated.
async function seedSourcesIfEmpty(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const seedPath = join(__dirname, "..", "..", "sources", "seed.json");
  const raw = await readFile(seedPath, "utf-8");
  const parsed = JSON.parse(raw) as { sources: NewSource[] };
  for (const s of parsed.sources) {
    await upsertSource(s);
  }
  logger.info("seeded sources", { count: parsed.sources.length });
}

interface IngestStats {
  source: string;
  feedItems: number;
  // Rows written with a body (full or partial) that are their own telling.
  inserted: number;
  skippedDup: number;
  // Same outlet already held this text (a sister feed carrying the same piece).
  skippedHash: number;
  skippedOld: number;
  // Rows written with a headline and link only, because extraction returned
  // zero words. These used to be counted as "failed" and thrown away.
  headlineOnly: number;
  // Rows written as a copy of another outlet's article. Logged per source so
  // the paid replay can report the real syndication rate per outlet.
  syndicated: number;
  // Stored headline-only rows inside the window that were sent back through
  // the extractor this run, and how many of those came back with a body and
  // were upgraded in place. The gap between the two is the count still
  // unreadable (paywall, bot wall, or a page that really has no text).
  retried: number;
  upgraded: number;
  // Hollow rows removed because a sister feed of the same outlet had meanwhile
  // stored the piece with a body. One outlet, one row per piece.
  hollowDropped: number;
  // Why a source contributed nothing. Without these three, "feedItems: 0" was
  // the same line whether the feed was empty, unreachable, or returning
  // twenty perfectly good entries the parser could not turn into items — which
  // is how three outlets stayed dark for weeks without a single error surfacing.
  pollError: string | null;
  droppedNoUrl: number;
  droppedNoTitle: number;
  /** Set when the configured feed URL redirects; the seed needs canonicalising. */
  resolvedUrl: string | null;
}

// One of: the feed was read and had entries; it was read and was genuinely
// empty; it could not be read at all; or its entries could not be parsed into
// items. A gate that cannot tell these apart cannot tell a healthy quiet day
// from a broken pipeline.
type PollOutcome = "ok" | "empty-feed" | "unreachable" | "entries-unusable";

function pollOutcome(s: IngestStats): PollOutcome {
  if (s.pollError) return "unreachable";
  if (s.feedItems > 0) return "ok";
  if (s.droppedNoUrl > 0 || s.droppedNoTitle > 0) return "entries-unusable";
  return "empty-feed";
}

// An item older than the edition's context window can never reach a page, so
// there is no reason to pay to extract it. Several feeds serve deep back
// catalogues — The Economist's weekly roundup feed returns a year of items —
// and without this check ingest walked backwards through 2025 doing a full
// publisher fetch on each weekly cartoon, minutes of work
// whose every result the edition query then discarded on publication date.
//
// Undated items are KEPT. A missing date is not evidence of age, and dropping
// them would silently lose articles from feeds with sloppy metadata.
function tooOldToPublish(publishedAt: Date | null): boolean {
  if (!publishedAt) return false;
  const ageDays = (Date.now() - publishedAt.getTime()) / 86_400_000;
  return ageDays > CONTEXT_WINDOW_DAYS;
}

type LoadedSource = Awaited<ReturnType<typeof listEnabledSources>>[number];

// Every source id that shares this source's outlet, this one included. Read
// from the loaded roster rather than the outlet_key column so the lookup
// works through the 0001 rollback window, when the column may be null.
function outletSourceIds(source: LoadedSource, all: LoadedSource[]): number[] {
  return all.filter((s) => s.outletKey === source.outletKey).map((s) => s.id);
}

async function ingestSource(source: LoadedSource, siblingSourceIds: number[]): Promise<IngestStats> {
  const stats: IngestStats = {
    source: source.name,
    feedItems: 0,
    inserted: 0,
    skippedDup: 0,
    skippedHash: 0,
    skippedOld: 0,
    headlineOnly: 0,
    syndicated: 0,
    retried: 0,
    upgraded: 0,
    hollowDropped: 0,
    pollError: null,
    droppedNoUrl: 0,
    droppedNoTitle: 0,
    resolvedUrl: null,
  };

  const poll = await pollFeedDetailed(source);
  const items = poll.items;
  stats.feedItems = items.length;
  stats.pollError = poll.error;
  stats.droppedNoUrl = poll.dropped["no-url"];
  stats.droppedNoTitle = poll.dropped["no-title"];
  stats.resolvedUrl = poll.resolvedUrl;

  for (const item of items) {
    const stored = await findStoredBySourceUrl(source.id, item.url);
    if (stored && !shouldRetryExtraction(stored, CONTEXT_WINDOW_DAYS, new Date(), source.paywallStatus === "free")) {
      stats.skippedDup++;
      continue;
    }

    // Cheap checks before expensive ones: this is a date comparison, the next
    // line is a network fetch.
    if (tooOldToPublish(item.publishedAt)) {
      stats.skippedOld++;
      continue;
    }

    const extracted = await extractArticle(item.url, item.feedSnippet);
    const verdict = detectPaywall(extracted.wordCount, source);

    const hash = hashForItem(item, extracted);
    const headlineOnly = extracted.wordCount === 0;
    const plan = planArticleRow({
      source,
      item,
      extracted,
      verdict,
      hash,
      // The outlet's own source ids decide whether a hash match is a sister
      // feed (skip) or another newsroom (syndicated copy). Passing them is
      // what stops a third outlet's earlier copy from hiding this outlet's
      // own row; see articlesRepo.findByContentHash.
      existing: await findByContentHash(hash, siblingSourceIds),
      // Only a would-be headline-only row needs the outlet-wide check, and a
      // retried row must not match itself, so it is looked up only for a
      // fresh item.
      sameOutletPiece: headlineOnly && !stored ? await findSameOutletPiece(siblingSourceIds, item) : null,
    });

    if (stored) {
      // A headline-only row from an earlier run, inside the window: the page
      // was fetched again just now. A body upgrades the row in one statement;
      // otherwise the row stays hollow, unless a sister feed has covered the
      // piece in the meantime.
      stats.retried++;
      const upgrade = headlineUpgradeFromPlan(plan);
      if (isThin(stored)) {
        // A thin row changes only for a real body that is longer than it.
        if (upgrade && upgrade.wordCount >= THIN_WORDS && upgrade.wordCount > stored.wordCount) {
          if (await upgradeThinArticle(stored.id, upgrade, THIN_WORDS)) stats.upgraded++;
        }
        continue;
      }
      if (upgrade) {
        if (await upgradeHeadlineOnlyArticle(stored.id, upgrade)) stats.upgraded++;
        continue;
      }
      // The page still yields nothing, or its text is already held inside this
      // outlet. If a sister feed has meanwhile stored the piece WITH a body,
      // this hollow row is the duplicate the fresh path would have refused to
      // write, so it goes. Only a sister row with a body wins: two hollow rows
      // would each see the other and could delete both.
      const sister = await findSameOutletPiece(siblingSourceIds, item, stored.id);
      if (sister && sister.wordCount > 0 && (await deleteHeadlineOnlyArticle(stored.id))) {
        stats.hollowDropped++;
      }
      continue;
    }

    if (plan.action === "skip-same-outlet-copy") {
      stats.skippedHash++;
      continue;
    }

    const inserted = await insertArticle(plan.row);
    if (!inserted) {
      // (source_id, url) landed between the existence check and the insert.
      stats.skippedDup++;
      continue;
    }
    if (plan.kind === "headline_only") stats.headlineOnly++;
    else if (plan.kind === "syndicated") stats.syndicated++;
    else stats.inserted++;
  }

  return stats;
}

async function main(): Promise<void> {
  logger.info("ingest start");
  await seedSourcesIfEmpty();

  const sources = await listEnabledSources();
  logger.info("polling sources", { count: sources.length });

  const allStats: IngestStats[] = [];
  for (const source of sources) {
    const stats = await ingestSource(source, outletSourceIds(source, sources));
    allStats.push(stats);
    logger.info("source done", { ...stats, outcome: pollOutcome(stats) });
  }

  const totals = allStats.reduce(
    (acc, s) => ({
      feedItems: acc.feedItems + s.feedItems,
      inserted: acc.inserted + s.inserted,
      skippedDup: acc.skippedDup + s.skippedDup,
      skippedHash: acc.skippedHash + s.skippedHash,
      skippedOld: acc.skippedOld + s.skippedOld,
      headlineOnly: acc.headlineOnly + s.headlineOnly,
      syndicated: acc.syndicated + s.syndicated,
      retried: acc.retried + s.retried,
      upgraded: acc.upgraded + s.upgraded,
      hollowDropped: acc.hollowDropped + s.hollowDropped,
    }),
    { feedItems: 0, inserted: 0, skippedDup: 0, skippedHash: 0, skippedOld: 0, headlineOnly: 0, syndicated: 0, retried: 0, upgraded: 0, hollowDropped: 0 },
  );

  // The health roll-up. This is the line a human reads to know whether an
  // edition is worth publishing, so it names the sources that produced nothing
  // and WHY, rather than leaving a reader to notice an absence.
  const byOutcome = allStats.reduce<Record<PollOutcome, string[]>>(
    (acc, s) => {
      acc[pollOutcome(s)].push(s.source);
      return acc;
    },
    { ok: [], "empty-feed": [], unreachable: [], "entries-unusable": [] },
  );

  logger.info("ingest done", {
    ...totals,
    sources: allStats.length,
    ok: byOutcome.ok.length,
    unreachable: byOutcome.unreachable.length,
    entriesUnusable: byOutcome["entries-unusable"].length,
    emptyFeed: byOutcome["empty-feed"].length,
  });

  for (const kind of ["unreachable", "entries-unusable", "empty-feed"] as const) {
    if (byOutcome[kind].length > 0) {
      logger.warn(`sources producing nothing: ${kind}`, { sources: byOutcome[kind] });
    }
  }

  const needsCanonicalUrl = allStats.filter((s) => s.resolvedUrl);
  if (needsCanonicalUrl.length > 0) {
    logger.warn("feeds served from a different URL than configured", {
      sources: needsCanonicalUrl.map((s) => `${s.source} -> ${s.resolvedUrl}`),
    });
  }

  await shutdown();
}

main().catch((err) => crashAndShutdown("ingest", err));
