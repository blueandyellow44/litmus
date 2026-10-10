// Layer 3 as it publishes in v1: descriptive framing notes built from counts
// (lead emphasis, whose voice leads), each tagged "Legitimate framing". Nothing
// here judges an outlet. Distortion findings stay in shadow until the
// defensibility gate is live (docs/specs/story-analysis-engine-2026-09-13.md);
// the DTO cannot carry one and this component has no branch for one.
//
// The empty states are the spec's story-level wording, so a story with no
// notes never shows a blank section and a single-outlet story says why.

import type { FramingNoteDTO } from "../../lib/storyTypes.ts";

// Spec section 3.2. The brief's own name for the layer never appears in copy.
export const LAYER3_HEADING = "How each outlet's wording compares with the record";
export const SINGLE_OUTLET_NOTE = "One outlet in this edition, so there is nothing to compare it against yet. No findings.";
export const NO_NOTES_YET = "Wording tests not yet applied to this story.";

export const TECHNIQUE_NAME: Readonly<Record<FramingNoteDTO["technique"], string>> = {
  lead_emphasis: "Lead emphasis",
  whose_voice: "Whose voice leads",
};

interface Props {
  notes: readonly FramingNoteDTO[];
  singleOutlet: boolean;
  // Mobile stacks the counts; desktop lays them out in a two-column list.
  layout: "desktop" | "mobile";
  className?: string;
}

// The hollow square marker of the Legitimate framing tag (brand.md section 6).
// Weight and fill are the only difference from the Distortion tag, never colour.
function LegitimateFramingTag({ label }: { label: FramingNoteDTO["label"] }) {
  return (
    <span className="inline-flex items-center gap-2 font-sans text-meta font-medium text-ink2">
      <span aria-hidden className="inline-block w-[9px] h-[9px] border-[1.5px] border-ink2 rounded-[1px]" />
      {label}
    </span>
  );
}

export function FramingNotes({ notes, singleOutlet, layout, className = "" }: Props) {
  return (
    <section aria-labelledby="framing-notes-h" className={className}>
      <h2 id="framing-notes-h" className="font-serif text-h3 font-medium m-0 mb-3">
        {LAYER3_HEADING}
      </h2>
      {singleOutlet ? (
        <p className="font-sans text-sm text-ink2 m-0 border border-dashed border-rule-strong rounded px-4 py-3" role="status">
          {SINGLE_OUTLET_NOTE}
        </p>
      ) : notes.length === 0 ? (
        <p className="font-sans text-sm text-ink2 m-0" role="status">
          {NO_NOTES_YET}
        </p>
      ) : (
        <ul className="list-none p-0 m-0 flex flex-col gap-4">
          {notes.map((n, i) => (
            <li key={`${n.technique}-${i}`} className="border-t border-rule pt-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <LegitimateFramingTag label={n.label} />
                <span className="font-serif text-[19px] font-medium text-ink">{TECHNIQUE_NAME[n.technique]}</span>
              </div>
              <p className="font-serif text-base text-ink mt-1.5 mb-0">{n.text}</p>
              {n.counts.length > 0 && (
                <dl className={`m-0 mt-2 font-sans text-meta text-ink2 ${layout === "desktop" ? "grid grid-cols-2 gap-x-8 gap-y-1" : "flex flex-col gap-1"}`}>
                  {n.counts.map((c, j) => (
                    <div key={`${c.outletName}-${j}`} className="flex justify-between gap-3">
                      <dt className="text-ink">{c.outletName}</dt>
                      <dd className="m-0 text-right">{c.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
