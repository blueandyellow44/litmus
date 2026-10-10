// The All Stories page's non-list states: the edition failed, the edition is
// empty, nothing matches, no story was grouped. Shared by both versions so the
// wording of each finding is written once; `compact` only tightens spacing and
// widens the action for a phone.

import { CONTROL } from "../../components/meta.tsx";

interface Compact {
  compact?: boolean;
}

const panel = (compact?: boolean) => `${compact ? "mt-4 p-4" : "mt-8 p-6"} rounded border border-rule text-center`;

// Public copy. A reader is not a developer: telling them to run `npm run ingest`
// or to check `localhost:8787` is an instruction they cannot follow, about a
// machine that is not theirs, and it leaks the build process onto the page.
export function StoriesServerError({ msg, compact }: { msg: string } & Compact) {
  return (
    <div className={`${compact ? "mt-4" : "mt-8"} rounded border border-rule p-4 bg-surface`}>
      <p className="font-semibold m-0">This edition could not be loaded.</p>
      <p className="font-sans text-sm text-ink3 mt-2 mb-0">
        The paper is published as a fixed edition, so this is usually temporary. Reloading the page is worth a try; if
        it persists, the edition itself is being rebuilt.
      </p>
      <p className="font-sans text-xs text-ink3 mt-3 mb-0 break-words">Technical detail: {msg}</p>
    </div>
  );
}

export function StoriesEmpty({ compact }: Compact) {
  return (
    <div className={panel(compact)}>
      <p className="font-serif text-h3">This edition has no articles in it.</p>
      <p className="font-sans text-sm text-ink3 mt-3">
        A LITMUS edition is compiled twice a day. When the next one is published, its stories will appear here.
      </p>
    </div>
  );
}

// The distinction is a real one: "nothing in the edition matches" is a FINDING
// about the edition, while "nothing in the part that loaded matches" is a fact
// about the network.
export function StoriesNoMatches({
  onClear,
  editionComplete,
  total,
  compact,
}: {
  onClear: () => void;
  editionComplete: boolean;
  total: number;
} & Compact) {
  return (
    <div className={panel(compact)}>
      <p className="font-serif text-h3">
        {editionComplete ? "No article in this edition matches those filters." : "No match among the articles that loaded."}
      </p>
      <p className="font-sans text-sm text-ink3 mt-3">
        {editionComplete
          ? `That is a real answer about all ${total} articles in this edition, not an error. Widen a filter to see more.`
          : `Part of this edition did not load, so this is not a complete answer. Reload the page, or widen a filter to see what did arrive.`}
      </p>
      <button
        type="button"
        onClick={onClear}
        className={`mt-4 font-sans text-sm border border-ink px-5 hover:bg-ink hover:text-ground transition-colors ${CONTROL} ${
          compact ? "w-full" : ""
        }`}
      >
        Clear all filters
      </button>
    </div>
  );
}

export function StoriesNoClusters({ compact }: Compact) {
  return (
    <div className={panel(compact)}>
      <p className="font-serif text-h3">No stories were covered by more than one outlet in this edition.</p>
      <p className="font-sans text-sm text-ink3 mt-3">Switch back to Feed to read the edition article by article.</p>
    </div>
  );
}
