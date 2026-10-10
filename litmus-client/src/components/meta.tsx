// The small pieces of article metadata that appear on more than one surface,
// written once so they cannot say different things in different places.
//
// The problem this fixes is not visual tidiness. LITMUS carries two different
// political readings and the app was calling both of them "lean":
//
//   - the OUTLET BASELINE (`sourceLean`), a standing editorial classification of
//     the publication, which LITMUS assigns and which does not move story to
//     story;
//   - the ARTICLE FRAMING (`politicalLean`), the scorer's reading of where THIS
//     piece's framing sits, judged from the writing and independent of who
//     published it.
//
// They routinely disagree, and that disagreement is a real finding: a
// right-leaning outlet filing a plainly centred report is the instrument working.
// A reader shown "Fox News · Right" beside "Center" with no words distinguishing
// the two reads it as a contradiction or a bug. The Map plots article framing;
// the feed row and the section grid used to print outlet baseline; nothing said
// which was which.

import type { Lean } from "../lib/types.ts";

// ── Shared interaction affordances ─────────────────────────────────────────

// A visible keyboard focus treatment, applied to every interactive control.
//
// `focus-visible` rather than `focus`, so a mouse click does not leave a ring
// behind, and an outline rather than a ring so it survives on a control that
// already has a border. The palette has no accent colour to spare (ramp colour
// is reserved for P/H marks), so the treatment is ink with an offset, which
// reads as deliberate against the warm grey ground.
export const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

// The minimum comfortable touch target. Applied as a min-height rather than a
// fixed height so a control can still grow with its content.
export const TOUCH_TARGET = "min-h-[44px]";

// Both, for the common case.
export const CONTROL = `${FOCUS_RING} ${TOUCH_TARGET}`;

// ── Outlet baseline ────────────────────────────────────────────────────────

const BASELINE_LABEL: Record<Lean, string> = {
  left: "Left",
  "center-left": "Center-left",
  center: "Center",
  "center-right": "Center-right",
  right: "Right",
};

export function baselineLabel(lean: string): string {
  return BASELINE_LABEL[lean as Lean] ?? "Unrated";
}

// LITMUS's standing classification of the publication. Never derived from an
// article's own score.
export function OutletBaseline({ lean, className = "" }: { lean: string; className?: string }) {
  return (
    <span className={className}>
      <span className="text-ink3">Outlet baseline: </span>
      {baselineLabel(lean)}
    </span>
  );
}

// ── Article framing ────────────────────────────────────────────────────────

// -100..+100 -> a bucket. The thresholds match the scorer's own instruction to
// stay within ±20 when the lean is genuinely unclear, so the middle bucket is
// the one that says "no clear framing" rather than "exactly centrist".
export function framingLabel(politicalLean: number): string {
  if (politicalLean <= -60) return "Left";
  if (politicalLean <= -20) return "Center-left";
  if (politicalLean < 20) return "Center";
  if (politicalLean < 60) return "Center-right";
  return "Right";
}

// Where the scorer read THIS piece's framing. Independent of the outlet.
export function ArticleFraming({
  politicalLean,
  className = "",
}: {
  politicalLean: number | null;
  className?: string;
}) {
  return (
    <span className={className}>
      <span className="text-ink3">Article framing: </span>
      {politicalLean === null ? "not scored" : framingLabel(politicalLean)}
    </span>
  );
}

// ── Publication time ───────────────────────────────────────────────────────

// A relative age for anything inside a week, an absolute date beyond it.
// Deliberately coarse: a rewspaper publishes twice a day, so "3h ago" is as
// precise as the edition can honestly be.
export function formatPublished(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "date unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "date unknown";
  const mins = Math.floor((now - t) / 60000);
  if (mins < 0) return "just now"; // a feed stamped slightly ahead of us
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function PublishedAt({ iso, className = "" }: { iso: string | null; className?: string }) {
  if (!iso) return <span className={className}>date unknown</span>;
  return (
    <time className={className} dateTime={iso} title={new Date(iso).toLocaleString()}>
      {formatPublished(iso)}
    </time>
  );
}

// ── Paywall and extraction state ───────────────────────────────────────────

// One vocabulary. The app previously said "paywall" on a cluster card, "partial
// — paywall" on a feed row, and "paywalled, link only" elsewhere, for what is
// the same two facts: whether the outlet charges, and how much of the piece
// LITMUS could actually read. Those are separate, and only the second one
// changes what the score was computed from.
export type ExtractionState = "full" | "partial" | "failed";

export interface PaywallStateProps {
  paywallFlag: boolean;
  extractionStatus?: ExtractionState | string | null;
  className?: string;
}

export function paywallText(paywallFlag: boolean, extractionStatus?: string | null): string | null {
  if (extractionStatus === "failed") return "Body unavailable";
  if (paywallFlag && extractionStatus === "partial") return "Paywalled, partial text";
  if (paywallFlag) return "Paywalled";
  if (extractionStatus === "partial") return "Partial text";
  return null;
}

export function PaywallState({ paywallFlag, extractionStatus, className = "" }: PaywallStateProps) {
  const text = paywallText(paywallFlag, extractionStatus ?? null);
  if (!text) return null;
  return (
    <span
      className={`text-ink2 ${className}`}
      title="LITMUS scores only the text it could read. A partial body is scored on what was available and says so."
    >
      {text}
    </span>
  );
}
