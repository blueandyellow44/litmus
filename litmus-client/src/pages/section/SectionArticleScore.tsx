// One section article's P/H score as a coloured number and band word. Shared by
// the desktop coverage grid and the mobile coverage list so the two cannot word
// an unscored or corrupt score differently.

import { bandWord, colorForComposite, isValidComposite, UNRATED_LABEL } from "../../lib/phBand.ts";

export function SectionArticleScore({ composite, className = "" }: { composite: number | null; className?: string }) {
  if (isValidComposite(composite)) {
    // The word comes from the number, not from the stored label, so a stale
    // label cannot contradict the colour beside it.
    return (
      <span className={`font-bold whitespace-nowrap ${className}`} style={{ color: colorForComposite(composite) }}>
        {composite.toFixed(1)} {bandWord(composite)}
      </span>
    );
  }
  // Covers both "never scored" and "scored to something that is not a number on
  // the scale". Neither may borrow a band's word.
  return (
    <span className={`text-ink3 whitespace-nowrap ${className}`}>
      {composite === null ? "P/H not scored" : UNRATED_LABEL}
    </span>
  );
}
