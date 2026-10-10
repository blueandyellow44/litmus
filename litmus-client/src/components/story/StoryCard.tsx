// The front-page unit: one story, three layers, in order. The event leads —
// the ruling from the 2026-09-13/14 design argument ("it is dominated by the
// body of one story with a couple of underlines and the plot is lost").
// Layer 1 is Sonnet's plain assessment, never a single outlet's own framing
// line; Layer 2 is the matrix, right there as evidence, not hidden behind a
// fold; Layer 3 is descriptive framing notes only (shadow Distortion stays
// off this card and every other public surface).
//
// Multi-outlet stories get the full two-layer spread. A single-outlet story
// (ruling 3, story-first build plan: "publish, lower in the order, labelled
// as such") gets a compact, quieter row instead — a one-dot matrix answered
// nothing worth a 372px column for, and giving it the same weight as a real
// six-outlet comparison buried the stories that actually have one (Max,
// reviewing the live build, 2026-09-17).

import { Link } from "react-router-dom";
import type { StoryDTO } from "../../lib/storyTypes.ts";
import { coverageLine, phRangeText, storyPath } from "../../lib/storyModel.ts";
import { StoryMatrix } from "./StoryMatrix.tsx";
import { TemperatureStrip } from "./TemperatureStrip.tsx";
import { FramingNotes } from "./FramingNotes.tsx";
import { CONTROL, FOCUS_RING } from "../meta.tsx";

interface Props {
  story: StoryDTO;
  className?: string;
}

function StoryMeta({ story }: { story: StoryDTO }) {
  return (
    <p className="font-sans text-[13.5px] font-medium leading-[1.3] text-ink2 tabular-nums flex flex-wrap items-center gap-x-3.5 gap-y-1 m-0">
      <span>{coverageLine(story)}</span>
      <span aria-hidden className="inline-block w-[3px] h-[3px] rounded-full bg-ink3" />
      <span>{phRangeText(story.phMin, story.phMax)}</span>
    </p>
  );
}

function Assessment({ story, className }: { story: StoryDTO; className: string }) {
  if (!story.assessment) {
    return (
      <p className={`font-sans text-sm text-ink2 italic ${className}`} role="status">
        Assessment pending for this story.
      </p>
    );
  }
  return (
    <div className={`font-serif text-ink ${className}`}>
      {story.assessment.text.split("\n\n").map((para, i) => (
        <p key={i} className="m-0 mb-3 last:mb-0">{para}</p>
      ))}
    </div>
  );
}

// Matches the approved mock's .s-more exactly: an underline riding the
// baseline, not a link colour, and the arrow steps out a touch on hover.
const READ_LINK_DESKTOP = `group inline-flex items-center gap-2 font-sans text-[14.5px] font-medium text-ink no-underline border-b border-ink pb-1 ${FOCUS_RING} ${CONTROL}`;
const READ_LINK_MOBILE = `inline-flex items-center gap-1 font-sans text-sm text-ink underline decoration-1 underline-offset-4 decoration-rule hover:decoration-ink ${FOCUS_RING} ${CONTROL}`;

function composites(story: StoryDTO): number[] {
  return story.members.map((m) => m.composite).filter((c): c is number => c !== null);
}

// The compact row a single-outlet story gets, desktop and mobile alike: no
// matrix (one dot answers no comparison), a smaller headline, and the strip
// alone carries the P/H read. "Only one outlet has covered this so far" is
// the honest state, not an empty chart pretending there is something to plot.
function SingleOutletCard({ story, className = "" }: Props) {
  return (
    <article className={`max-w-[560px] ${className}`} aria-labelledby={`${story.id}-h`}>
      <TemperatureStrip composites={composites(story)} className="mb-3" />
      <p className="font-sans text-[13px] text-ink3 m-0 mb-1.5">Only one outlet has covered this so far.</p>
      <h2 id={`${story.id}-h`} className="font-serif text-[21px] leading-[1.25] font-medium m-0 text-wrap-balance">
        <Link to={storyPath(story)} className={`text-ink no-underline hover:underline decoration-1 underline-offset-[0.18em] ${FOCUS_RING}`}>
          {story.headline}
        </Link>
      </h2>
      <Assessment story={story} className="text-[15.5px] leading-[1.5] mt-2" />
    </article>
  );
}

export function StoryCardDesktop({ story, className = "" }: Props) {
  if (story.singleOutlet) return <SingleOutletCard story={story} className={className} />;
  return (
    <article className={className} aria-labelledby={`${story.id}-h`}>
      <TemperatureStrip composites={composites(story)} className="mb-5" />
      <div className="grid grid-cols-[minmax(0,1fr)_372px] gap-14 items-center">
        <div className="min-w-0">
          <StoryMeta story={story} />
          <h2 id={`${story.id}-h`} className="font-serif text-[32px] leading-[1.16] tracking-[-0.005em] font-medium m-0 mt-3.5 max-w-[22em] text-wrap-balance">
            <Link to={storyPath(story)} className={`text-ink no-underline hover:underline decoration-1 underline-offset-[0.18em] ${FOCUS_RING}`}>
              {story.headline}
            </Link>
          </h2>
          <Assessment story={story} className="text-xl leading-[1.55] mt-4 max-w-[36em]" />
          {story.notes.length > 0 && (
            <FramingNotes notes={story.notes} singleOutlet={story.singleOutlet} layout="desktop" className="mt-4 max-w-[36em]" />
          )}
          <Link to={storyPath(story)} className={`${READ_LINK_DESKTOP} mt-[22px]`}>
            Full story: the matrix, every outlet
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
          </Link>
        </div>
        <div className="border-l border-rule pl-7 grid gap-5">
          <StoryMatrix members={story.members} preset="front" id={`${story.id}-matrix`} />
        </div>
      </div>
    </article>
  );
}

export function StoryCardMobile({ story, className = "" }: Props) {
  if (story.singleOutlet) return <SingleOutletCard story={story} className={className} />;
  return (
    <article className={`flex flex-col gap-3 ${className}`} aria-labelledby={`${story.id}-h`}>
      <TemperatureStrip composites={composites(story)} />
      <StoryMeta story={story} />
      <h2 id={`${story.id}-h`} className="font-serif text-[25px] leading-[1.2] font-medium m-0 text-wrap-balance">
        <Link to={storyPath(story)} className={`text-ink no-underline hover:underline decoration-2 underline-offset-4 ${FOCUS_RING}`}>
          {story.headline}
        </Link>
      </h2>
      <Assessment story={story} className="text-[17px] leading-[1.55]" />
      <StoryMatrix members={story.members} preset="front" id={`${story.id}-matrix`} />
      {story.notes.length > 0 && (
        <FramingNotes notes={story.notes} singleOutlet={story.singleOutlet} layout="mobile" />
      )}
      <Link to={storyPath(story)} className={`${READ_LINK_MOBILE} justify-between border border-rule-strong rounded px-4 py-3`}>
        <span>Full story: the matrix, every outlet</span>
        <span aria-hidden>→</span>
      </Link>
    </article>
  );
}
