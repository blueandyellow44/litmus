import { describe, expect, it } from "vitest";
import {
  compareStories,
  storyTimeMs,
  withScoredReport,
  inTodaysPaper,
  TODAYS_PAPER_HOURS,
  hasSomethingToShow,
  coverageRanCalm,
  hotDriverEvidence,
  coverageLine,
  editionDay,
  hollowMembers,
  isTelling,
  memberState,
  memberStateText,
  orderStories,
  originNameFor,
  outletShortName,
  pendingMembers,
  phRangeText,
  plottedMembers,
  readStatusCaption,
  editionDayStartMs,
  scheduleStoryReveal,
  scoreText,
  storyPath,
} from "./storyModel.ts";
import { headlineOnly, member, story } from "./storyTestData.ts";

describe("storyPath and outlet names", () => {
  it("routes by slug, encoded", () => {
    expect(storyPath({ slug: "a-b" })).toBe("/story/a-b");
    expect(storyPath({ slug: "odd slug" })).toBe("/story/odd%20slug");
  });
  it("collapses sister feeds to the outlet", () => {
    expect(outletShortName("Axios — Politics & Policy")).toBe("Axios");
    expect(outletShortName("The Verge")).toBe("The Verge");
    expect(outletShortName(" — ")).toBe(" — ");
  });
});

describe("member states", () => {
  it("names every state and none is blank", () => {
    expect(memberState(member())).toBe("scored");
    expect(memberState(member({ composite: null }))).toBe("pending");
    expect(memberState(headlineOnly())).toBe("headline_only");
    expect(memberState(member({ kind: "syndicated", syndicatedOfArticleId: 1 }))).toBe("syndicated");
    expect(memberState(member({ role: "secondary" }))).toBe("secondary");
    for (const s of ["pending", "headline_only", "syndicated", "secondary"] as const) {
      expect(memberStateText(s)).toBeTruthy();
    }
    expect(memberStateText("scored")).toBeNull();
  });
  it("uses the spec wording for a headline-only member and never says blocked", () => {
    expect(memberStateText("headline_only")).toBe("Headline only, not scored");
    expect(memberStateText("headline_only")).not.toMatch(/block/i);
  });
  it("names the origin of a syndicated copy when the story carries it", () => {
    const origin = member({ outletName: "Reuters" });
    const copy = member({ kind: "syndicated", syndicatedOfArticleId: origin.articleId });
    const s = story({ members: [origin, copy] });
    expect(originNameFor(s, copy)).toBe("Reuters");
    expect(memberStateText("syndicated", originNameFor(s, copy))).toBe("Carries Reuters's copy");
    expect(originNameFor(s, member({ kind: "syndicated", syndicatedOfArticleId: 999 }))).toBeNull();
  });
  it("counts tellings, plotted, hollow and pending separately", () => {
    const s = story({
      members: [member(), member({ composite: null }), headlineOnly(), member({ role: "secondary" }), member({ politicalLean: null })],
    });
    // Tellings: the three primary full members. The headline-only member and
    // the roundup are not tellings, whatever their scores.
    expect(s.members.filter(isTelling)).toHaveLength(3);
    // Plotted needs a score AND a lean; the member with no lean is scored but
    // cannot be placed, so it is neither plotted nor pending.
    expect(plottedMembers(s)).toHaveLength(1);
    expect(hollowMembers(s)).toHaveLength(1);
    expect(pendingMembers(s)).toHaveLength(1);
  });
});

describe("score wording", () => {
  it("always pairs the number with the band word", () => {
    expect(scoreText(2.3)).toBe("2.3 Grounded");
    expect(scoreText(4.5)).toBe("4.5 Hyperbolic");
    expect(scoreText(NaN)).toBe("Not rated");
  });
  it("writes a range, a point, or an honest absence", () => {
    expect(phRangeText(1.5, 2.4)).toBe("1.5 Grounded to 2.4 Grounded");
    expect(phRangeText(2, 2)).toBe("2.0 Grounded");
    expect(phRangeText(null, null)).toBe("Not yet scored");
    expect(phRangeText(1, 7)).toBe("Not yet scored");
  });
  it("shows covered and analysed as two counts", () => {
    const s = story({ members: [member(), headlineOnly(), member({ composite: null })] });
    expect(coverageLine(s)).toBe("3 outlets covered this · 1 report analysed");
    expect(coverageLine(story({ members: [member()] }))).toBe("1 outlet covered this · 1 report analysed");
    // Sister feeds collapse to one outlet while every piece is analysed, so the
    // second count can exceed the first; the noun keeps that from reading as a bug.
    const sisters = story({ members: [member({ outletKey: "axios" }), member({ outletKey: "axios" }), member({ outletKey: "cnbc" })] });
    expect(coverageLine(sisters)).toBe("2 outlets covered this · 3 reports analysed");
  });
  it("captions the read status even when nothing is hollow", () => {
    expect(readStatusCaption(story({ members: [member(), member()] }))).toBe("All 2 scored");
    // Headline-only reports are not counted or named (2026-09-26).
    expect(readStatusCaption(story({ members: [member(), headlineOnly({ outletName: "WSJ" })] }))).toBe("All 1 scored");
    expect(readStatusCaption(story({ members: [member(), headlineOnly(), member({ composite: null })] }))).toBe("1 of 2 scored so far");
  });
});

describe("edition order", () => {
  it("leads with stories that have something to show, newest first inside each tier, single-outlet last (2026-10-06)", () => {
    // Tellings' composites decide heat; the story's phMin/phMax decide spread.
    const at = (iso: string, hot = 2.2) => [member({ publishedAt: iso, composite: hot }), member({ outletKey: "o2", publishedAt: "2026-09-12T00:00:00Z", composite: 2 })];
    const single = story({ id: "st_single", members: [member({ publishedAt: "2026-09-13T11:59:00Z" })] });
    const calmNew = story({ id: "st_calm_new", phMin: 2, phMax: 2.2, members: at("2026-09-13T11:00:00Z") });
    const calmOld = story({ id: "st_calm_old", phMin: 2, phMax: 2.2, members: at("2026-09-13T02:00:00Z") });
    const wideOld = story({ id: "st_wide_old", phMin: 1, phMax: 2.2, members: at("2026-09-13T01:00:00Z") });
    const hotOlder = story({ id: "st_hot_older", phMin: 2.8, phMax: 3.4, members: at("2026-09-12T23:59:00Z", 3.4) });
    expect(orderStories([single, hotOlder, calmOld, wideOld, calmNew]).map((s) => s.id))
      .toEqual([wideOld.id, hotOlder.id, calmNew.id, calmOld.id, single.id]);
  });
  it("has something to show at one hot telling or a point of spread, and calls coverage calm under Running Hot", () => {
    const calm = story({ phMin: 2, phMax: 2.4, members: [member({ composite: 2.4 }), member({ outletKey: "o2", composite: 2 })] });
    const wide = story({ phMin: 1.4, phMax: 2.4, members: [member({ composite: 2.4 }), member({ outletKey: "o2", composite: 1.4 })] });
    const hot = story({ phMin: 2.9, phMax: 3, members: [member({ composite: 3 }), member({ outletKey: "o2", composite: 2.9 })] });
    const unscored = story({ phMin: null, phMax: null, members: [member({ composite: null })] });
    expect(hasSomethingToShow(calm)).toBe(false);
    expect(hasSomethingToShow(wide)).toBe(true);
    expect(hasSomethingToShow(hot)).toBe(true);
    expect(hasSomethingToShow(unscored)).toBe(false);
    expect(coverageRanCalm(calm)).toBe(true);
    expect(coverageRanCalm(hot)).toBe(false);
    expect(coverageRanCalm(unscored)).toBe(false);
  });
  it("dates a story by its newest report, ignores a date after the run, and falls back to first seen", () => {
    const base = { firstSeenAt: "2026-09-13T10:00:00.000Z", updatedAt: "2026-09-13T12:00:00.000Z" };
    expect(storyTimeMs({ ...base, members: [member({ publishedAt: "2026-09-13T08:00:00Z" }), member({ publishedAt: "2026-09-13T09:30:00Z" })] })).toBe(Date.parse("2026-09-13T09:30:00Z"));
    expect(storyTimeMs({ ...base, members: [member({ publishedAt: "2026-09-13T08:00:00Z" }), member({ publishedAt: "2031-01-01T00:00:00Z" })] })).toBe(Date.parse("2026-09-13T08:00:00Z"));
    expect(storyTimeMs({ ...base, members: [member({ publishedAt: null })] })).toBe(Date.parse(base.firstSeenAt));
  });
  it("carries only stories with a report inside the paper's window, measured from the build (2026-10-06)", () => {
    const built = "2026-10-02T12:00:00Z";
    // storyTimeMs caps a report's date at the story's updatedAt (the run that read
    // it), so every story here was touched by the build that is being judged.
    const at = (iso: string) => [member({ publishedAt: iso }), member({ outletKey: "o2", publishedAt: "2026-09-20T00:00:00Z" })];
    const dated = (id: string, iso: string) => story({ id, updatedAt: built, members: at(iso) });
    const thisMorning = dated("st_now", "2026-10-02T11:00:00Z");
    const yesterdayEvening = dated("st_eve", "2026-10-01T02:00:00Z");
    const justInside = dated("st_edge", new Date(Date.parse(built) - TODAYS_PAPER_HOURS * 3600 * 1000).toISOString());
    const justOutside = dated("st_out", new Date(Date.parse(built) - TODAYS_PAPER_HOURS * 3600 * 1000 - 1000).toISOString());
    const lastWeek = dated("st_old", "2026-09-25T12:00:00Z");
    expect(TODAYS_PAPER_HOURS).toBe(36);
    expect(inTodaysPaper([lastWeek, justOutside, thisMorning, justInside, yesterdayEvening], built).map((s) => s.id))
      .toEqual(["st_now", "st_edge", "st_eve"]);
  });
  it("shows the whole edition when the build time is unreadable, and never mutates its input", () => {
    const old = story({ id: "st_old", updatedAt: "2026-09-01T06:00:00Z", members: [member({ publishedAt: "2026-09-01T00:00:00Z" })] });
    const input = [old];
    expect(inTodaysPaper(input, "not a date")).toEqual([old]);
    expect(inTodaysPaper(input, "not a date")).not.toBe(input);
    expect(inTodaysPaper(input, "2026-10-02T12:00:00Z")).toEqual([]);
    expect(input).toEqual([old]);
  });
  it("keeps a story off the page until two outlets are scored", () => {
    const scored = story({ id: "st_two", members: [member(), member({ outletKey: "o2" })] });
    const pending = story({ id: "st_none", members: [member({ composite: null }), member({ outletKey: "o2", composite: null })] });
    const oneGraded = story({ id: "st_one", members: [member(), member({ outletKey: "o2", composite: null })] });
    const sameOutletTwice = story({ id: "st_dup", members: [member({ outletKey: "o1" }), member({ outletKey: "o1" })] });
    const headlineScoredOnly = story({ id: "st_head", members: [headlineOnly(), member({ composite: null })] });
    expect(withScoredReport([scored, pending, oneGraded, sameOutletTwice, headlineScoredOnly]).map((s) => s.id)).toEqual(["st_two"]);
  });
  it("is total and never mutates its input", () => {
    const a = story({ id: "st_a", phMin: 2, phMax: 2 });
    const b = story({ id: "st_b", phMin: 2, phMax: 2 });
    expect(compareStories(a, b)).toBeLessThan(0);
    expect(compareStories(b, a)).toBeGreaterThan(0);
    expect(compareStories(a, a)).toBe(0);
    const input = [b, a];
    orderStories(input);
    expect(input[0]).toBe(b);
  });
  it("reads the edition day in UTC and tolerates a bad timestamp", () => {
    expect(editionDay("2026-09-13T23:59:59Z")).toBe("2026-09-13");
    expect(editionDay("garbage")).toBe("");
  });
});

describe("scheduleStoryReveal", () => {
  // Before 5:00 AM Pacific, when the edition is due, so the drip runs from the build.
  const BUILT = "2026-09-19T10:15:00.000Z";
  const hoursAfter = (n: number) => new Date(Date.parse(BUILT) + n * 60 * 60 * 1000);

  it("shows a base of 6 qualified stories at build time, not the rest", () => {
    const stories = Array.from({ length: 8 }, () => story());
    const visible = scheduleStoryReveal(stories, BUILT, new Date(BUILT));
    expect(visible).toHaveLength(6);
  });

  it("spreads the rest evenly across the reveal window", () => {
    // 6 base + 2 dripped over 16h: one at 8h, the last at 16h.
    const stories = Array.from({ length: 8 }, () => story());
    expect(scheduleStoryReveal(stories, BUILT, hoursAfter(7.9))).toHaveLength(6);
    expect(scheduleStoryReveal(stories, BUILT, hoursAfter(8))).toHaveLength(7);
    expect(scheduleStoryReveal(stories, BUILT, hoursAfter(15.9))).toHaveLength(7);
    expect(scheduleStoryReveal(stories, BUILT, hoursAfter(16))).toHaveLength(8);
    expect(scheduleStoryReveal(stories, BUILT, hoursAfter(99))).toHaveLength(8);
  });

  it("finishes a busy day inside the window, not a day and a half later", () => {
    const stories = Array.from({ length: 46 }, () => story());
    expect(scheduleStoryReveal(stories, BUILT, hoursAfter(8))).toHaveLength(26);
    expect(scheduleStoryReveal(stories, BUILT, hoursAfter(16))).toHaveLength(46);
  });

  it("shows everything at once when there is nothing past the base to drip", () => {
    const stories = Array.from({ length: 4 }, () => story());
    expect(scheduleStoryReveal(stories, BUILT, new Date(BUILT))).toHaveLength(4);
  });

  it("never withholds a single-outlet story - it is not part of the drip", () => {
    const qualified = Array.from({ length: 8 }, () => story());
    const thin = story({ id: "st_thin", singleOutlet: true, outletCount: 1, members: [member()] });
    const visible = scheduleStoryReveal([...qualified, thin], BUILT, new Date(BUILT));
    expect(visible.map((s) => s.id)).toContain(thin.id);
    // 6 qualified (base) + the always-visible thin story.
    expect(visible).toHaveLength(7);
  });

  it("shows everything rather than withhold content on an unreadable build time", () => {
    const stories = Array.from({ length: 8 }, () => story());
    expect(scheduleStoryReveal(stories, "not a date", new Date(BUILT))).toHaveLength(8);
  });

  it("releases the widest stories first and shows them newest first", () => {
    const at = (h: number) => [member({ publishedAt: `2026-09-19T0${h}:00:00Z` }), member({ outletKey: "o2", composite: 3.6, publishedAt: "2026-09-18T00:00:00Z" })];
    const wide = Array.from({ length: 6 }, (_, i) => story({ phMin: 1, phMax: 4.5, updatedAt: BUILT, members: at(i + 1) }));
    const narrowNewest = story({ phMin: 2, phMax: 2.1, updatedAt: BUILT, members: at(9) });
    const visible = scheduleStoryReveal([narrowNewest, ...wide], BUILT, new Date(BUILT));
    expect(visible.map((s) => s.id)).toEqual([...wide].reverse().map((s) => s.id));
    // Once released, the newest story takes the top of the page.
    expect(scheduleStoryReveal([narrowNewest, ...wide], BUILT, hoursAfter(16))[0]!.id).toBe(narrowNewest.id);
  });
});

describe("the drip starts at the day's 5:00 AM Pacific, not a later rebuild (2026-09-27, 5:00 since 2026-10-05)", () => {
  it("finds 5:00 AM Pacific on the build's Pacific day, daylight time included", () => {
    expect(new Date(editionDayStartMs(Date.parse("2026-09-27T19:15:40Z"))).toISOString()).toBe("2026-09-27T12:00:00.000Z");
    expect(new Date(editionDayStartMs(Date.parse("2026-12-05T20:00:00Z"))).toISOString()).toBe("2026-12-05T13:00:00.000Z");
  });
  it("shows a noon rebuild what the day's drip has already released", () => {
    const stories = Array.from({ length: 22 }, (_, i) => story({ outletCount: 3 + (i % 3) }));
    const noonBuild = "2026-09-27T19:15:00Z";
    const atNoon = scheduleStoryReveal(stories, noonBuild, new Date(noonBuild)).filter((s) => !s.singleOutlet);
    expect(atNoon.length).toBeGreaterThan(6);
  });
});

describe("hotDriverEvidence: what set a hot telling's number (2026-10-06)", () => {
  const heat = (over: Partial<NonNullable<ReturnType<typeof member>["heat"]>> = {}) => ({
    driver: "language" as const,
    dimensions: { headline: 2, language: 3, sourcing: 2, fallacies: 1, structure: 2 },
    loadedHeadline: false, emotionalLede: false, oneSidedSourcing: false, fallacyCount: 0,
    floors: [], note: null, lede: null,
    ...over,
  });
  it("is null without a stored breakdown or without a score", () => {
    expect(hotDriverEvidence(member({ composite: 3.5, heat: null }))).toBeNull();
    expect(hotDriverEvidence(member({ composite: null, heat: heat() }))).toBeNull();
  });
  it("quotes the headline when it was rated loaded or set the number, with the driver's note", () => {
    const m = member({ composite: 3.5, title: "Rout at City Hall", heat: heat({ driver: "headline", loadedHeadline: true, dimensions: { headline: 4, language: 2, sourcing: 2, fallacies: 1, structure: 3 }, note: "Calls the vote a rout." }) });
    const e = hotDriverEvidence(m)!;
    expect(e.label).toBe("Hot headline");
    expect(e.quote).toBe("Rout at City Hall");
    expect(e.statement).toContain("Headline 4 of 5");
    expect(e.why).toBe("Calls the vote a rout.");
    const byDriverOnly = hotDriverEvidence(member({ composite: 3.2, title: "T", heat: heat({ driver: "headline", note: "n" }) }))!;
    expect(byDriverOnly.label).toBe("Hot headline");
    expect(byDriverOnly.statement).toContain("set the number");
  });
  it("quotes the lede for an emotional lede only when the excerpt opens with it", () => {
    const withLede = hotDriverEvidence(member({ composite: 3.5, heat: heat({ emotionalLede: true, lede: "Panic swept the chamber." }) }))!;
    expect(withLede.label).toBe("Emotion before facts");
    expect(withLede.quote).toBe("Panic swept the chamber.");
    const noLede = hotDriverEvidence(member({ composite: 3.5, heat: heat({ emotionalLede: true, lede: null }) }))!;
    expect(noLede.quote).toBeNull();
    expect(noLede.statement).toContain("opens on a feeling");
  });
  it("states an absence for sourcing, names a fallacy mark for reasoning, and says when language has no one phrase", () => {
    const sourcing = hotDriverEvidence(member({ composite: 3.4, heat: heat({ driver: "sourcing", oneSidedSourcing: true, note: "Only the mayor speaks." }) }))!;
    expect(sourcing.label).toBe("One side absent");
    expect(sourcing.quote).toBeNull();
    expect(sourcing.why).toBe("Only the mayor speaks.");
    const fallacy = hotDriverEvidence(member({ composite: 3.4, heat: heat({ driver: "fallacies", fallacyCount: 2 }), excerpt: { paragraphs: ["x"], markers: [{ text: "everyone knows", category: "logical_fallacy", intensity: 3 }, { text: "mild", category: "logical_fallacy", intensity: 2 }] } }))!;
    expect(fallacy.label).toBe("Reasoning");
    expect(fallacy.quote).toBe("everyone knows");
    expect(fallacy.statement).toContain("2 fallacies");
    const language = hotDriverEvidence(member({ composite: 3.5, heat: heat({ note: "Verbs do emotional work." }) }))!;
    expect(language.label).toBe("Hot language");
    expect(language.quote).toBeNull();
    expect(language.why).toBe("Verbs do emotional work.");
  });
  it("prefers the headline over the lede when both flags are set, matching the 3.5 floor", () => {
    const e = hotDriverEvidence(member({ composite: 3.5, title: "H", heat: heat({ loadedHeadline: true, emotionalLede: true, floors: ["loaded headline together with an emotional lede"], lede: "L." }) }))!;
    expect(e.label).toBe("Hot headline");
  });
});
