// The weekly letter's contents (Max, 2026-10-11: Buttondown, weekly): which
// stories go in an issue and how the issue reads. Pure, so the choice is tested
// here and scripts/weekly-letter.ts only reads a snapshot and writes a draft.
//
// An issue is built from the published snapshot and nothing else, so it can
// only say what the paper already says. Each story carries the same calmest
// and hottest telling its card shows (calmAndHot), as outlet, score, and the
// outlet's own headline linked to the source. No excerpt goes in the email:
// the quoted windows are sized for the page they sit on (the excerpt policy).
//
// The stories are the weekly edition's own (inThisWeeksPaper), most covered
// first. That orders stories, never outlets: nothing here ranks one outlet
// against another.

import { decodeEntities } from "./entities.ts";
import { bandWord } from "./phBand.ts";
import { calmAndHot, inPoliticalScope, inThisWeeksPaper, outletShortName, scoredOutletCount, withScoredReport } from "./storyModel.ts";
import type { StoryDTO, StoryMemberDTO } from "./storyTypes.ts";

export const LETTER_STORY_COUNT = 5;

// The front page under a countable path, like /substack: every link back to
// the paper in an issue lands here, so Web Analytics can count letter readers.
export const LETTER_LANDING_PATH = "/letter";
export const LETTER_SITE_URL = `https://litmustimes.com${LETTER_LANDING_PATH}`;

export const LETTER_DISCLOSURE =
  "Automated reading of the writer's framing. Not a verdict on any person or outlet.";

export interface LetterStory {
  story: StoryDTO;
  calm: StoryMemberDTO;
  hot: StoryMemberDTO;
  scoredOutlets: number;
}

// The first of the edition's own stories, most covered first, that have two
// different outlets to set side by side. Drawn from inThisWeeksPaper, so the
// letter never features a story the paper does not carry.
export function pickLetterStories(
  stories: readonly StoryDTO[],
  buildCompletedAt: string,
  count: number = LETTER_STORY_COUNT,
): LetterStory[] {
  if (!Number.isFinite(Date.parse(buildCompletedAt))) {
    throw new Error(`letter: the snapshot's build time is not a date: ${buildCompletedAt}`);
  }
  const picked: LetterStory[] = [];
  for (const story of inThisWeeksPaper(withScoredReport(inPoliticalScope(stories)), buildCompletedAt)) {
    const { calm, hot } = calmAndHot(story);
    if (!calm || !hot) continue;
    if (calm.member.outletKey === hot.member.outletKey) continue;
    picked.push({ story, calm: calm.member, hot: hot.member, scoredOutlets: scoredOutletCount(story) });
    if (picked.length === count) break;
  }
  return picked;
}

// Markdown link text cannot carry a closing bracket.
const linkText = (text: string) => decodeEntities(text).replace(/[[\]]/g, "").trim();

function tellingLines(label: string, m: StoryMemberDTO): string[] {
  return [
    `**${label}** ${outletShortName(m.outletName)}, ${(m.composite as number).toFixed(1)} ${bandWord(m.composite)}`,
    `[${linkText(m.title)}](${m.url})`,
  ];
}

const LONG_DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "America/Los_Angeles" });

export function letterSubject(buildCompletedAt: string): string {
  return `The LITMUS weekly letter, ${LONG_DATE.format(new Date(buildCompletedAt))}`;
}

// The issue as Markdown, which is what Buttondown takes. A draft for Max to
// read and edit before he sends it, never the final word.
export function renderLetter(picked: readonly LetterStory[]): string {
  if (picked.length === 0) throw new Error("letter: no story this week has two scored outlets to compare");
  const n = picked.length;
  const out: string[] = [
    `${n === 1 ? "One story" : `${n} stories`} from this week that many outlets covered, each with the calmest and the hottest telling LITMUS read.`,
    "",
  ];
  for (const { story, calm, hot, scoredOutlets } of picked) {
    out.push(
      `## ${decodeEntities(story.headline)}`,
      "",
      decodeEntities(story.eventStatement),
      "",
      ...tellingLines("Calmest telling", calm),
      "",
      ...tellingLines("Hottest telling", hot),
      "",
      `${scoredOutlets} outlets scored on this story.`,
      "",
    );
  }
  out.push(
    "---",
    "",
    `[Read every telling on LITMUS](${LETTER_SITE_URL})`,
    "",
    "Scores run from 1 Proportionate to 5 Hyperbolic.",
    "",
    LETTER_DISCLOSURE,
    "",
  );
  return out.join("\n");
}
