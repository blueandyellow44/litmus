// One report inside a story: outlet, headline, when, the score chip, the AI
// line on how it was told, the capped excerpt with highlights, and the link to
// the outlet. Two compositions over one model: the desktop row puts the chip
// beside the headline, the mobile row stacks and gives the outlet link the
// full width at 44px.
//
// Legal posture (the excerpt policy): the excerpt is the capped window the
// server already built; this row never has more text than that to show. A
// headline-only member has a headline and a link, nothing else. Every state
// prints its wording from lib/storyModel.ts, so no member is ever blank.

import { Link } from "react-router-dom";
import { HighlightedText } from "../HighlightedText.tsx";
import { PHBadge } from "../PHBadge.tsx";
import { CONTROL, FOCUS_RING, OutletBaseline, PublishedAt } from "../meta.tsx";
import type { StoryMemberDTO } from "../../lib/storyTypes.ts";
import { isScored, memberState, memberStateText, outletShortName } from "../../lib/storyModel.ts";

export interface MemberRowProps {
  member: StoryMemberDTO;
  // The outlet a syndicated copy came from, when the story carries it.
  originName?: string | null;
}

const OUT_LINK = `underline decoration-1 underline-offset-4 decoration-rule hover:decoration-ink ${FOCUS_RING}`;

export function readItAtText(member: Pick<StoryMemberDTO, "outletName">): string {
  return `Read it at ${outletShortName(member.outletName)}`;
}

function MemberMeta({ member }: { member: StoryMemberDTO }) {
  return (
    <div className="font-sans text-meta text-ink3 flex flex-wrap items-center gap-x-1.5">
      <span className="text-ink font-semibold">{outletShortName(member.outletName)}</span>
      <span aria-hidden>·</span>
      <OutletBaseline lean={member.sourceLean} />
      <span aria-hidden>·</span>
      <PublishedAt iso={member.publishedAt} />
    </div>
  );
}

// The headline is the outlet's, and it links to the outlet.
function MemberHeadline({ member, className }: { member: StoryMemberDTO; className: string }) {
  return (
    <a href={member.url} rel="noopener" className={`block font-serif text-ink no-underline hover:underline decoration-1 underline-offset-4 ${FOCUS_RING} ${className}`}>
      {member.title}
    </a>
  );
}

function MemberStateLine({ member, originName }: MemberRowProps) {
  const text = memberStateText(memberState(member), originName ?? null);
  if (!text) return null;
  return <p className="font-sans text-meta text-ink2 italic m-0">{text}</p>;
}

function MemberQuote({ member, textClass }: { member: StoryMemberDTO; textClass: string }) {
  if (!member.excerpt || member.excerpt.paragraphs.length === 0) return null;
  return (
    <blockquote className={`m-0 border-l border-rule pl-4 font-serif text-ink ${textClass}`}>
      {member.excerpt.paragraphs.map((para, i) => (
        <p key={i} className="mb-3 last:mb-0">
          <HighlightedText text={para} markers={member.excerpt?.markers ?? []} />
        </p>
      ))}
    </blockquote>
  );
}

function HowItWasTold({ member }: { member: StoryMemberDTO }) {
  if (!member.howItWasTold) return null;
  return <p className="font-sans text-sm text-ink2 m-0">{member.howItWasTold}</p>;
}

export function MemberRowDesktop({ member, originName = null }: MemberRowProps) {
  const scored = isScored(member);
  return (
    <article className="border-t border-rule py-5 grid grid-cols-[1fr_auto] gap-x-6 gap-y-3" aria-label={`${outletShortName(member.outletName)}: ${member.title}`}>
      <div className="min-w-0 flex flex-col gap-1.5">
        <MemberMeta member={member} />
        <MemberHeadline member={member} className="text-h3 py-1" />
        <MemberStateLine member={member} originName={originName} />
      </div>
      <div className="shrink-0 pt-6">{scored && <PHBadge composite={member.composite} size="md" />}</div>
      {(member.howItWasTold || member.excerpt) && (
        <div className="col-span-2 flex flex-col gap-3 max-w-prose">
          <HowItWasTold member={member} />
          <MemberQuote member={member} textClass="text-base" />
        </div>
      )}
      <div className="col-span-2 flex flex-wrap items-center gap-x-6 gap-y-2 font-sans text-sm">
        <a href={member.url} rel="noopener" className={`inline-flex items-center text-ink ${OUT_LINK} ${CONTROL}`}>
          {readItAtText(member)} <span aria-hidden className="ml-1">↗</span>
        </a>
        {scored && member.kind === "full" && (
          <Link to={`/articles/${member.articleId}`} className={`inline-flex items-center text-ink2 ${OUT_LINK} ${CONTROL}`}>
            Full analysis
          </Link>
        )}
      </div>
    </article>
  );
}

export function MemberRowMobile({ member, originName = null }: MemberRowProps) {
  const scored = isScored(member);
  return (
    <article className="border-t border-rule py-4 flex flex-col gap-2.5" aria-label={`${outletShortName(member.outletName)}: ${member.title}`}>
      <div className="flex items-start justify-between gap-3">
        <MemberMeta member={member} />
        {scored && (
          <span className="shrink-0">
            <PHBadge composite={member.composite} size="sm" />
          </span>
        )}
      </div>
      <MemberHeadline member={member} className="text-[20px] leading-[1.3] py-1.5" />
      <MemberStateLine member={member} originName={originName} />
      <HowItWasTold member={member} />
      <MemberQuote member={member} textClass="text-[17px] leading-[1.55]" />
      <a href={member.url} rel="noopener" className={`flex items-center justify-between font-sans text-sm text-ink border border-rule-strong rounded px-4 ${CONTROL}`}>
        <span>{readItAtText(member)}</span>
        <span aria-hidden>↗</span>
      </a>
      {scored && member.kind === "full" && (
        <Link to={`/articles/${member.articleId}`} className={`flex items-center font-sans text-sm text-ink2 ${OUT_LINK} ${CONTROL}`}>
          Full analysis
        </Link>
      )}
    </article>
  );
}
