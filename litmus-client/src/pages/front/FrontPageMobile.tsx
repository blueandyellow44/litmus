// The mobile front page, story-first: same data as the desktop version
// (useStories.ts), a single-column scroll of StoryCards. See
// FrontPageDesktop.tsx's header for what C3 scope this pass leaves for later.

import { Link } from "react-router-dom";
import { Fragment } from "react";
import { useStories } from "../../lib/useStories.ts";
import { LetterSignup } from "../../components/LetterSignup.tsx";
import { LETTER_FORM_ACTION } from "../../lib/brand.ts";
import { StoryWireItemMobile } from "../../components/story/StoryWireItem.tsx";

// How many stories a phone reader sees before the weekly letter is offered.
const LETTER_SLOT_AFTER = 3;

export function FrontPageMobile() {
  const { stories, error } = useStories();

  if (error) {
    return (
      <p>
        Could not load the stories. <span className="text-ink3">{error}</span>
      </p>
    );
  }
  if (!stories) return <p className="text-ink3">Loading…</p>;
  if (stories.length === 0) return <p className="text-ink3">No stories in this edition yet.</p>;

  return (
    <div>
      <ul className="list-none p-0 m-0 pt-4 flex flex-col gap-10">
        {stories.map((story, i) => (
          <Fragment key={story.id}>
            <li className="border-t border-rule pt-5 first:border-t-0 first:pt-0">
              <StoryWireItemMobile story={story} />
            </li>
            {/* After the third story: the footer form sits below every story in
                the edition, which most phone readers never reach. */}
            {LETTER_FORM_ACTION && i === LETTER_SLOT_AFTER - 1 && stories.length > LETTER_SLOT_AFTER && (
              <li className="border-t border-rule pt-5">
                <LetterSignup placement="front-feed" />
              </li>
            )}
          </Fragment>
        ))}
      </ul>
      <div className="py-8 font-sans text-sm text-ink3 flex flex-col items-center gap-2 text-center border-t border-rule mt-2">
        <p className="m-0">You&rsquo;re caught up.</p>
        <Link to="/about" className="underline decoration-1 underline-offset-2 hover:text-ink">
          How it works
        </Link>
      </div>
    </div>
  );
}
