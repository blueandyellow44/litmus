// The front-page unit. Two rulings on 2026-09-26, both Max's:
//   1. After reading the mobile page on his phone (one story per screen, the
//      chart taking most of it): a compact wire item.
//   2. Later the same day: every front-page story carries the matrix beside
//      it and, in order, the AI summary; the strongest practical line and the
//      most hysterical line, each with its outlet; then the tellings' own
//      excerpts, highlighted, each with why it scored the way it did. The
//      excerpts run to the legal maximum per article (200 words or 25%,
//      server-capped, the excerpt policy), about 500 words in all.

import type { StoryDTO, StoryMemberDTO } from "../../lib/storyTypes.ts";
import {
  evidenceQuotes,
  frontExcerpts,
  memberState,
  memberStateText,
  outletRows,
  tellingCount,
  calmAndHot,
  type TellingRead,
  outletShortName,
  scoreText,
  wireCoverageLine,
  wireLede,
  type ExtremeLine,
} from "../../lib/storyModel.ts";
import { HIGHLIGHT_CLASS } from "../../lib/highlight.ts";
import { TemperatureStrip } from "./TemperatureStrip.tsx";
import { StoryMatrix } from "./StoryMatrix.tsx";
import { HighlightedText } from "../HighlightedText.tsx";
import { PHBadge } from "../PHBadge.tsx";
import { useState } from "react";
import { CONTROL, FOCUS_RING } from "../meta.tsx";

interface Props {
  story: StoryDTO;
  className?: string;
}

// The strip's range comes from one telling per outlet, like the count beside it.
function composites(story: StoryDTO): number[] {
  return story.members.filter((m) => m.role === "primary").map((m) => m.composite).filter((c): c is number => c !== null);
}


function Summary({ story, className }: { story: StoryDTO; className: string }) {
  const paragraphs = story.assessment?.text.split("\n\n").filter((p) => p.trim()) ?? [];
  if (paragraphs.length === 0) {
    const lede = wireLede(story);
    return lede ? <p className={`font-serif text-ink m-0 ${className}`}>{lede}</p> : null;
  }
  return (
    <div className={`font-serif text-ink ${className}`}>
      {paragraphs.map((para, i) => <p key={i} className="m-0 mb-3 last:mb-0">{para}</p>)}
    </div>
  );
}

// The line in its sentence, the span highlighted, then why it was marked. A
// bare quoted word ("self-appointed") with no sentence and no reason told the
// reader nothing (Max, 2026-10-02).
function Line({ line, kind }: { line: ExtremeLine; kind: "grounded" | "loaded" }) {
  const at = line.sentence.indexOf(line.text);
  const before = at >= 0 ? line.sentence.slice(0, at) : "";
  const after = at >= 0 ? line.sentence.slice(at + line.text.length) : "";
  return (
    <>
      <p className="font-serif text-[17px] leading-[1.45] text-ink m-0">
        &ldquo;{before}<span className={HIGHLIGHT_CLASS[kind]}>{line.text}</span>{after}&rdquo;
      </p>
      <p className="font-sans text-[13.5px] leading-[1.45] text-ink2 m-0">{line.why}</p>
    </>
  );
}

// A telling with no line of its kind still has something to read: the
// opening of its excerpt, with whatever the scorer marked in it.
function Opening({ member, text, kind }: { member: StoryMemberDTO; text: string; kind: "grounded" | "loaded" }) {
  return (
    <>
      <p className="font-serif text-[17px] leading-[1.45] text-ink m-0">
        &ldquo;<HighlightedText text={text} markers={member.excerpt?.markers ?? []} />&rdquo;
      </p>
      <p className="font-sans text-[13.5px] leading-[1.45] text-ink2 m-0">
        Its opening. No {kind === "grounded" ? "grounded" : "loaded"} line marked in the excerpt.
      </p>
    </>
  );
}

// A headline's own quotation marks become single quotes inside ours; straight
// double quotes alternate open and close.
function innerQuotes(text: string): string {
  let open = true;
  return text.replace(/[“”"]/g, (ch) => {
    if (ch === "“") return "‘";
    if (ch === "”") return "’";
    open = !open;
    return open ? "’" : "‘";
  });
}

// One block per outlet (Max, 2026-10-08: "summary, calmest telling, hottest
// telling, matrix, then show the x tellings button"): the outlet and its
// score, its own headline, then its strongest line of the matching kind or,
// when it has none, its opening. The two blocks are symmetrical (Max, same
// day: "calmest and hottest must be symetrical in what they cover"): the
// hottest no longer carries the 10-06 driver reading or "Grounded
// throughout", because the calmest had nothing to match them.
function TellingBlock({ label, read, kind }: { label: string; read: TellingRead; kind: "grounded" | "loaded" }) {
  const { member, line, opening } = read;
  const title = member.title.trim();
  return (
    <section className="grid gap-1" aria-label={`${label}: ${outletShortName(member.outletName)}`}>
      <p className="font-sans text-[13px] tracking-[0.08em] uppercase text-ink3 m-0">{label}</p>
      <p className="font-sans text-[13.5px] text-ink2 m-0">
        <a href={member.url} rel="noopener" className={`font-semibold text-ink no-underline hover:underline ${FOCUS_RING}`}>
          {outletShortName(member.outletName)}
        </a>{" "}· {scoreText(member.composite)}
      </p>
      {title && <p className="font-serif text-[17px] leading-[1.35] font-medium text-ink m-0">&ldquo;{innerQuotes(title)}&rdquo;</p>}
      {line ? <Line line={line} kind={kind} /> : opening ? <Opening member={member} text={opening} kind={kind} /> : null}
    </section>
  );
}

function CalmAndHot({ story, className = "" }: { story: StoryDTO; className?: string }) {
  const { calm, hot } = calmAndHot(story);
  if (!calm) return null;
  return (
    <div className={`grid gap-5 border-y border-rule py-4 ${className}`}>
      <TellingBlock label="Calmest telling" read={calm} kind="grounded" />
      {hot && <TellingBlock label="Hottest telling" read={hot} kind="loaded" />}
    </div>
  );
}

// One row per outlet (Max, 2026-09-26: "under each outlet evidence of why we
// rated their article the way we did"). Score; the scorer's own reason,
// paraphrased; up to four short quotes of its marked wording, split, each from
// inside the published excerpt; and, for the calmest, a middle and the hottest
// telling, the whole excerpt with its highlights. Unscored outlets say so.
function OutletEvidence({ member, fullExcerpt, textClass }: { member: StoryMemberDTO; fullExcerpt: boolean; textClass: string }) {
  const name = outletShortName(member.outletName);
  const quotes = evidenceQuotes(member);
  const state = memberStateText(memberState(member));
  return (
    <section className="grid gap-2 border-t border-rule pt-4" aria-label={`Why ${name} scored as it did`}>
      <div className="flex items-center justify-between gap-3">
        <a href={member.url} rel="noopener" className={`font-sans text-[13.5px] font-semibold text-ink no-underline hover:underline ${FOCUS_RING}`}>
          {name} <span aria-hidden className="font-normal text-ink3">↗</span>
        </a>
        {state ? <span className="font-sans text-[12.5px] italic text-ink3">{state}</span> : <PHBadge composite={member.composite} size="sm" />}
      </div>
      {member.howItWasTold && (
        <p className="font-sans text-[14px] leading-[1.45] text-ink2 m-0">
          <span className="font-semibold text-ink">Why {scoreText(member.composite)}:</span> {member.howItWasTold}
        </p>
      )}
      {quotes.length > 0 && (
        <ul className="list-none m-0 p-0 flex flex-wrap gap-x-3 gap-y-1.5 font-serif text-[15px] leading-[1.4]" aria-label="Its wording">
          {quotes.map((q) => (
            <li key={q.text}>&ldquo;<span className={HIGHLIGHT_CLASS[q.kind]}>{q.text}</span>&rdquo;</li>
          ))}
        </ul>
      )}
      {fullExcerpt && member.excerpt && (
        <blockquote className={`m-0 mt-1 border-l border-rule pl-4 font-serif text-ink ${textClass}`}>
          {member.excerpt.paragraphs.map((para, i) => (
            <p key={i} className="m-0 mb-3 last:mb-0">
              <HighlightedText text={para} markers={member.excerpt!.markers} />
            </p>
          ))}
        </blockquote>
      )}
    </section>
  );
}

function Tellings({ story, textClass, className = "" }: { story: StoryDTO; textClass: string; className?: string }) {
  const rows = outletRows(story);
  if (rows.length === 0) return null;
  const withExcerpt = new Set(frontExcerpts(story).map((m) => m.articleId));
  return (
    <div className={`grid gap-4 ${className}`}>
      {rows.map((member) => (
        <OutletEvidence key={member.articleId} member={member} fullExcerpt={withExcerpt.has(member.articleId)} textClass={textClass} />
      ))}
    </div>
  );
}

// The story's anchor on the page. The headline links to it so a story can be
// shared or returned to; there is still no separate story page (Max,
// 2026-09-26), the card is the whole story.
export function storyAnchor(story: Pick<StoryDTO, "slug">): string {
  return `story-${story.slug}`;
}

function Header({ story, size }: { story: StoryDTO; size: string }) {
  return (
    <>
      <TemperatureStrip composites={composites(story)} className="mb-3" />
      <h2 id={`${story.id}-h`} className={`font-serif font-medium m-0 text-wrap-balance ${size}`}>
        <a href={`#${storyAnchor(story)}`} className={`text-ink no-underline hover:underline hover:decoration-1 hover:underline-offset-4 ${FOCUS_RING}`}>
          {story.headline}
        </a>
      </h2>
    </>
  );
}

// Every card opens collapsed (Max, 2026-10-02, audit section 1: 92 stories
// made a 182,000px page): strip, headline, assessment, the calmest and hottest
// tellings (2026-10-08) and the chart. One control opens the per-outlet evidence and the chart's
// table. A story reached by its anchor opens expanded.
function useExpanded(story: StoryDTO): [boolean, () => void] {
  const [expanded, setExpanded] = useState(() => {
    try {
      return typeof window !== "undefined" && window.location.hash === `#${storyAnchor(story)}`;
    } catch {
      return false;
    }
  });
  return [expanded, () => setExpanded((open) => !open)];
}

function ExpandControl({ story, expanded, onToggle, className = "" }: { story: StoryDTO; expanded: boolean; onToggle: () => void; className?: string }) {
  const n = tellingCount(story);
  if (n === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={`${story.id}-tellings`}
      className={`font-sans text-[14px] font-semibold text-ink bg-transparent border border-rule rounded-sm px-3.5 py-2 hover:border-ink2 cursor-pointer ${CONTROL} ${FOCUS_RING} ${className}`}
    >
      {expanded ? "Hide the tellings" : `Show the ${n} telling${n === 1 ? "" : "s"}`}
    </button>
  );
}

export function StoryWireItemDesktop({ story, className = "" }: Props) {
  const [expanded, toggle] = useExpanded(story);
  return (
    <article id={storyAnchor(story)} className={`scroll-mt-6 ${className}`} aria-labelledby={`${story.id}-h`}>
      {/* Every card carries the chart, two-outlet stories included (Max,
          2026-10-05: the chart came and went from card to card). */}
      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-12 items-start">
        <div className="min-w-0 max-w-[40em]">
          <Header story={story} size="text-[28px] leading-[1.18]" />
          <Summary story={story} className="text-[18px] leading-[1.55] mt-3" />
          <p className="font-sans text-[14px] text-ink2 tabular-nums m-0 mt-3">{wireCoverageLine(story)}</p>
          <CalmAndHot story={story} className="mt-5" />
          <ExpandControl story={story} expanded={expanded} onToggle={toggle} className="mt-5" />
          <div id={`${story.id}-tellings`} hidden={!expanded}>
            {expanded && <Tellings story={story} textClass="text-[16px] leading-[1.55]" className="mt-6" />}
          </div>
        </div>
        <div className="sticky top-6 border-l border-rule pl-7">
          <StoryMatrix members={story.members} preset="front" id={`${story.id}-matrix`} withTable={expanded} />
        </div>
      </div>
    </article>
  );
}

export function StoryWireItemMobile({ story, className = "" }: Props) {
  const [expanded, toggle] = useExpanded(story);
  return (
    <article id={storyAnchor(story)} className={`scroll-mt-16 ${className}`} aria-labelledby={`${story.id}-h`}>
      <Header story={story} size="text-[22px] leading-[1.22]" />
      <Summary story={story} className="text-[16.5px] leading-[1.5] mt-2.5" />
      <p className="font-sans text-[13px] text-ink2 tabular-nums m-0 mt-2.5">{wireCoverageLine(story)}</p>
      <CalmAndHot story={story} className="mt-4" />
      <StoryMatrix members={story.members} preset="front" id={`${story.id}-matrix`} className="mt-4" withTable={expanded} />
      <ExpandControl story={story} expanded={expanded} onToggle={toggle} className="mt-4 w-full" />
      <div id={`${story.id}-tellings`} hidden={!expanded}>
        {expanded && <Tellings story={story} textClass="text-[16px] leading-[1.5]" className="mt-5" />}
      </div>
    </article>
  );
}
