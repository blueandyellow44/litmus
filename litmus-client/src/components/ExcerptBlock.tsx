// The 3-paragraph verbatim excerpt with P/H highlights. Each paragraph gets the
// full marker set — HighlightedText self-filters to the markers that actually
// appear in that paragraph. Used in the feed (expanded row) and the reader.

import type { PHMarker } from "../lib/types.ts";
import { HIGHLIGHT_CLASS, HIGHLIGHT_KEY_LABEL } from "../lib/highlight.ts";
import { HighlightedText } from "./HighlightedText.tsx";

interface Props {
  paragraphs: string[];
  markers: PHMarker[];
  // Extra classes on the wrapper — e.g. "md:columns-2 md:gap-8" to flow the
  // paragraphs into newspaper columns. Paragraph spacing uses margin-bottom
  // (not space-y) so column tops align and paragraphs do not split across a
  // column break.
  className?: string;
}

export function ExcerptBlock({ paragraphs, markers, className = "" }: Props) {
  return (
    <div className={`font-serif text-base ${className}`}>
      {paragraphs.map((p, i) => (
        <p key={i} className="mb-3 last:mb-0 break-inside-avoid">
          <HighlightedText text={p} markers={markers} />
        </p>
      ))}
    </div>
  );
}

// The key for the two highlight treatments, drawn with the same classes
// HighlightedText paints with so it cannot describe a mark the page does not
// show. Kept tiny and optional.
//
// It used to show a green swatch, a red swatch and "darker = veers further",
// which described the retired intensity encoding: red against green is the pair
// colour-blind readers lose first, and the five alpha steps were never
// distinguishable as five things.
export function HighlightLegend() {
  return (
    <div className="font-sans text-[13px] text-ink2 flex items-baseline gap-x-3.5 gap-y-1 flex-wrap">
      <span className="text-micro uppercase font-semibold text-ink3">Key</span>
      <mark className={HIGHLIGHT_CLASS.loaded}>{HIGHLIGHT_KEY_LABEL.loaded}</mark>
      <mark className={HIGHLIGHT_CLASS.grounded}>{HIGHLIGHT_KEY_LABEL.grounded}</mark>
    </div>
  );
}
