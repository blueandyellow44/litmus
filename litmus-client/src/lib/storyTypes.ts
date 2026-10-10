// The story contract: what the API serves and the snapshot freezes for the
// story-first paper (Max, 2026-09-13). MUST STAY IDENTICAL to
// litmus-server/src/api/storyTypes.ts; the build plan
// (docs/plans/story-first-build-2026-09-13.md) owns any change to it.
//
// Legal posture carried from the excerpt policy: no member ever carries full
// article text. Excerpts are the capped, highlight-trimmed window already built
// by buildExcerptWindow; headline-only members carry a headline and a link.

import type { Lean } from "./types.ts";

export type StoryMemberKind =
  // Body read and scored.
  | "full"
  // Covered the story, but LITMUS could not read enough to assess it
  // (paywall, bot block, thin page). Shown as a hollow dot and a headline link.
  | "headline_only"
  // A copy of another outlet's article (wire syndication). Shown, never counted
  // as an independent telling.
  | "syndicated";

export interface StoryExcerptDTO {
  paragraphs: string[];
  // why: the scorer's one-line reason, absent on marks stored before 2026-10-02.
  markers: Array<{ text: string; category: string; intensity: number; why?: string }>;
}

// What set a telling's number, from the score's own record (mirrors the
// server's StoryHeatDTO, 2026-10-06). Jev's five effective dimensions, its
// yes/no flags, the floors that bound, Haiku's note on the driving dimension,
// and the piece's first sentence when the published excerpt opens with it.
export type HeatDimension = "headline" | "language" | "sourcing" | "fallacies" | "structure";

export interface StoryHeatDTO {
  driver: HeatDimension;
  dimensions: Record<HeatDimension, number>;
  loadedHeadline: boolean;
  emotionalLede: boolean;
  oneSidedSourcing: boolean;
  fallacyCount: number;
  floors: string[];
  note: string | null;
  lede: string | null;
}

export interface StoryMemberDTO {
  articleId: number;
  outletKey: string; // one identity per outlet across sister feeds
  outletName: string;
  sourceLean: Lean;
  title: string;
  url: string;
  publishedAt: string | null;
  kind: StoryMemberKind;
  syndicatedOfArticleId: number | null;
  // Secondary members (roundups, and an outlet's extra filings) appear under the
  // story but never count as a telling.
  role: "primary" | "secondary";
  // True for an outlet's second or later filing, demoted to secondary so each
  // outlet is one telling (dedupePrimaries.ts). Shown as "Also filed".
  alsoFiled?: boolean;
  composite: number | null; // P/H 1.0-5.0, null when not scored
  politicalLean: number | null; // -100..+100, this piece's framing, null when not scored
  howItWasTold: string | null; // AI one-liner on the telling, null when not scored
  heat: StoryHeatDTO | null; // what set the number; null when not scored or stored before the breakdown
  excerpt: StoryExcerptDTO | null; // null for headline_only
}

// Layer 3, public in v1 only as descriptive framing notes built from counts.
// "Distortion" findings exist only in shadow until the defensibility gate in
// docs/specs/story-analysis-engine-2026-09-13.md is live; they are never in
// this DTO until then.
export interface FramingNoteDTO {
  technique: "lead_emphasis" | "whose_voice";
  label: "Legitimate framing";
  text: string; // e.g. "Leads with cost: 3 of 5 outlets"
  counts: Array<{ outletName: string; value: string }>;
}

export interface StoryAssessmentDTO {
  // Two to three plain paragraphs: who is doing what, why, and what
  // happens next. Length follows the story's real complexity — a thin
  // single-development story stays at two paragraphs rather than padding to
  // three (Max, reviewing the vision doc, 2026-09-17; supersedes the
  // original "two to four sentences" in the 2026-09-13 build plan).
  text: string;
  model: string;
  generatedAt: string;
}

export interface StoryCoverageDTO {
  // Roster outlets known to have covered the event whose piece is not a member,
  // with the reason. Empty when every known covering outlet is present.
  excluded: Array<{ outletName: string; reason: string }>;
  sweepComplete: boolean; // false means the omission check did not finish; shown on the story
}

export interface StoryDTO {
  id: string; // stable across runs, e.g. "st_01J..."; never a regenerated serial
  slug: string;
  section: string | null;
  headline: string; // neutral, AI-written event headline
  eventStatement: string; // one sentence naming actors, act, occasion
  assessment: StoryAssessmentDTO | null;
  // Political Wire scope (2026-09-26): judged with the assessment; null until
  // judged. The front page shows only true.
  touchesPolitics: boolean | null;
  firstSeenAt: string;
  updatedAt: string;
  outletCount: number; // distinct outletKey among primary members
  memberCount: number;
  phMin: number | null;
  phMax: number | null;
  singleOutlet: boolean;
  members: StoryMemberDTO[];
  notes: FramingNoteDTO[];
  coverage: StoryCoverageDTO;
}

export interface StoryListDTO {
  stories: StoryDTO[]; // edition order: multi-outlet first, stories with heat or spread before calm ones, newest report first inside each; single-outlet after
}
