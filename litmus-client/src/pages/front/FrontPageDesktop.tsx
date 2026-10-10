// The desktop front page, story-first: a continuous scroll of StoryCards
// inside LayoutDesktop's rail/feed shell (docs/plans/story-first-build-
// 2026-09-13.md, C3). Matches the approved mock's .feed spacing exactly.

import { Link } from "react-router-dom";
import { useStories } from "../../lib/useStories.ts";
import { StoryWireItemDesktop } from "../../components/story/StoryWireItem.tsx";

export function FrontPageDesktop() {
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
      <div className="flex justify-between items-baseline border-b border-rule pb-3.5 mb-2 font-sans text-sm text-ink2">
        <p className="m-0">{stories.length} {stories.length === 1 ? "story" : "stories"} in this edition</p>
      </div>
      <ul className="list-none p-0 m-0">
        {stories.map((story) => (
          <li key={story.id} className="border-b border-rule py-12 last:border-b-0">
            <StoryWireItemDesktop story={story} />
          </li>
        ))}
      </ul>
      <div className="text-center font-serif border-t border-rule pt-16 pb-4">
        <div className="flex justify-center gap-[3px] mb-4" aria-hidden>
          <span className="block w-[22px] h-[3px] rounded-sm bg-[#C0C9CE]" />
          <span className="block w-[22px] h-[3px] rounded-sm bg-[#B7AE8E]" />
          <span className="block w-[22px] h-[3px] rounded-sm bg-[#C1893C]" />
          <span className="block w-[22px] h-[3px] rounded-sm bg-[#C05A16]" />
          <span className="block w-[22px] h-[3px] rounded-sm bg-[#AD3118]" />
        </div>
        <p className="text-[22px] leading-[1.3] text-ink m-0">You&rsquo;re caught up.</p>
        <p className="font-sans text-sm text-ink3 mt-2.5 mb-0">
          <Link to="/about" className="underline decoration-1 underline-offset-2 hover:text-ink">
            How it works
          </Link>
        </p>
      </div>
    </div>
  );
}
