// One primary telling per outlet.
//
// The ledger can attach several filings from one outlet to a story as primary
// members: a live edition carried the same outlet twice as primary in 74
// stories, and The Hill eleven times on the Hormuz card (audit 2026-10-02,
// section 3.5). Each extra filing was plotted, counted and compared as if it
// were another outlet's telling, so "13 outlets" sat over 26 report rows.
//
// The story keeps ONE primary per outlet and lists the rest as secondary rows
// marked alsoFiled, so the outlet count, the read count, the range and the
// chart all come from the same set. Which filing stays primary: a scored one
// over an unscored one, a full text over a wire copy, then the earliest
// attached. That choice never looks at the score's value, so it cannot make an
// outlet look hotter or calmer than its first scored filing.
//
// Headline-only members are left as they are: the site shows none of them.

import type { StoryMemberDTO } from "./storyTypes.js";

function rank(m: StoryMemberDTO): number {
  return (m.composite !== null ? 0 : 2) + (m.kind === "full" ? 0 : 1);
}

export function dedupePrimaries(members: readonly StoryMemberDTO[]): StoryMemberDTO[] {
  const keep = new Map<string, StoryMemberDTO>();
  for (const m of members) {
    if (m.role !== "primary" || m.kind === "headline_only") continue;
    const held = keep.get(m.outletKey);
    if (!held || rank(m) < rank(held)) keep.set(m.outletKey, m);
  }
  return members.map((m) => {
    if (m.role !== "primary" || m.kind === "headline_only" || keep.get(m.outletKey) === m) return m;
    return { ...m, role: "secondary", alsoFiled: true };
  });
}
