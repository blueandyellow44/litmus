import { describe, expect, it } from "vitest";
import { wireCoverageLine, wireLede } from "./storyModel.ts";
import { headlineOnly, member, story } from "./storyTestData.ts";

describe("wireLede", () => {
  it("uses the assessment's first paragraph only", () => {
    const s = story({ assessment: { text: "First para.\n\nSecond para.", model: "t", generatedAt: "2026-09-26T00:00:00Z" } });
    expect(wireLede(s)).toBe("First para.");
  });
  it("falls back to the event statement when there is no assessment", () => {
    expect(wireLede(story({ assessment: null, eventStatement: "ICE agent shot a man in Austin." }))).toBe("ICE agent shot a man in Austin.");
  });
  it("returns null rather than an empty lede", () => {
    expect(wireLede(story({ assessment: null, eventStatement: "  " }))).toBeNull();
  });
});

describe("wireCoverageLine", () => {
  it("names the hottest and calmest scored telling by outlet", () => {
    const s = story({
      members: [
        member({ outletName: "Townhall", composite: 4.1 }),
        member({ outletName: "Breitbart — Politics", composite: 1.5 }),
        member({ outletName: "NPR — Politics", composite: 2.2 }),
      ],
    });
    expect(wireCoverageLine(s)).toBe("3 outlets · Townhall ran hottest, Breitbart calmest");
  });
  it("never compares unscored, headline-only or roundup members", () => {
    const s = story({
      members: [
        member({ outletName: "BBC News", composite: 2.6 }),
        headlineOnly({ outletName: "New York Times" }),
        member({ outletName: "Daily Wire", composite: null }),
        member({ outletName: "Roundup", composite: 4.9, role: "secondary" }),
      ],
    });
    expect(wireCoverageLine(s)).toMatch(/· 1 scored so far$/);
  });
  it("says so when nothing is scored", () => {
    expect(wireCoverageLine(story({ members: [headlineOnly(), member({ composite: null })] }))).toBe("1 outlet · none scored yet");
  });
  it("does not invent a hottest and calmest when every score is equal", () => {
    const s = story({ members: [member({ outletName: "A", composite: 2 }), member({ outletName: "B", composite: 2 })] });
    expect(wireCoverageLine(s)).toBe("2 outlets · 2 scored, all 2.0 Grounded");
  });
});

import { evidenceQuotes, hottestTelling, frontExcerpts, inPoliticalScope, markerReason, mostHystericalLine, mostPracticalLine, outletRows, sentenceAround } from "./storyModel.ts";

const ex = (words: number, markers: Array<{ text: string; category: string; intensity: number }>) => ({
  paragraphs: [Array.from({ length: words }, (_, i) => `w${i}`).join(" ")],
  markers,
});

describe("the extremes under the summary", () => {
  it("picks the hottest telling's most intense loaded span", () => {
    const s = story({
      members: [
        member({ outletName: "Calm", composite: 1.5, excerpt: ex(10, [{ text: "reported on Friday", category: "grounded", intensity: 3 }]) }),
        member({ outletName: "Warm", composite: 3.0, excerpt: ex(10, [{ text: "shocking move", category: "loaded_terms", intensity: 4 }]) }),
        member({ outletName: "Hot", composite: 4.2, excerpt: ex(10, [{ text: "all-out war on the press", category: "emotional_language", intensity: 4 }]) }),
      ],
    });
    expect(mostHystericalLine(s)).toMatchObject({ text: "all-out war on the press", member: { outletName: "Hot" } });
    expect(mostPracticalLine(s)).toMatchObject({ text: "reported on Friday", member: { outletName: "Calm" } });
  });

  it("returns null rather than inventing a line when no span qualifies", () => {
    const s = story({ members: [member({ excerpt: ex(10, []) }), member({ composite: null })] });
    expect(mostHystericalLine(s)).toBeNull();
    expect(mostPracticalLine(s)).toBeNull();
  });

  it("never quotes an unscored, headline-only or roundup member", () => {
    const s = story({
      members: [
        member({ composite: null, excerpt: ex(10, [{ text: "unscored", category: "loaded_terms", intensity: 5 }]) }),
        member({ role: "secondary", excerpt: ex(10, [{ text: "roundup", category: "loaded_terms", intensity: 5 }]) }),
        member({ composite: 2, excerpt: ex(10, [{ text: "scored", category: "loaded_terms", intensity: 3 }]) }),
      ],
    });
    expect(mostHystericalLine(s)?.text).toBe("scored");
  });
});

describe("frontExcerpts", () => {
  it("shows the calmest, a middle telling and the hottest while under about 500 words", () => {
    const s = story({
      members: [
        member({ outletName: "Hot", composite: 4, excerpt: ex(150, []) }),
        member({ outletName: "Calm", composite: 1.5, excerpt: ex(150, []) }),
        member({ outletName: "Mid", composite: 2.8, excerpt: ex(150, []) }),
        member({ outletName: "Mid2", composite: 3.6, excerpt: ex(150, []) }),
      ],
    });
    expect(frontExcerpts(s).map((m) => m.outletName)).toEqual(["Calm", "Mid", "Hot"]);
  });
  it("stops at two when those already reach about 500 words", () => {
    const s = story({
      members: [
        member({ outletName: "Hot", composite: 4, excerpt: ex(260, []) }),
        member({ outletName: "Calm", composite: 1.5, excerpt: ex(260, []) }),
        member({ outletName: "Mid", composite: 2.8, excerpt: ex(100, []) }),
      ],
    });
    expect(frontExcerpts(s).map((m) => m.outletName)).toEqual(["Calm", "Hot"]);
  });
  it("shows one when only one telling is scored, none when none is", () => {
    expect(frontExcerpts(story({ members: [member({ excerpt: ex(50, []) }), member({ composite: null })] }))).toHaveLength(1);
    expect(frontExcerpts(story({ members: [member({ composite: null })] }))).toHaveLength(0);
  });
});

describe("mostPracticalLine prefers a phrase over a bare date", () => {
  it("skips a one-word date when a real grounded phrase exists", () => {
    const s = story({
      members: [
        member({ outletName: "Calm", composite: 1.4, excerpt: ex(10, [
          { text: "Friday", category: "grounded", intensity: 5 },
          { text: "reinstated the 2022 district boundaries", category: "grounded", intensity: 2 },
        ]) }),
      ],
    });
    expect(mostPracticalLine(s)?.text).toBe("reinstated the 2022 district boundaries");
  });
});

describe("inPoliticalScope", () => {
  it("shows only stories judged in scope once any story carries a verdict", () => {
    const yes = story({ touchesPolitics: true });
    const no = story({ touchesPolitics: false });
    const unjudged = story({ touchesPolitics: null });
    expect(inPoliticalScope([yes, no, unjudged])).toEqual([yes]);
  });
  it("shows everything for an edition built before the check existed", () => {
    const old = [story({ touchesPolitics: null }), story({ touchesPolitics: undefined as unknown as null })];
    expect(inPoliticalScope(old)).toHaveLength(2);
  });
});

describe("evidence under every outlet", () => {
  const markers = [
    { text: "reported on Friday", category: "grounded", intensity: 2 },
    { text: "a brazen assault", category: "loaded_terms", intensity: 5 },
    { text: "officials said on Tuesday", category: "grounded", intensity: 3 },
    { text: "Friday", category: "grounded", intensity: 5 },
    { text: "A brazen assault", category: "emotional_language", intensity: 4 },
    { text: "chaos", category: "language_intensity", intensity: 3 },
    { text: "an odd tag", category: "not_a_category", intensity: 5 },
  ];
  it("leads a hot telling with loaded wording, deduped, capped at four", () => {
    const quotes = evidenceQuotes(member({ composite: 3.8, excerpt: ex(40, markers) }));
    expect(quotes.map((q) => q.text)).toEqual(["a brazen assault", "chaos", "officials said on Tuesday", "reported on Friday"]);
    expect(quotes.map((q) => q.kind)).toEqual(["loaded", "loaded", "grounded", "grounded"]);
  });
  it("leads a calm telling with grounded wording", () => {
    const calm = evidenceQuotes(member({ composite: 1.6, excerpt: ex(40, markers) }));
    expect(calm[0]).toEqual({ text: "officials said on Tuesday", kind: "grounded" });
    expect(calm.map((q) => q.text)).not.toContain("Friday");
  });
  it("quotes nothing for an unscored or excerpt-less member", () => {
    expect(evidenceQuotes(member({ composite: null, excerpt: ex(40, markers) }))).toEqual([]);
    expect(evidenceQuotes(headlineOnly())).toEqual([]);
  });
  it("lists every primary member, calmest scored first, unscored last, roundups out", () => {
    const s = story({ members: [
      member({ outletName: "Hot", composite: 4 }),
      headlineOnly({ outletName: "NYT" }),
      member({ outletName: "Calm", composite: 1.5 }),
      member({ outletName: "Roundup", role: "secondary" }),
    ] });
    expect(outletRows(s).map((m) => m.outletName)).toEqual(["Calm", "Hot"]);
  });
});

// The defects Max reported on the live page, 2026-10-02.
describe("the extremes carry their sentence and their reason", () => {
  const atlantic = {
    paragraphs: ["Officials announced today that the show will move. Trump, the center's self-appointed chairman, has been mired in drama since."],
    markers: [{ text: "self-appointed", category: "loaded_terms", intensity: 3 }],
  };
  it("quotes the whole sentence around a one-word mark, with the category's reason when the scorer gave none", () => {
    const line = mostHystericalLine(story({ members: [member({ outletName: "The Atlantic", composite: 3.4, excerpt: atlantic })] }))!;
    expect(line.text).toBe("self-appointed");
    expect(line.sentence).toBe("Trump, the center's self-appointed chairman, has been mired in drama since.");
    expect(line.why).toMatch(/^Marked as a loaded term/);
  });
  it("uses the scorer's own reason when it has one", () => {
    expect(markerReason({ category: "loaded_terms", why: "casts his chairmanship as illegitimate" })).toBe("casts his chairmanship as illegitimate");
  });
  it("cuts a very long sentence to the words around the span", () => {
    const long = `${Array.from({ length: 30 }, (_, i) => `a${i}`).join(" ")} the span ${Array.from({ length: 30 }, (_, i) => `b${i}`).join(" ")}.`;
    const out = sentenceAround([long], "the span");
    expect(out.startsWith("… a15")).toBe(true);
    expect(out.endsWith("b14 …")).toBe(true);
  });
  it("never headlines a hedge, a grounded mark rated 1, or a loaded mark rated 1 as an extreme", () => {
    const s = story({ members: [member({ composite: 1.8, excerpt: ex(10, [
      { text: "Trump has said in social media posts", category: "hedging", intensity: 2 },
      { text: "We are no longer the woke department", category: "grounded", intensity: 1 },
      { text: "But", category: "language_intensity", intensity: 1 },
    ]) })] });
    expect(mostPracticalLine(s)).toBeNull();
    expect(mostHystericalLine(s)).toBeNull();
    expect(evidenceQuotes(s.members[0]!).map((q) => q.text)).not.toContain("But");
  });
});

// Audit 2026-10-02, section 3.2: the two live failures.
describe("most hysterical comes from the hottest telling only", () => {
  it("never quotes a cooler telling's line (Hormuz: 'terrorist hijacking' from a 1.5 piece beside a 3.5 piece)", () => {
    const s = story({ members: [
      member({ outletName: "Grounded outlet", composite: 1.5, excerpt: ex(10, [{ text: "terrorist hijacking", category: "loaded_terms", intensity: 4 }]) }),
      member({ outletName: "The American Conservative", composite: 3.5, excerpt: ex(10, [{ text: "a mild phrase", category: "loaded_terms", intensity: 2 }]) }),
    ] });
    expect(hottestTelling(s)?.outletName).toBe("The American Conservative");
    expect(mostHystericalLine(s)).toBeNull();
  });
  it("returns null for an intensity-2 sentence (cartel: 'remain undisclosed for operational security reasons')", () => {
    const s = story({ members: [member({ composite: 2.9, excerpt: ex(10, [
      { text: "The exact size and duration of the unit deployment remain undisclosed for operational security reasons.", category: "speculation", intensity: 2 },
    ]) })] });
    expect(mostHystericalLine(s)).toBeNull();
  });
  it("quotes the hottest telling's span when it is rated 3 or more", () => {
    const s = story({ members: [
      member({ outletName: "Calm", composite: 1.5, excerpt: ex(10, [{ text: "chaos", category: "loaded_terms", intensity: 5 }]) }),
      member({ outletName: "Hot", composite: 3.5, excerpt: ex(10, [{ text: "a brazen assault", category: "loaded_terms", intensity: 3 }]) }),
    ] });
    expect(mostHystericalLine(s)).toMatchObject({ text: "a brazen assault", member: { outletName: "Hot" } });
  });
});

describe("an outlet's extra filing", () => {
  it("reads as Also filed and is never counted as a telling", async () => {
    const { memberState, memberStateText, isTelling } = await import("./storyModel.ts");
    const extra = member({ role: "secondary", alsoFiled: true });
    expect(memberState(extra)).toBe("also_filed");
    expect(memberStateText(memberState(extra))).toBe("Also filed");
    expect(isTelling(extra)).toBe(false);
  });
});

import { calmAndHot, calmestTelling, excerptOpening, tellingLine, OPENING_WORDS } from "./storyModel.ts";

describe("the calmest and hottest telling blocks (2026-10-08)", () => {
  it("quotes the hottest telling's own loaded line even below 3, so a headline-driven score still has a telling to read", () => {
    // The diesel story: Foreign Policy at 3.1, heat in the headline, body marks at 2.
    const s = story({
      members: [
        member({ outletName: "CNBC", composite: 1.9, excerpt: { paragraphs: ["Diesel topped $6 a gallon in September for the first time ever."], markers: [{ text: "topped $6 a gallon in September", category: "grounded", intensity: 3 }] } }),
        member({ outletName: "Foreign Policy", composite: 3.1, excerpt: { paragraphs: ["There is another risk in potentially robbing Peter to pay Paul, beyond lost revenue."], markers: [{ text: "robbing Peter to pay Paul", category: "loaded_terms", intensity: 2 }] } }),
      ],
    });
    const { calm, hot } = calmAndHot(s);
    expect(calm).toMatchObject({ member: { outletName: "CNBC" }, line: { text: "topped $6 a gallon in September" }, opening: null });
    expect(hot).toMatchObject({ member: { outletName: "Foreign Policy" }, line: { text: "robbing Peter to pay Paul" }, opening: null });
    expect(mostHystericalLine(s)).toBeNull();
  });

  it("takes the calm line from the calmest outlet only, never a warmer one that happens to have a grounded mark", () => {
    const s = story({
      members: [
        member({ outletName: "BBC", composite: 1.3, excerpt: ex(30, []) }),
        member({ outletName: "American Greatness", composite: 2.4, excerpt: ex(10, [{ text: "w1 w2 w3", category: "grounded", intensity: 3 }]) }),
      ],
    });
    expect(mostPracticalLine(s)?.member.outletName).toBe("American Greatness");
    const { calm } = calmAndHot(s);
    expect(calm?.member.outletName).toBe("BBC");
    expect(calm?.line).toBeNull();
    expect(calm?.opening).toMatch(/^w0 w1/);
  });

  it("shows only the calmest block when a single telling is scored", () => {
    const s = story({ members: [member({ outletName: "Solo", composite: 2.2, excerpt: ex(5, []) }), member({ outletName: "Unscored", composite: null })] });
    expect(calmAndHot(s)).toMatchObject({ calm: { member: { outletName: "Solo" } }, hot: null });
  });

  it("returns nothing when no telling is scored", () => {
    expect(calmAndHot(story({ members: [member({ composite: null })] }))).toEqual({ calm: null, hot: null });
    expect(calmestTelling(story({ members: [] }))).toBeNull();
  });

  it("never draws a loaded mark rated 1, and prefers a grounded phrase over a bare date", () => {
    const m = member({ composite: 2, excerpt: { paragraphs: ["On Friday the court reinstated the 2022 boundaries, a mild move."], markers: [
      { text: "a mild move", category: "loaded_terms", intensity: 1 },
      { text: "Friday", category: "grounded", intensity: 4 },
      { text: "reinstated the 2022 boundaries", category: "grounded", intensity: 3 },
    ] } });
    expect(tellingLine(m, "loaded")).toBeNull();
    expect(tellingLine(m, "grounded")?.text).toBe("reinstated the 2022 boundaries");
  });

  it("opens on whole sentences and cuts an overlong first sentence at a word", () => {
    const two = member({ excerpt: { paragraphs: ["First short sentence. Second short one. Then " + ex(60, []).paragraphs[0]], markers: [] } });
    expect(excerptOpening(two)).toBe("First short sentence. Second short one.");
    const long = member({ excerpt: ex(80, []) });
    const opening = excerptOpening(long)!;
    expect(opening.endsWith(" …")).toBe(true);
    expect(opening.split(/\s+/).length).toBe(OPENING_WORDS + 1);
    expect(excerptOpening(member({ excerpt: null }))).toBeNull();
  });
});

// 2026-10-10: three tellings at 1.6; the summary named Daily Wire calmest
// while the Calmest telling block showed BBC News.
describe("a tie on the score", () => {
  const mark = (category: string) => ({ text: `${category} words here`, category, intensity: 2 });
  const tied = story({
    members: [
      member({ outletName: "BBC News", composite: 1.6, excerpt: { paragraphs: ["x"], markers: [mark("loaded_terms"), mark("grounded")] } }),
      member({ outletName: "NPR", composite: 1.6, excerpt: { paragraphs: ["x"], markers: [mark("grounded"), mark("grounded")] } }),
      member({ outletName: "Breitbart", composite: 2.8, excerpt: { paragraphs: ["x"], markers: [mark("loaded_terms")] } }),
      member({ outletName: "Daily Wire", composite: 1.6, excerpt: { paragraphs: ["x"], markers: [mark("loaded_terms"), mark("loaded_terms")] } }),
    ],
  });

  it("names the telling with the fewest loaded marks calmest", () => {
    expect(calmestTelling(tied)?.outletName).toBe("NPR");
  });
  it("says the same outlet in the summary line as in the block", () => {
    expect(wireCoverageLine(tied)).toBe("4 outlets · Breitbart ran hottest, NPR calmest");
    expect(calmAndHot(tied).calm?.member.outletName).toBe("NPR");
  });
  it("names the telling with the most loaded marks hottest when the top score is tied", () => {
    const top = story({
      members: [
        member({ outletName: "A", composite: 3.5, excerpt: { paragraphs: ["x"], markers: [mark("loaded_terms")] } }),
        member({ outletName: "B", composite: 3.5, excerpt: { paragraphs: ["x"], markers: [mark("loaded_terms"), mark("loaded_terms")] } }),
        member({ outletName: "C", composite: 1.2 }),
      ],
    });
    expect(hottestTelling(top)?.outletName).toBe("B");
    expect(wireCoverageLine(top)).toMatch(/B ran hottest, C calmest$/);
  });
  it("falls back to member order when the marks tie too", () => {
    const s = story({ members: [member({ outletName: "First", composite: 2 }), member({ outletName: "Second", composite: 2 }), member({ outletName: "Hot", composite: 4 })] });
    expect(calmestTelling(s)?.outletName).toBe("First");
  });
});
