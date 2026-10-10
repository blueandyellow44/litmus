// The finding card for Layer 3, in the Measured order (graft 2): their words,
// what the other reports say, reported by N with names, why we say this,
// dispute this. Built now so the layout exists; NOT wired to any page, because
// the published DTO carries no findings until the defensibility gate in
// docs/specs/story-analysis-engine-2026-09-13.md is live. Exercised only by
// tests until then.
//
// Two rules the component enforces rather than trusts:
//   1. A verdict never appears without its record. A finding with no
//      supporting outlets and no primary record renders an empty state.
//   2. The "Distortion" tag always carries its definition in the same element
//      (spec section 3.2), and the reason names the comparison.

import type { HighlightMarker } from "../../lib/highlight.ts";
import { HighlightedText } from "../HighlightedText.tsx";
import { PHBadge } from "../PHBadge.tsx";
import { CONTROL, FOCUS_RING } from "../meta.tsx";
import { LEGAL_HREF } from "../../lib/brand.ts";
import { outletShortName } from "../../lib/storyModel.ts";

export type Verdict = "Legitimate framing" | "Distortion";

export interface EvidenceFinding {
  verdict: Verdict;
  technique: string;
  outletName: string;
  composite: number | null;
  // The outlet's own words, verbatim, with the judged span as a marker.
  quote: { text: string; markers: readonly HighlightMarker[] };
  // Shown above the quote when the finding turns on the headline.
  headline?: string | null;
  record: {
    // The contradicting or complementary fact, in plain words.
    fact: string;
    reportedBy: readonly string[];
    primaryRecord?: { label: string; url: string } | null;
  };
  // Three sentences at most; the last names the reason for the verdict.
  why: string;
}

export const DISTORTION_DEFINITION =
  "Distortion here means the wording states more than, or something other than, the record shown supports. LITMUS makes no claim about why.";
export const NO_RECORD_STATE = "This finding has no record to compare against, so it is not shown.";
export const DISPUTE_HREF = `${LEGAL_HREF}#corrections`;

export function recordSourceLine(record: EvidenceFinding["record"]): string {
  const n = record.reportedBy.length;
  if (n === 0) return record.primaryRecord ? `Primary record: ${record.primaryRecord.label}` : "";
  return `Reported by ${n} outlet${n === 1 ? "" : "s"}: ${record.reportedBy.join(", ")}`;
}

function VerdictTag({ verdict }: { verdict: Verdict }) {
  const distortion = verdict === "Distortion";
  return (
    <span className={`inline-flex items-center gap-2 font-sans text-meta ${distortion ? "font-semibold text-ink" : "font-medium text-ink2"}`}>
      <span aria-hidden className={`inline-block w-[9px] h-[9px] rounded-[1px] ${distortion ? "bg-ink" : "border-[1.5px] border-ink2"}`} />
      {verdict}
    </span>
  );
}

export function EvidenceCard({ finding, className = "" }: { finding: EvidenceFinding; className?: string }) {
  const { record } = finding;
  if (record.reportedBy.length === 0 && !record.primaryRecord) {
    return (
      <p className={`font-sans text-sm text-ink2 m-0 border border-dashed border-rule-strong rounded px-4 py-3 ${className}`} role="status">
        {NO_RECORD_STATE}
      </p>
    );
  }
  const outlet = outletShortName(finding.outletName);
  const label = `${finding.verdict}: ${finding.technique}, ${outlet}`;

  return (
    <article className={`border border-rule rounded-md bg-surface p-5 ${className}`} aria-label={label}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <VerdictTag verdict={finding.verdict} />
        <span className="font-serif text-[21px] leading-tight font-medium text-ink">{finding.technique}</span>
        <span className="ml-auto font-sans text-meta text-ink3">By {outlet}</span>
      </header>
      {finding.verdict === "Distortion" && <p className="font-sans text-sm text-ink2 mt-2 mb-0">{DISTORTION_DEFINITION}</p>}

      <section aria-label="Their words" className="mt-4">
        <p className="font-sans text-micro uppercase font-semibold text-ink3 m-0 mb-2">Their words</p>
        {finding.headline && <p className="font-serif text-base font-medium text-ink m-0 mb-2">“{finding.headline}”</p>}
        <blockquote className="m-0 border-l border-rule pl-4 font-serif text-[19px] leading-[1.55] text-ink">
          “<HighlightedText text={finding.quote.text} markers={finding.quote.markers} />”
        </blockquote>
        <p className="font-sans text-meta text-ink2 mt-2 mb-0 flex items-center gap-2">
          <span className="text-ink font-semibold">{outlet}</span>
          {finding.composite !== null && <PHBadge composite={finding.composite} size="sm" />}
        </p>
      </section>

      <section aria-label="What the other reports say" className="mt-4 border border-rule rounded bg-ground px-4 py-3">
        <p className="font-sans text-micro uppercase font-semibold text-ink3 m-0 mb-1.5">What the other reports say</p>
        <p className="font-serif text-base text-ink m-0">{record.fact}</p>
        <p className="font-sans text-meta text-ink2 mt-1.5 mb-0">{recordSourceLine(record)}</p>
        {record.primaryRecord && record.reportedBy.length > 0 && (
          <p className="font-sans text-meta mt-1 mb-0">
            <a href={record.primaryRecord.url} rel="noopener" className={`text-ink underline decoration-1 underline-offset-2 ${FOCUS_RING}`}>
              Primary record: {record.primaryRecord.label}
            </a>
          </p>
        )}
      </section>

      <footer className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <details className="font-sans text-sm text-ink2 max-w-prose">
          <summary className={`cursor-pointer text-ink inline-flex items-center ${CONTROL}`}>Why we say this</summary>
          <p className="mt-1 mb-0">{finding.why}</p>
        </details>
        <a href={DISPUTE_HREF} className={`font-sans text-sm text-ink underline decoration-1 underline-offset-2 inline-flex items-center ${CONTROL}`}>
          Dispute this
        </a>
      </footer>
    </article>
  );
}
