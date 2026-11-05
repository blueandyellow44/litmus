// The weekly letter: which stories an issue takes, and that it only says what
// the paper says, in the shape the standing rules allow.

import { describe, expect, it } from "vitest";
import { LETTER_DISCLOSURE, LETTER_SITE_URL, letterSubject, pickLetterStories, renderLetter } from "./letter.ts";
import { member, story } from "./storyTestData.ts";

const BUILT = "2026-09-13T13:00:00.000Z";

describe("pickLetterStories", () => {
  it("takes a story with two scored outlets and names its calmest and hottest", () => {
    const calm = member({ composite: 1.6, outletName: "Calm Wire" });
    const hot = member({ composite: 4.1, outletName: "Hot Post" });
    const [picked] = pickLetterStories([story({ members: [hot, member({ composite: 2.5 }), calm] })], BUILT);
    expect(picked?.calm.outletName).toBe("Calm Wire");
    expect(picked?.hot.outletName).toBe("Hot Post");
    expect(picked?.scoredOutlets).toBe(3);
  });

  it("leaves out a story with one scored outlet, an unjudged scope, or no report this week", () => {
    const single = story({ members: [member()] });
    const outOfScope = story({ touchesPolitics: false });
    const old = story({
      firstSeenAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
      members: [member({ publishedAt: "2026-09-01T12:00:00.000Z" }), member({ composite: 3.6, publishedAt: "2026-09-01T12:00:00.000Z" })],
    });
    expect(pickLetterStories([single, outOfScope, old], BUILT)).toEqual([]);
  });

  it("orders by how many outlets were scored and stops at the count", () => {
    const wide = story({ members: [member({ composite: 1.5 }), member({ composite: 2.5 }), member({ composite: 3.5 })] });
    const narrow = story();
    const picked = pickLetterStories([narrow, wide, story(), story()], BUILT, 2);
    expect(picked).toHaveLength(2);
    expect(picked[0]?.story.id).toBe(wide.id);
  });

  it("refuses a snapshot with no build time", () => {
    expect(() => pickLetterStories([story()], "")).toThrow(/build time/);
  });
});

describe("renderLetter", () => {
  const calm = member({ composite: 1.6, outletName: "Calm Wire — World", title: "A plain &amp; quiet headline", url: "https://example.test/calm" });
  const hot = member({ composite: 4.1, outletName: "Hot Post", title: "Chaos [live]", url: "https://example.test/hot" });
  const body = renderLetter(pickLetterStories([story({ headline: "The vote", members: [calm, hot] })], BUILT));

  it("gives the calmest and the hottest telling the same three things", () => {
    expect(body).toContain("**Calmest telling** Calm Wire, 1.6 Grounded\n[A plain & quiet headline](https://example.test/calm)");
    expect(body).toContain("**Hottest telling** Hot Post, 4.1 Running Hot\n[Chaos live](https://example.test/hot)");
  });

  it("carries the disclosure and sends readers to the countable path", () => {
    expect(body).toContain(LETTER_DISCLOSURE);
    expect(body).toContain(`(${LETTER_SITE_URL})`);
    expect(LETTER_SITE_URL).toBe("https://litmustimes.com/letter");
  });

  it("quotes no article text", () => {
    expect(body).not.toContain("A plain sentence with a loaded word in it.");
  });

  it("has nothing to send when no story qualifies", () => {
    expect(() => renderLetter([])).toThrow(/no story/);
  });

  it("dates the subject in Pacific time", () => {
    expect(letterSubject("2026-10-11T05:30:00.000Z")).toBe("The LITMUS weekly letter, October 10");
  });
});
