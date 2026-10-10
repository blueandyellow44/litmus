// The About page's words, shared by AboutDesktop.tsx and AboutMobile.tsx. Each
// block is the inside of one paragraph or list item; the version decides the
// wrapper, spacing, and whether a block sits behind a disclosure. Nothing here
// may be dropped by a version: mobile can fold a block, never omit it.
//
// The "rating, not a measurement" paragraph is the page's honesty statement.
// Neither version folds it.

import type { ReactNode } from "react";

// ── Lede ───────────────────────────────────────────────────────────────────

export const LEDE: readonly ReactNode[] = [
  <>News used to be information. Now it is a product, and you are the buyer.</>,
  <>
    The product is sold on political identity. An outlet picks its audience and pitches to it. Once you are bought
    in, the language turns hysterical, because outrage keeps you reading. Over time you internalize the product and
    reject the competitor&rsquo;s. That is not being informed. That is being retained.
  </>,
];

// ── The two readings ───────────────────────────────────────────────────────

export const READINGS_INTRO: ReactNode = <>LITMUS shows two independent readings of every story.</>;

export interface Reading {
  name: string;
  body: ReactNode;
}

export const READINGS: readonly Reading[] = [
  {
    name: "Where it leans.",
    body: (
      <>
        The pitch. LITMUS shows this two ways, and they are different claims. <strong>Outlet baseline</strong> is a
        standing classification of the publication, which does not change from story to story.{" "}
        <strong>Article framing</strong> is a reading of where <em>this particular piece</em> sits, judged from the
        writing itself and not from the outlet&rsquo;s reputation. They often disagree, and where they do, the
        disagreement is the finding.
      </>
    ),
  },
  {
    name: "How it is told.",
    body: (
      <>
        The pressure. The <strong>Proportionate-to-Hyperbolic Balance</strong>, a 1-to-5 rating of whether the writing
        informs you or works on you. A left-leaning piece can score 1.2. A right-leaning piece can score 1.2. The two
        readings are independent by design.
      </>
    ),
  },
];

export const RATING_NOT_MEASUREMENT: ReactNode = (
  <>
    Both readings are produced by a language model working to a published rubric, then checked by code. That is worth
    stating plainly: they are a rating, not a measurement, and not ground truth. The rubric is written down and the
    arithmetic is inspectable, so you can see how a number was reached and disagree with it on the evidence. What
    LITMUS does not have is a benchmark of human-labelled articles proving the ratings match what careful readers
    would say. Until that exists, treat every score here as calibrated to a rubric rather than verified against
    reality.
  </>
);

// ── What gets scored ───────────────────────────────────────────────────────

export const SCORED_DIMENSIONS: ReactNode = (
  <>
    Every article is rated on five dimensions: headline framing, language intensity, source balance, logical
    fallacies, and structural manipulation. Headline and language carry double weight, because the headline is what
    most people read and the language runs through everything else.
  </>
);

// The label mobile puts on the disclosure around SCORED_CALCULATION.
export const SCORED_CALCULATION_SUMMARY = "How the number is calculated";

export const SCORED_CALCULATION: ReactNode = (
  <>
    The number you see is not a holistic impression. It is calculated, in code, from those five dimensions. The reader
    who wants to check it can: the calculation is a weighted average, and a small set of structured findings can raise
    the floor under a dimension before the average is taken. A loaded headline cannot leave the headline dimension
    below 3.0. An emotional opening cannot leave the structure dimension below 3.0. One-sided sourcing cannot leave
    source balance below 3.0. Counted logical fallacies raise the floor under the fallacies dimension. A floor is a
    minimum, never a surcharge, so a dimension already scored above its floor is untouched.
  </>
);

export const SCORED_HOLISTIC_CHECK: ReactNode = (
  <>
    There is a holistic judgment in the process, and it is a separate step: the scorer names which band it thinks the
    article belongs to before any arithmetic happens. That reading is a check on the dimensions, not the published
    number. When the two land far apart, the article is held back rather than published.
  </>
);

// ── What it is not ─────────────────────────────────────────────────────────

export const NOT_A_FACT_CHECKER: readonly ReactNode[] = [
  <>
    It is not a fact-checker. It cannot tell you whether a claim is true. What it offers is a second opinion on the
    writing: a reading of where a story&rsquo;s framing sits and how hard the prose is working on you, with the
    specific words and structures behind that reading highlighted so you can check the judgement against the article
    rather than take it on trust.
  </>,
  <>
    It will be wrong about some articles. Every rating on this site is a model&rsquo;s reading of a text, and readings
    differ. The highlights and the term-by-term breakdown are there so that when you disagree, you can see exactly
    where.
  </>,
];

// No closing line here. "LITMUS does not tell you what to think." used to end the
// page, but both shells' footers carry the same message directly below it, so the
// reader met the sentence twice in a row. The footer now states it once.
