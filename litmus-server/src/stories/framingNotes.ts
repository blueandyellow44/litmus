// S5: descriptive framing notes (docs/plans/story-first-build-2026-09-13.md).
// No model call — every note here is a deterministic count over data the
// scorer already computed and stored (the excerpt and its markers). Nothing
// here judges an outlet; both techniques publish under the single "Legitimate
// framing" label the DTO's type already restricts them to. "Distortion"
// findings live in a separate, shadow-only layer this module never touches.
//
// A pure function on purpose: S6 calls this at snapshot-build time from
// whatever the API/snapshot layer already has in memory, not from a stored
// row — there is no framing_notes table, and there should not be one, since
// the input (excerpts, markers) is itself already stored and this is cheap
// to recompute.

import type { MarkerCategory } from "../scoring/calibration.js";
import type { FramingNoteDTO } from "../api/storyTypes.js";

export interface FramingNoteMemberInput {
  outletName: string;
  role: "primary" | "secondary";
  // null for a headline-only or unscored member — excluded from both
  // techniques below, the same way the matrix shows it as a hollow dot rather
  // than a plotted score: nothing to read means nothing to measure.
  leadParagraph: string | null;
  leadMarkerCategories: readonly MarkerCategory[];
}

const NEUTRAL_CATEGORIES: ReadonlySet<MarkerCategory> = new Set(["grounded", "hedging"]);

// A member with no charged category in its lead reads as "grounded" for this
// note; a member carrying at least one is "charged" — the specific category
// is not surfaced here (that granularity belongs to Layer 3, not this count).
function leadIsCharged(categories: readonly MarkerCategory[]): boolean {
  return categories.some((c) => !NEUTRAL_CATEGORIES.has(c));
}

// A quoted or attributed lead names its source in the sentence doing the
// telling — a leading quotation mark, or an attribution verb inside the first
// dozen or so words. Anything else is the outlet's own declarative framing.
const QUOTE_OPEN = /^[“"']/;
const ATTRIBUTION_VERB = /\b(said|says|told|wrote|writes|according to|reported|reports)\b/i;

function opensWithAttribution(leadParagraph: string): boolean {
  if (QUOTE_OPEN.test(leadParagraph.trim())) return true;
  const firstWords = leadParagraph.trim().split(/\s+/).slice(0, 12).join(" ");
  return ATTRIBUTION_VERB.test(firstWords);
}

function primaryWithLead(members: readonly FramingNoteMemberInput[]): FramingNoteMemberInput[] {
  return members.filter((m) => m.role === "primary" && m.leadParagraph !== null);
}

function leadEmphasisNote(members: readonly FramingNoteMemberInput[]): FramingNoteDTO | null {
  const usable = primaryWithLead(members);
  if (usable.length < 2) return null;
  const charged = usable.filter((m) => leadIsCharged(m.leadMarkerCategories));
  return {
    technique: "lead_emphasis",
    label: "Legitimate framing",
    text: `Opens with loaded or speculative wording: ${charged.length} of ${usable.length} outlets.`,
    counts: usable.map((m) => ({
      outletName: m.outletName,
      value: leadIsCharged(m.leadMarkerCategories) ? "Loaded lead" : "Grounded lead",
    })),
  };
}

function whoseVoiceNote(members: readonly FramingNoteMemberInput[]): FramingNoteDTO | null {
  const usable = primaryWithLead(members);
  if (usable.length < 2) return null;
  const quoted = usable.filter((m) => opensWithAttribution(m.leadParagraph!));
  return {
    technique: "whose_voice",
    label: "Legitimate framing",
    text: `Opens with a direct quote or attribution: ${quoted.length} of ${usable.length} outlets.`,
    counts: usable.map((m) => ({
      outletName: m.outletName,
      value: opensWithAttribution(m.leadParagraph!) ? "Quoted lead" : "Outlet's own framing",
    })),
  };
}

// Both techniques, in the order the client renders them. Either or both can
// come back absent — fewer than two readable primary members is a real state
// (a thin or single-outlet story), not an error, and the client's own empty
// states already say so.
export function buildFramingNotes(members: readonly FramingNoteMemberInput[]): FramingNoteDTO[] {
  return [leadEmphasisNote(members), whoseVoiceNote(members)].filter((n): n is FramingNoteDTO => n !== null);
}
