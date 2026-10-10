// One item in the desktop front page scroll. The same grammar every time: where
// it ran and its score, the headline, one line on how it was told, one quoted
// line with its highlight, and the way out to the outlet. Selection rules live
// in lib/wire.ts and are shared with WireItemMobile.tsx.

import { Link } from "react-router-dom";
import type { WireItem as Item } from "../../lib/wire.ts";
import { framingLine, pickQuote } from "../../lib/wire.ts";
import { colorForComposite, isValidComposite } from "../../lib/phBand.ts";
import { PHBadge } from "../PHBadge.tsx";
import { HighlightedText } from "../HighlightedText.tsx";
import { FOCUS_RING, PublishedAt } from "../meta.tsx";

const LINK = `underline decoration-1 underline-offset-2 hover:text-ink ${FOCUS_RING}`;

export function WireItemDesktop({ item }: { item: Item }) {
  const a = item.kind === "story" ? item.lead : item.article;
  const quote = pickQuote(a.excerpt);
  const framing = framingLine(a.score?.rationale);
  const section = a.score?.section;

  return (
    <li className="py-6 border-b border-rule last:border-0">
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="font-sans text-xs text-ink3 flex items-center gap-2 flex-wrap min-w-0">
          {section && (
            <>
              <span className="uppercase tracking-[0.12em]">{section}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span>{a.sourceName}</span>
          <span aria-hidden>·</span>
          <PublishedAt iso={a.publishedAt} />
        </div>
        <div className="shrink-0">
          <PHBadge composite={a.score?.composite} size="sm" />
        </div>
      </div>

      {item.kind === "story" && (
        <div className="font-sans text-xs uppercase tracking-[0.12em] text-ink2 mb-1">
          {item.cluster.articleCount} outlets on this story
          {isValidComposite(item.cluster.phMin) && isValidComposite(item.cluster.phMax) && (
            <span className="text-ink3 normal-case tracking-normal">
              {" "}· scores run {item.cluster.phMin.toFixed(1)} to {item.cluster.phMax.toFixed(1)}
            </span>
          )}
        </div>
      )}

      <h2 className="font-serif text-h2 leading-snug m-0">
        <Link to={`/articles/${a.id}`} className={`hover:underline decoration-1 underline-offset-4 ${FOCUS_RING}`}>
          {a.title}
        </Link>
      </h2>

      {framing && <p className="font-sans text-sm text-ink3 mt-2 mb-0">{framing}</p>}

      {quote ? (
        <figure className="mt-3 mb-0">
          <blockquote className="font-serif text-base leading-relaxed border-l-2 border-rule-strong pl-4 m-0">
            <HighlightedText text={quote.text} markers={quote.markers} />
          </blockquote>
          <figcaption className="font-sans text-xs text-ink3 mt-2 pl-4 flex flex-wrap gap-x-3 gap-y-1">
            <span>{quote.tone === "loaded" ? "Its most loaded line" : "Its most grounded line"}</span>
            <a href={a.url} target="_blank" rel="noopener noreferrer" className={LINK}>
              Read it at {a.sourceName} ↗
            </a>
          </figcaption>
        </figure>
      ) : (
        <p className="font-sans text-xs text-ink3 mt-3 mb-0">
          No highlighted line from this piece in this edition.{" "}
          <a href={a.url} target="_blank" rel="noopener noreferrer" className={LINK}>
            Read it at {a.sourceName} ↗
          </a>
        </p>
      )}

      {item.kind === "story" && item.others.length > 0 && (
        <div className="font-sans text-xs text-ink3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Also told by</span>
          {item.others.map((o) => (
            <Link key={o.id} to={`/articles/${o.id}`} className={`inline-flex items-center gap-1 ${LINK}`}>
              <span aria-hidden className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: colorForComposite(o.composite) }} />
              {o.sourceName}
              {isValidComposite(o.composite) ? ` ${o.composite.toFixed(1)}` : ""}
            </Link>
          ))}
          {section && (
            <Link to={`/s/${section.toLowerCase()}`} className={LINK}>
              Compare every telling →
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
