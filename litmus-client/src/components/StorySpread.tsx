// The story spread: one trending story rendered the LITMUS way — The Facts
// (invariant), the Map of how every outlet covered it, and the calmest
// telling beside the hottest (same story, two tellings). Shared by every
// section page.
//
// The Reading-as lens is cut (story-first plan, ruling 6, 2026-09-17): every
// reader now gets the Mixed rendering unconditionally. pickLead's side-lens
// sort and the non-mixed tellings branch below are unreachable now that
// nothing ever passes "liberal" or "conservative" — left in place rather than
// deleted, since sectionModel.ts's SpreadModel/TellingsModel still carry the
// same readingAs-shaped contract and a fuller cleanup touches that type too.

import { Link } from "react-router-dom";
import type { SectionPageDTO, SectionArticleDTO, Label } from "../lib/types.ts";
import { TheMap } from "./TheMap.tsx";
import { bandForComposite, bandWord, colorForComposite, isValidComposite, UNRATED_LABEL } from "../lib/phBand.ts";
import { ExcerptBlock, HighlightLegend } from "./ExcerptBlock.tsx";
import { ClaimReceipts } from "./ClaimReceipts.tsx";
import { ArticleFraming, FOCUS_RING, OutletBaseline } from "./meta.tsx";

type Scored = SectionArticleDTO & { politicalLean: number; composite: number };
function isScored(a: SectionArticleDTO): a is Scored {
  return a.politicalLean !== null && a.composite !== null;
}

// Which single article leads under a side lens: leftmost for Liberal, rightmost
// for Conservative (ties break to the more practical). Mixed uses the contrast
// pair below instead, so this is only consulted for the side lenses.
export function pickLead(articles: SectionArticleDTO[], readingAs: string): SectionArticleDTO | null {
  const scored = articles.filter(isScored);
  if (scored.length === 0) return articles[0] ?? null;
  const sorted = [...scored].sort((a, b) =>
    readingAs === "conservative"
      ? b.politicalLean - a.politicalLean || a.composite - b.composite
      : a.politicalLean - b.politicalLean || a.composite - b.composite,
  );
  return sorted[0] ?? null;
}

// The calmest telling of a story beside the hottest. The axis is P/H
// TEMPERATURE, ruled by Max (2026-09-02, reaffirming 5cc1568): this feature
// contrasts how hot the telling runs, and it does not claim political breadth.
//
// Political lean plays no part in the selection, not even as a tie-break. It
// used to break ties "toward the more extreme telling on each side", which
// sounds harmless and is not: it let a lean label change which two articles the
// reader is shown, so the pair was partly political while the captions and the
// scale said temperature. Ties now break on id, which is stable, lean-free, and
// still guarantees two distinct articles.
//
// The comment block that used to sit here described a left-versus-right pairing
// that the code had not done since 5cc1568. Anyone reading it would have
// believed the feature made a promise it does not make.
export function pickContrast(articles: SectionArticleDTO[]): { left: SectionArticleDTO; right: SectionArticleDTO } | null {
  // composite must be present, not merely coalesced to 0. An unscored article
  // sorts to the front as if it were the calmest thing on the page and then
  // renders with no P/H badge at all, which is the opposite of the claim the
  // caption makes about it.
  const usable = articles.filter(
    (a) => a.composite !== null && a.excerpt && a.excerpt.paragraphs.length > 0,
  );
  if (usable.length < 2) return null;
  // Coolest first, hottest last. The tie-break matters more than it looks: the
  // original used min/max reducers over composite, so when every article on a
  // story scored the same — three at 1.9 on the lead — min and max returned the
  // SAME article, the identity guard fired, and the feature rendered nothing at
  // all. Sorting with a stable tie-break guarantees two distinct ARTICLES
  // whenever two are usable; the loop below can still return null when every
  // usable article shares one source — see its comment.
  //
  // id, not lean. See the note above the function.
  const sorted = [...usable].sort(
    (a, b) => (a.composite ?? 0) - (b.composite ?? 0) || a.id - b.id,
  );

  // The global coolest and hottest can be the SAME outlet publishing both
  // ends of the range on one story. Captioning that pair a "contrast" would
  // set an outlet against itself, not show two tellings, so the search widens
  // to the widest gap between two DIFFERENT sources rather than settling for
  // min/max whenever they collide. `sorted` holds one story's articles — small
  // enough that the O(n^2) scan for the true widest cross-source gap costs
  // nothing worth avoiding. Ties on gap break to the smaller left id, then the
  // LARGER right id — preferring the widest id-spread reproduces the original
  // behavior when every composite ties (every gap is 0): the pair still spans
  // the full set rather than collapsing to two adjacent ids.
  let best: { left: SectionArticleDTO; right: SectionArticleDTO; gap: number } | null = null;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = sorted.length - 1; j > i; j--) {
      const left = sorted[i]!;
      const right = sorted[j]!;
      if (left.sourceId === right.sourceId) continue;
      const gap = (right.composite ?? 0) - (left.composite ?? 0);
      if (
        !best ||
        gap > best.gap ||
        (gap === best.gap &&
          (left.id < best.left.id || (left.id === best.left.id && right.id > best.right.id)))
      ) {
        best = { left, right, gap };
      }
    }
  }
  // Every usable article on this story shares one source — there is no pair
  // to contrast, not a bug to paper over with a same-outlet pairing.
  if (!best) return null;
  return { left: best.left, right: best.right };
}

// The lean ordering that used to break ties here is deliberately gone rather
// than left unused. A ranking of political leans sitting beside the comparator
// is an invitation to put it back, and the ruling is that lean never
// participates in choosing this pair. Lean is still DISPLAYED on each telling —
// readers are told which outlet they are reading — it just does not select.

// Whether the pair is far enough apart to be CALLED a temperature contrast.
// The pair always renders — two tellings of one story is worth reading either
// way — but on a story where every outlet landed within a few tenths, captioning
// one of two Grounded articles the "hottest telling" asserts a difference the
// scores do not show. Below this gap the labels drop the claim and simply say
// there are two tellings. Half a point is one full band on the 1-5 scale.
const REAL_CONTRAST_GAP = 0.5;
export function contrastIsReal(c: { left: SectionArticleDTO; right: SectionArticleDTO }): boolean {
  if (c.left.composite === null || c.right.composite === null) return false;
  return c.right.composite - c.left.composite >= REAL_CONTRAST_GAP;
}

// ── What the page may SAY about political breadth ──────────────────────────
//
// None of this selects anything. The featured pair is the widest P/H temperature
// contrast between distinct sources and political lean plays no part in choosing
// it (Decision 2, ruled by Max 2026-09-02, locked; `pickContrast` above is
// untouched). What follows is only a report on what the reader is looking at.
//
// The distinction that was being lost: whether the PAIR spans both wings and
// whether the STORY does are two different facts, and the page was answering the
// second question with the first one's answer. A story covered by The Nation and
// the Federalist and four centrists, whose two hottest-and-calmest tellings both
// happen to be centrist, is not a coverage gap. Telling a reader it was one
// would be a false claim about the edition, made in the exact place the product
// promises to be honest about coverage.

export type Wing = "L" | "R" | "C";

export function wingOf(sourceLean: string): Wing {
  if (sourceLean === "left" || sourceLean === "center-left") return "L";
  if (sourceLean === "right" || sourceLean === "center-right") return "R";
  return "C"; // center, and anything unrecognised
}

// Whether the two FEATURED tellings sit on opposite wings.
//
// Center plus a wing is neither bilateral nor "the same side". A centrist outlet
// beside a right-leaning one has not been shown to agree with it, and captioning
// that pair "both from the same side" would be a claim the baselines do not
// support. It returns false here and the caller distinguishes the three cases.
export function spansBothWings(c: { left: SectionArticleDTO; right: SectionArticleDTO }): boolean {
  const a = wingOf(c.left.sourceLean);
  const b = wingOf(c.right.sourceLean);
  return (a === "L" && b === "R") || (a === "R" && b === "L");
}

export interface StoryBreadth {
  // Distinct SOURCES on each wing across the complete article set for the story,
  // not across the featured pair.
  left: string[];
  right: string[];
  center: string[];
  bilateral: boolean;
}

// Measured over every article on the story, whether or not it was scored,
// excerpted, or eligible to be featured. A right-leaning outlet whose piece has
// no excerpt still covered the story, and a reader told "no left-and-right pair
// exists here" would be told something false about the edition.
export function storyBreadth(articles: SectionArticleDTO[]): StoryBreadth {
  const byWing: Record<Wing, Set<string>> = { L: new Set(), R: new Set(), C: new Set() };
  for (const a of articles) byWing[wingOf(a.sourceLean)].add(a.sourceName);
  const left = [...byWing.L].sort();
  const right = [...byWing.R].sort();
  const center = [...byWing.C].sort();
  return { left, right, center, bilateral: left.length > 0 && right.length > 0 };
}

export type PairBreadthState =
  // The featured pair itself spans left and right. Nothing to qualify.
  | { kind: "pair-bilateral" }
  // The pair does not span both wings, but the STORY does. Say so, and point at
  // the coverage list where the other wing actually is.
  | { kind: "pair-not-bilateral"; missingFromPair: Wing[]; elsewhere: string[] }
  // The story genuinely lacks a wing. This is the only case that is a coverage
  // gap, and the only case allowed to be called one.
  | { kind: "story-one-sided"; present: Wing[]; absent: Wing[] };

export function pairBreadthState(
  contrast: { left: SectionArticleDTO; right: SectionArticleDTO },
  articles: SectionArticleDTO[],
): PairBreadthState {
  const breadth = storyBreadth(articles);

  if (!breadth.bilateral) {
    const present: Wing[] = [];
    const absent: Wing[] = [];
    (breadth.left.length ? present : absent).push("L");
    (breadth.right.length ? present : absent).push("R");
    if (breadth.center.length) present.push("C");
    return { kind: "story-one-sided", present, absent };
  }

  if (spansBothWings(contrast)) return { kind: "pair-bilateral" };

  const inPair = new Set<Wing>([wingOf(contrast.left.sourceLean), wingOf(contrast.right.sourceLean)]);
  const missingFromPair = (["L", "R"] as Wing[]).filter((w) => !inPair.has(w));
  const elsewhere = missingFromPair.flatMap((w) => (w === "L" ? breadth.left : breadth.right));
  return { kind: "pair-not-bilateral", missingFromPair, elsewhere };
}

const WING_WORD: Record<Wing, string> = { L: "left-leaning", R: "right-leaning", C: "centrist" };

// The one sentence under the featured pair. Returns null when the pair already
// spans both wings and there is nothing to qualify.
export function breadthNote(state: PairBreadthState): string | null {
  switch (state.kind) {
    case "pair-bilateral":
      return null;
    case "pair-not-bilateral": {
      const missing = state.missingFromPair.map((w) => WING_WORD[w]).join(" and ");
      const names = state.elsewhere.slice(0, 3).join(", ");
      const more = state.elsewhere.length > 3 ? ` and ${state.elsewhere.length - 3} more` : "";
      return (
        `The two tellings above were chosen for the widest temperature gap, and they do not span ` +
        `left and right. ${missing.charAt(0).toUpperCase()}${missing.slice(1)} coverage of this story ` +
        `is in the coverage list below${names ? ` (${names}${more})` : ""}.`
      );
    }
    case "story-one-sided": {
      const absent = state.absent.map((w) => WING_WORD[w]).join(" and ");
      return (
        `Coverage gap: no ${absent} outlet in this edition covered this story, so there is no ` +
        `left-and-right comparison to show.`
      );
    }
  }
}

// Why a story has no pair to feature. Each branch names a different fact, so the
// reader is told what is actually missing rather than "unavailable".
export function noPairReason(articles: SectionArticleDTO[]): string {
  const usable = articles.filter((a) => a.composite !== null && a.excerpt && a.excerpt.paragraphs.length > 0);
  if (usable.length === 0) return "No telling of this story has been scored and excerpted yet.";
  if (usable.length === 1) return "Only one outlet's telling of this story is available in this edition.";
  const sources = new Set(usable.map((a) => a.sourceId));
  if (sources.size === 1) {
    return `Every available telling of this story comes from ${usable[0]!.sourceName}. One outlet against itself is not a comparison.`;
  }
  return "This story has no second telling available to compare.";
}

// How the consensus strip says each band out loud. Keyed by Label, so the band
// table and this wording cannot drift apart without a type error.
const STRIP_WORDING: Record<Label, { strip: string; word: string }> = {
  "Proportionate": { strip: "stays proportionate", word: "proportionate" },
  "Grounded": { strip: "stays grounded", word: "grounded" },
  "Mixed Signals": { strip: "mixed signals", word: "mixed" },
  "Running Hot": { strip: "runs hot", word: "hot" },
  "Hyperbolic": { strip: "runs hyperbolic", word: "hyperbolic" },
};

// Average P/H plus one honest sentence whose band can never contradict the dot.
export function consensusReading(articles: SectionArticleDTO[]): { avg: number; strip: string; reading: string } | null {
  const scored = articles.filter(isScored);
  if (scored.length === 0) return null;
  const avg = scored.reduce((s, a) => s + a.composite, 0) / scored.length;
  // The strip wording is derived from the shared band table rather than from a
  // fourth private cascade, so the sentence can never name a band the dot's
  // colour denies. STRIP_WORDING is keyed by label, so a new band would fail to
  // compile here rather than silently falling through to "hysterical".
  const avgBand = bandForComposite(avg);
  if (!avgBand) return null; // an average that is not on the scale describes nothing
  const band = STRIP_WORDING[avgBand.label];
  const base =
    avg <= 2.4 ? "Across the spectrum, coverage stayed close to the facts and kept the temperature down."
    : avg <= 3.4 ? "Coverage was uneven on this story. Some outlets stayed grounded while others ran hot."
    : "Most outlets ran hot on this story, whatever their lean. Read the facts box before the takes.";
  const avgOf = (xs: Scored[]) => xs.reduce((s, a) => s + a.composite, 0) / xs.length;
  const left = scored.filter((a) => a.politicalLean < -40);
  const right = scored.filter((a) => a.politicalLean > 40);
  const center = scored.filter((a) => Math.abs(a.politicalLean) <= 40);
  if (left.length && right.length && center.length && avgOf(left) - avgOf(center) >= 0.8 && avgOf(right) - avgOf(center) >= 0.8) {
    return { avg, strip: band.strip, reading: `${base} It ran hotter at both poles than in the center.` };
  }
  if (avg <= 2.4) {
    const hottest = scored.reduce((t, a) => (a.composite > t.composite ? a : t));
    if (hottest.composite - avg >= 1.0) {
      return { avg, strip: band.strip, reading: `Coverage stayed mostly ${band.word}. ${hottest.sourceName} ran the hottest.` };
    }
  }
  return { avg, strip: band.strip, reading: base };
}

// One outlet's telling: source + its own P/H score, the highlighted excerpt, the
// plain "why" reading, and a link to the full analysis.
export function Telling({ a, columns = false }: { a: SectionArticleDTO; columns?: boolean }) {
  if (!a.excerpt || a.excerpt.paragraphs.length === 0) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <div className="font-sans text-[11px] uppercase tracking-[0.2em] text-ink3">How {a.sourceName} told it</div>
        {/* The word comes from the NUMBER, not from `a.label`. The stored label
            was written at score time and the number is what the colour beside it
            is derived from; a row where they disagree would otherwise print one
            band's word in another band's colour. */}
        {isValidComposite(a.composite) ? (
          <div
            className="font-sans text-sm font-bold whitespace-nowrap"
            style={{ color: colorForComposite(a.composite) }}
            title="This article's own Proportionate-to-Hyperbolic score."
          >
            {a.composite.toFixed(1)} {bandWord(a.composite)}
          </div>
        ) : (
          <div className="font-sans text-sm text-ink3 whitespace-nowrap">{UNRATED_LABEL}</div>
        )}
      </div>
      {/* Both political readings on the telling itself, each named. The outlet's
          standing baseline and this piece's measured framing are different
          claims and they frequently disagree. */}
      <div className="font-sans text-xs text-ink3 mb-3 flex flex-wrap gap-x-3 gap-y-0.5">
        <OutletBaseline lean={a.sourceLean} />
        <ArticleFraming politicalLean={a.politicalLean} />
      </div>
      <ExcerptBlock className={columns ? "md:columns-2 md:gap-8" : ""} paragraphs={a.excerpt.paragraphs} markers={a.excerpt.markers} />
      {a.rationale?.summary && (
        <p className="font-sans text-sm text-ink3 italic mt-4 pt-3 border-t border-rule">
          {/* "Why Grounded" comes from the composite too. Reading `a.label` here
              was the last place a stale stored label could still put a word on
              screen that the number and the colour above it both denied. */}
          <span className="not-italic text-ink font-semibold">
            Why {isValidComposite(a.composite) ? bandWord(a.composite) : "this"}:
          </span>{" "}
          {a.rationale.summary}
        </p>
      )}
      <div className="flex items-center justify-between gap-4 mt-3 flex-wrap">
        <HighlightLegend />
        {/* This goes to LITMUS's own article page, which shows the score and a
            capped excerpt, never the article itself. "Read the full article"
            promised something that page no longer has; the outlet link lives
            there. */}
        <Link to={`/articles/${a.id}`} className={`font-sans text-sm text-ink3 hover:text-ink underline decoration-1 underline-offset-2 inline-flex items-center min-h-[44px] md:min-h-0 ${FOCUS_RING}`}>
          Full analysis
        </Link>
      </div>
    </div>
  );
}

interface Props {
  data: SectionPageDTO;
  eyebrow?: string;
  // One line under the eyebrow saying what put this story here. The selection
  // is not popularity — LITMUS holds no reach, readership or click data — so
  // the surface states its actual basis rather than letting "lead" imply one.
  eyebrowNote?: string;
}

export function StorySpread({ data, eyebrow = "Today's Lead", eyebrowNote }: Props) {
  const readingAs = "mixed";
  const { trending, articles } = data;
  if (!trending) return null;

  const lead = pickLead(articles, readingAs);
  const contrast = pickContrast(articles);
  const consensus = consensusReading(articles);
  // Distinct publishers, not article rows. See the note by the count below.
  const outletCount = new Set(articles.map((a) => a.sourceName)).size;
  // Political breadth across the COMPLETE article set, computed separately from
  // the pair. The pair is chosen on temperature and knows nothing about lean.
  const breadth = contrast ? pairBreadthState(contrast, articles) : null;
  const breadthText = breadth ? breadthNote(breadth) : null;

  return (
    <>
      <div className="md:grid md:grid-cols-[1fr_1.05fr] md:items-start">
        <div className="md:pr-7 md:border-r md:border-rule">
          <div className="font-sans text-xs uppercase tracking-[0.2em] text-ink2 mb-1.5">{eyebrow}</div>
          <h1 className="font-serif text-[38px] leading-[1.05] font-bold tracking-tight m-0 mb-2">
            <Link to={`/s/${data.section.toLowerCase()}`} className="hover:underline decoration-1 underline-offset-4">
              {trending.topic}
            </Link>
          </h1>
          {eyebrowNote && <p className="font-sans text-xs text-ink3 m-0 mb-4">{eyebrowNote}</p>}
          {!eyebrowNote && <div className="mb-4" />}
          <div className="border-t border-b border-ink py-2.5 mb-4">
            <div className="font-sans text-[11px] uppercase tracking-[0.2em] text-ink3 mb-1">The Facts</div>
            <p className="font-serif text-base m-0">{trending.summary}</p>
            <div className="font-sans text-xs text-ink3 mt-2">
              {/* "Outlets" means DISTINCT SOURCES. Counting articles and calling
                  them outlets overstates breadth whenever one publisher files
                  twice on a story, which is common. Both numbers are shown when
                  they differ, because the difference is itself information. */}
              What happened, across {outletCount} outlet{outletCount === 1 ? "" : "s"}
              {articles.length !== outletCount ? ` (${articles.length} articles)` : ""} covering this story
            </div>
            {/* Claim-level receipts, where this story has them. The summary above
                is a generated synthesis; these are source-linked and status-marked. */}
            <ClaimReceipts
              clusterId={trending.clusterId}
              members={articles.filter((a) => !!a.url).map((a) => ({ id: a.id, url: a.url }))}
            />
          </div>
          {consensus && (
            <div>
              <div className="border border-rule px-3 py-2 flex items-center gap-2.5 flex-wrap">
                <span className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink3">Consensus reading</span>
                <span className="font-sans text-sm font-bold flex items-center gap-1.5">
                  <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: colorForComposite(consensus.avg) }} />
                  {consensus.avg.toFixed(1)} · {consensus.strip}
                </span>
              </div>
              <p className="font-serif text-sm italic border-l-2 border-rule pl-3 mt-3 mb-0 text-ink3">{consensus.reading}</p>
            </div>
          )}
        </div>
        <div className="md:pl-7 mt-8 md:mt-0">
          <div className="font-sans text-xs uppercase tracking-[0.16em] text-center">The Map · This Story</div>
          <div className="font-sans text-xs text-ink3 text-center mb-2">Each outlet's coverage of this story</div>
          <TheMap articles={articles} />
        </div>
      </div>

      {readingAs === "mixed" && contrast ? (
        <div className="mt-7 pt-5 border-t border-ink">
          <div className="font-sans text-xs uppercase tracking-[0.2em] text-ink2 mb-1">Same story, two tellings</div>
          {/* Says what the pair IS chosen on, so the caption cannot be read as a
              promise of political breadth. The axis is P/H temperature and lean
              plays no part in the selection — Max's ruling, 2026-09-02, see
              docs/decisions/002-featured-pair-axis.md. Each telling still
              displays its own outlet baseline and article framing below. */}
          <p className="font-sans text-xs text-ink3 mb-4 m-0">
            Paired by how hot each telling runs, not by politics.
          </p>
          <div className="md:grid md:grid-cols-2 md:gap-10 md:divide-x md:divide-rule">
            <div className="md:pr-10">
              <div className="font-sans text-[11px] uppercase tracking-[0.2em] text-ink3 mb-1">
                {contrastIsReal(contrast) ? "Calmest telling" : "One telling"}
              </div>
              <Telling a={contrast.left} />
            </div>
            <div className="md:pl-10 mt-10 md:mt-0">
              <div className="font-sans text-[11px] uppercase tracking-[0.2em] text-ink3 mb-1">
                {contrastIsReal(contrast) ? "Hottest telling" : "Another telling"}
              </div>
              <Telling a={contrast.right} />
            </div>
          </div>
          {/* Two different facts, said differently.

              A pair that does not span both wings is not a coverage gap when the
              STORY does span them: the temperature axis simply picked two
              tellings from one side, and the other side is downstairs in the
              coverage list. Calling that a gap would be a false statement about
              the edition, in the one place the product promises to be honest
              about coverage. Only a story genuinely missing a wing gets the
              coverage-gap wording. */}
          {breadthText && (
            <p className="font-sans text-xs text-ink3 mt-4 mb-0 border-t border-rule pt-3">
              {breadthText}
              {breadth?.kind === "pair-not-bilateral" && (
                <>
                  {" "}
                  <Link
                    to={`/s/${data.section.toLowerCase()}`}
                    className="underline decoration-1 underline-offset-2 hover:text-ink"
                  >
                    See all coverage of this story
                  </Link>
                  .
                </>
              )}
            </p>
          )}
        </div>
      ) : readingAs === "mixed" && articles.length > 0 ? (
        // Mixed lens, but no pair exists. Say why rather than silently falling
        // through to a single telling that looks like the whole story.
        <div className="mt-7 pt-5 border-t border-ink">
          <div className="font-sans text-xs uppercase tracking-[0.2em] text-ink3 mb-2">Only one telling</div>
          <p className="font-sans text-sm text-ink3 mb-4">
            {noPairReason(articles)}
          </p>
          {lead && lead.excerpt && lead.excerpt.paragraphs.length > 0 && <Telling a={lead} columns />}
        </div>
      ) : lead && lead.excerpt && lead.excerpt.paragraphs.length > 0 ? (
        <div className="mt-7 pt-5 border-t border-ink">
          <Telling a={lead} columns />
        </div>
      ) : null}
    </>
  );
}
