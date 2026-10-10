// Page furniture filter (Max, 2026-09-27: "a lot of captions and subcaptions are
// included as text. feel like that is something jev can help with").
//
// Jev sorts every stored paragraph into story text or furniture, one choice
// question per paragraph, 15 paragraphs a call, neighbours given as context. A
// paragraph is set aside only when the furniture classes together reach
// DROP_AT: losing a real story paragraph is the worse error. One code rule
// covers what Jev reads as a subheading: an all-capitals line of 25+ characters
// is a link to a different story ("TRUMP SAYS US WILL LET UKRAINE ...").
//
// Measured before building, on 53 real articles (1,255 paragraphs, labels
// adjudicated): on the 29 held-out articles this caught 113 of 120 furniture
// paragraphs and set aside no real story paragraph; a pattern-only filter
// caught 71 and cut 3 story paragraphs.
import { askJev, type JevQuestion } from "../lib/jev.js";
import { splitParagraphs } from "../lib/paragraphs.js";

export const FURNITURE_CLASSES: Record<string, string> = {
  story: "Story text: reporting, quotes, analysis, an interview question or answer, a list item the writer wrote",
  subheading: "A subheading inside the story, or the story's subtitle (dek): short, written by the outlet, introduces the next section",
  speaker: "A transcript speaker label such as 'Geoff Bennett:'",
  caption: "A photo or chart caption, or a photo credit (a photographer's or agency's name, 'Getty Images', 'AP Photo', 'hide caption')",
  promo: "Promotion or navigation: newsletter or subscription pitch, app download, 'Read more', 'Recommended', a link or headline pointing to a different story, social-media follow line, donation appeal",
  meta: "Metadata: byline, author name, date or time stamp, section label, topic tags, content warning, transcript notice, embedded-post attribution",
  junk: "Leftover markup or noise: '[chart]', '...', an icon label, a paragraph that repeats an earlier one word for word",
};
const SET_ASIDE = new Set(["caption", "promo", "meta", "junk"]);
export const DROP_AT = 0.7;
const CHUNK = 15;
const CLIP = 600;

export interface SetAside { index: number; class: string; confidence: number; text: string }
export interface FurnitureResult { cleanText: string; furniture: SetAside[] }

export function isAllCapsLink(text: string): boolean {
  const t = text.trim();
  return t.length >= 25 && !/[a-z]/.test(t) && /[A-Z]/.test(t);
}

// Extraction sometimes glues a caption and a story sentence into one paragraph
// with a single line break ("...AFP via Getty Images\nPope Leo also addressed
// the rich history..."). Setting that aside would lose the sentence, so a
// multi-line paragraph with any story-length line (25+ words) is always kept.
const STORY_LINE_WORDS = 25;
export function holdsStoryLine(paragraph: string): boolean {
  const lines = paragraph.split("\n");
  return lines.length > 1 && lines.some((l) => l.trim().split(/\s+/).filter(Boolean).length >= STORY_LINE_WORDS);
}

const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s);

export async function filterFurniture(title: string, rawText: string): Promise<FurnitureResult> {
  const ps = splitParagraphs(rawText);
  const furniture: SetAside[] = [];
  for (let c = 0; c < ps.length; c += CHUNK) {
    const idx = ps.slice(c, c + CHUNK).map((_, k) => c + k);
    const questions: Record<string, JevQuestion> = Object.fromEntries(idx.map((i) => [`p${i}`, {
      type: "choice" as const,
      instructions: `What is paragraph ${i + 1} of ${ps.length} in this page? Paragraph: "${clip(ps[i]!)}"`,
      criteria: FURNITURE_CLASSES,
    }]));
    const state = { headline: title, paragraphs: ps.slice(Math.max(0, c - 2), c + CHUNK + 2).map((p, k) => `[${Math.max(0, c - 2) + k + 1}] ${clip(p)}`) };
    const { answers } = await askJev(state, questions);
    for (const i of idx) {
      const a = answers[`p${i}`];
      const mass = Object.entries(a?.probabilities ?? {}).filter(([k]) => SET_ASIDE.has(k)).reduce((t, [, v]) => t + v, 0);
      if (mass >= DROP_AT && !holdsStoryLine(ps[i]!)) furniture.push({ index: i, class: a?.choice ?? "unknown", confidence: +mass.toFixed(3), text: ps[i]! });
      else if (isAllCapsLink(ps[i]!)) furniture.push({ index: i, class: "promo", confidence: 1, text: ps[i]! });
    }
  }
  const aside = new Set(furniture.map((f) => f.index));
  const kept = ps.filter((_, i) => !aside.has(i));
  // Never leave an article with nothing: if every paragraph looked like furniture,
  // the page is not an article and the content-type gate will say so on the raw text.
  if (kept.length === 0) return { cleanText: rawText, furniture: [] };
  return { cleanText: kept.join("\n\n"), furniture };
}
