// Render one paragraph with phrase-level P/H highlights: loaded wording gets a
// warm tint and underline, grounded wording a cool underline and no fill.
// Matching and encoding live in lib/highlight.ts; the two treatments are CSS
// classes in styles/tokens.css.

import { computeHighlightRanges, highlightKind, highlightTitle, HIGHLIGHT_CLASS, type HighlightMarker } from "../lib/highlight.ts";

interface Props {
  text: string;
  markers: readonly HighlightMarker[];
}

export function HighlightedText({ text, markers }: Props) {
  const ranges = computeHighlightRanges(text, markers);

  const out: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const r of ranges) {
    if (r.start > cursor) out.push(text.slice(cursor, r.start));
    const kind = highlightKind(r.marker.category);
    const phrase = text.slice(r.start, r.end);
    // An unknown category keeps its span (so it still wins the overlap it won)
    // but is drawn as plain text: see highlightKind.
    out.push(
      kind ? (
        <mark key={key++} className={HIGHLIGHT_CLASS[kind]} title={highlightTitle(r.marker)}>
          {phrase}
        </mark>
      ) : (
        phrase
      ),
    );
    cursor = r.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));

  return <>{out}</>;
}
