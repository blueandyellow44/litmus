// One item in the mobile front page scroll. Same selection as the desktop item
// (lib/wire.ts), composed for a phone: outlet and score on one line, a tighter
// headline, the framing clamped to two lines, the quote, and one full-width row
// of large tap targets. A multi-outlet story collapses its other tellings into
// a single link instead of a wrapping row of small ones.

import { Link } from "react-router-dom";
import type { WireItem as Item } from "../../lib/wire.ts";
import { framingLine, pickQuote } from "../../lib/wire.ts";
import { isValidComposite } from "../../lib/phBand.ts";
import { PHBadge } from "../PHBadge.tsx";
import { HighlightedText } from "../HighlightedText.tsx";
import { CONTROL, FOCUS_RING } from "../meta.tsx";

const TAP = `underline decoration-1 underline-offset-2 inline-flex items-center ${CONTROL}`;

export function WireItemMobile({ item }: { item: Item }) {
  const a = item.kind === "story" ? item.lead : item.article;
  const quote = pickQuote(a.excerpt);
  const framing = framingLine(a.score?.rationale);
  const section = a.score?.section;

  return (
    <li className="py-4 border-b border-rule last:border-0">
      <div className="flex items-center justify-between gap-2">
        <div className="font-sans text-[11px] uppercase tracking-[0.1em] text-ink3 truncate min-w-0">
          {section ? `${section} · ` : ""}
          {a.sourceName}
        </div>
        <div className="shrink-0">
          <PHBadge composite={a.score?.composite} size="sm" />
        </div>
      </div>

      {item.kind === "story" && (
        <div className="font-sans text-[11px] text-ink2 mt-1">
          {item.cluster.articleCount} outlets on this story
          {isValidComposite(item.cluster.phMin) && isValidComposite(item.cluster.phMax)
            ? ` · ${item.cluster.phMin.toFixed(1)} to ${item.cluster.phMax.toFixed(1)}`
            : ""}
        </div>
      )}

      <h2 className="font-serif text-[21px] leading-tight mt-1 mb-0">
        <Link to={`/articles/${a.id}`} className={FOCUS_RING}>
          {a.title}
        </Link>
      </h2>

      {framing && <p className="font-sans text-[13px] text-ink3 mt-1.5 mb-0 line-clamp-2">{framing}</p>}

      {quote ? (
        <blockquote className="font-serif text-[16px] leading-snug border-l-2 border-rule-strong pl-3 mt-2.5 mb-0">
          <HighlightedText text={quote.text} markers={quote.markers} />
        </blockquote>
      ) : (
        <p className="font-sans text-[13px] text-ink3 mt-2.5 mb-0">No highlighted line from this piece in this edition.</p>
      )}

      <div className="font-sans text-[12px] text-ink3 mt-1 flex items-center justify-between gap-3">
        <span>{quote ? (quote.tone === "loaded" ? "Most loaded line" : "Most grounded line") : ""}</span>
        <a href={a.url} target="_blank" rel="noopener noreferrer" className={TAP}>
          Read at {a.sourceName} ↗
        </a>
      </div>

      {item.kind === "story" && item.others.length > 0 && section && (
        <Link to={`/s/${section.toLowerCase()}`} className={`font-sans text-[12px] text-ink3 ${TAP}`}>
          +{item.others.length} other telling{item.others.length === 1 ? "" : "s"} ›
        </Link>
      )}
    </li>
  );
}
