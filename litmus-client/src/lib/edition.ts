// Edition truthfulness. The masthead date is evidence, not a guess: it comes
// from the manifest frozen into the snapshot at build time. The browser clock is
// used for exactly one thing — measuring how OLD that evidence is — and it can
// never manufacture a "fresh" edition on its own.
//
// SHARED INVARIANT — these rules mirror scripts/edition-manifest.mjs, which
// writes the manifest and is what the deterministic verifier checks. Change one,
// change both. The verifier asserts STALE_AFTER_HOURS matches across the two.

export const EDITION_SCHEMA_VERSION = 1;

// A once-a-day paper (5:15 AM Pacific, .github/workflows/daily.yml, since
// 2026-09-22) that has gone 30 hours without a successful rebuild has missed
// its expected edition, and the reader is told so. 30, not 24: GitHub's
// scheduled runs start late (the 2026-09-22 morning run started 4h42m after
// its cron time), and a paper that was on time must not read "stale" while
// the next one is still queued. A missed edition must never sit behind a
// "fresh" label for a day and a half. Was 18 while the paper ran twice a day.
export const STALE_AFTER_HOURS = 30;

// Clock skew allowance. A timestamp further ahead than this is broken evidence,
// not a very fresh edition.
export const FUTURE_TOLERANCE_MINUTES = 5;

export type EditionState = "fresh" | "stale" | "unknown";

export interface EditionManifest {
  schemaVersion: number;
  buildCompletedAt: string;
  sourceLatestFetchAt: string | null;
  articleCount: number;
  articleDetailCount: number;
  clusterCount: number;
  sectionCount: number;
  sectionPageCount: number;
  staleAfterHours: number;
}

export interface EditionStatus {
  state: EditionState;
  // Plain-English reason, shown to the reader when the edition is not fresh.
  reason: string;
  // Milliseconds since the oldest piece of evidence; null when unmeasurable.
  ageMs: number | null;
  compiledAt: Date | null;
  contentThrough: Date | null;
  articleCount: number | null;
  clusterCount: number | null;
}

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Strict on purpose: bare Date.parse() accepts "" in some engines and a pile of
// ambiguous formats in all of them. Only a real ISO-8601 instant is evidence.
export function parseInstant(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_LIKE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const unknown = (reason: string, partial: Partial<EditionStatus> = {}): EditionStatus => ({
  state: "unknown",
  reason,
  ageMs: null,
  compiledAt: null,
  contentThrough: null,
  articleCount: null,
  clusterCount: null,
  ...partial,
});

// The one place the fresh/stale/unknown verdict is decided. Anything missing,
// malformed, future-dated, or self-contradictory lands on "unknown".
export function evaluateEdition(raw: unknown, now: Date = new Date()): EditionStatus {
  if (!raw || typeof raw !== "object") return unknown("This edition carries no build record.");
  const e = raw as Partial<EditionManifest>;
  if (e.schemaVersion !== EDITION_SCHEMA_VERSION) return unknown("This edition's build record is in an unrecognized format.");

  const built = parseInstant(e.buildCompletedAt);
  const fetched = parseInstant(e.sourceLatestFetchAt);
  const counts = {
    articleCount: typeof e.articleCount === "number" ? e.articleCount : null,
    clusterCount: typeof e.clusterCount === "number" ? e.clusterCount : null,
  };
  if (built === null) return unknown("This edition's compile time is unreadable.", counts);
  if (fetched === null) return unknown("This edition's content cutoff is unreadable.", { ...counts, compiledAt: new Date(built) });

  const compiledAt = new Date(built);
  const contentThrough = new Date(fetched);
  const known = { ...counts, compiledAt, contentThrough };

  const nowMs = now.getTime();
  const skew = FUTURE_TOLERANCE_MINUTES * 60_000;
  if (built - nowMs > skew || fetched - nowMs > skew) {
    return unknown("This edition is dated in the future, so its age cannot be trusted.", known);
  }
  // Content cannot have been fetched after the build that froze it.
  if (fetched - built > skew) {
    return unknown("This edition's timestamps contradict each other.", known);
  }
  if (counts.articleCount === null || counts.articleCount <= 0) {
    return unknown("This edition records no articles.", known);
  }

  const ageMs = nowMs - Math.min(built, fetched);
  if (ageMs > STALE_AFTER_HOURS * 3_600_000) {
    return { state: "stale", reason: `No successful refresh in over ${STALE_AFTER_HOURS} hours.`, ageMs, ...known };
  }
  return { state: "fresh", reason: "Refreshed within the daily window.", ageMs, ...known };
}

const DATE_FMT: Intl.DateTimeFormatOptions = {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
};

export function formatEditionDate(d: Date): string {
  return d.toLocaleDateString("en-US", DATE_FMT);
}

export function formatEditionStamp(d: Date): string {
  return `${d.toLocaleDateString("en-US", DATE_FMT)}, ${d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })}`;
}

// "3 days" / "14 hours" — coarse on purpose; this is a warning, not a stopwatch.
export function formatAge(ageMs: number): string {
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours < 1) return "less than an hour";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}
