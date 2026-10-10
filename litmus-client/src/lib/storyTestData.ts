// Story shapes for tests: a member factory and a story factory built on the
// contract, so every story test starts from a valid StoryDTO and overrides one
// thing. Not imported by any page.

import type { StoryDTO, StoryMemberDTO } from "./storyTypes.ts";

let seq = 0;

export function member(over: Partial<StoryMemberDTO> = {}): StoryMemberDTO {
  const id = ++seq;
  return {
    articleId: id,
    outletKey: `outlet-${id}`,
    outletName: `Outlet ${id}`,
    sourceLean: "center",
    title: `Headline ${id}`,
    url: `https://example.test/${id}`,
    publishedAt: "2026-09-13T12:00:00.000Z",
    kind: "full",
    syndicatedOfArticleId: null,
    role: "primary",
    composite: 2,
    politicalLean: 0,
    howItWasTold: "Plain report.",
    heat: null,
    excerpt: { paragraphs: ["A plain sentence with a loaded word in it."], markers: [{ text: "loaded word", category: "loaded_terms", intensity: 3 }] },
    ...over,
  };
}

export function headlineOnly(over: Partial<StoryMemberDTO> = {}): StoryMemberDTO {
  return member({ kind: "headline_only", composite: null, politicalLean: null, howItWasTold: null, heat: null, excerpt: null, ...over });
}

export function story(over: Partial<StoryDTO> = {}): StoryDTO {
  const members = over.members ?? [member(), member({ composite: 3.6, politicalLean: 40 })];
  const scored = members.map((m) => m.composite).filter((c): c is number => typeof c === "number");
  const outlets = new Set(members.filter((m) => m.role === "primary").map((m) => m.outletKey)).size;
  const id = ++seq;
  return {
    id: `st_test_${id}`,
    slug: `story-${id}`,
    section: "Politics",
    headline: `Story ${id}`,
    eventStatement: `Someone did something on day ${id}.`,
    assessment: { text: "Two sentences. Plain ones.", model: "test", generatedAt: "2026-09-13T12:00:00.000Z" },
    touchesPolitics: true,
    firstSeenAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T12:00:00.000Z",
    outletCount: outlets,
    memberCount: members.length,
    phMin: scored.length ? Math.min(...scored) : null,
    phMax: scored.length ? Math.max(...scored) : null,
    singleOutlet: outlets === 1,
    members,
    notes: [],
    coverage: { excluded: [], sweepComplete: true },
    ...over,
  };
}
