// The honest caveat, on the page where a reader would come to check the
// classification. Without it, a table of outlets against political labels reads
// as a measurement. Written once so the desktop and mobile versions cannot say
// different things; each version decides only where it sits and how large.

export function RosterCaveat({ className = "" }: { className?: string }) {
  return (
    <div className={`border-l-[6px] border-rule-strong pl-4 py-2 ${className}`}>
      <p className="font-sans m-0">
        <strong>Outlet baseline is LITMUS&rsquo;s own classification.</strong> It is a standing judgement about a
        publication, not a measurement of one, and it has no published rubric. It never changes from story to story.
        The other political reading LITMUS shows, <em>Article framing</em>, is scored from the writing itself and is
        independent of this. When the two disagree on an article, that disagreement is the finding.
      </p>
    </div>
  );
}

// The scope sentence that follows the counts on both versions.
export const ROSTER_SCOPE =
  "An edition draws only from the ones being read, and only from what they published inside the edition’s window, so the counts here are the roster and not the edition.";
