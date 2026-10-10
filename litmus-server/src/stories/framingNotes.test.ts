import { describe, expect, it } from "vitest";
import { buildFramingNotes, type FramingNoteMemberInput } from "./framingNotes.js";

function member(over: Partial<FramingNoteMemberInput>): FramingNoteMemberInput {
  return {
    outletName: "Outlet",
    role: "primary",
    leadParagraph: "The event happened on Saturday.",
    leadMarkerCategories: ["grounded"],
    ...over,
  };
}

describe("buildFramingNotes", () => {
  it("returns nothing for a single-outlet story", () => {
    expect(buildFramingNotes([member({})])).toEqual([]);
  });

  it("returns nothing when every member is headline-only", () => {
    const members = [
      member({ outletName: "A", leadParagraph: null, leadMarkerCategories: [] }),
      member({ outletName: "B", leadParagraph: null, leadMarkerCategories: [] }),
    ];
    expect(buildFramingNotes(members)).toEqual([]);
  });

  it("excludes secondary (roundup) members from both counts", () => {
    const members = [
      member({ outletName: "A" }),
      member({ outletName: "B" }),
      member({ outletName: "Roundup", role: "secondary" }),
    ];
    const notes = buildFramingNotes(members);
    for (const note of notes) {
      expect(note.counts.map((c) => c.outletName)).toEqual(["A", "B"]);
    }
  });

  it("labels both techniques Legitimate framing and never mentions Distortion", () => {
    const members = [member({ outletName: "A" }), member({ outletName: "B" })];
    const notes = buildFramingNotes(members);
    for (const note of notes) {
      expect(note.label).toBe("Legitimate framing");
      expect(JSON.stringify(note)).not.toMatch(/distortion/i);
    }
  });

  // Real data from the archived 2026-09-13 edition (docs/plans/story-first-
  // build-2026-09-13.md's replay), grounding the two techniques in the exact
  // pair the vision doc uses: Axios's original report (speculative, quoted)
  // against CNBC's mostly-attributed reporting.
  it("reads the real Axios/CNBC Amodei-essay leads the way the vision doc describes them", () => {
    const axios = member({
      outletName: "Axios — Politics & Policy",
      leadParagraph: "Anthropic CEO Dario Amodei is calling for an immediate slowdown in the pace of AI development, warning of potentially devastating consequences in a matter of months otherwise.",
      leadMarkerCategories: ["grounded", "emotional_language", "speculation"],
    });
    const cnbc = member({
      outletName: "CNBC",
      leadParagraph: `"The more long-term thing would be working together to put a speed limit on the rate of AI progress," Amodei told CBS News.`,
      leadMarkerCategories: ["grounded"],
    });
    const notes = buildFramingNotes([axios, cnbc]);
    const leadEmphasis = notes.find((n) => n.technique === "lead_emphasis")!;
    expect(leadEmphasis.text).toBe("Opens with loaded or speculative wording: 1 of 2 outlets.");
    expect(leadEmphasis.counts).toEqual([
      { outletName: "Axios — Politics & Policy", value: "Loaded lead" },
      { outletName: "CNBC", value: "Grounded lead" },
    ]);
    const whoseVoice = notes.find((n) => n.technique === "whose_voice")!;
    expect(whoseVoice.text).toBe("Opens with a direct quote or attribution: 1 of 2 outlets.");
    expect(whoseVoice.counts).toEqual([
      { outletName: "Axios — Politics & Policy", value: "Outlet's own framing" },
      { outletName: "CNBC", value: "Quoted lead" },
    ]);
  });

  it("treats PBS's flat lead and Fox's narrative-but-grounded lead as both grounded", () => {
    const pbs = member({
      outletName: "PBS NewsHour",
      leadParagraph: "The pilot made an emergency landing in Lake Wausau. They both ended up in the water and swam to safety.",
      leadMarkerCategories: ["grounded"],
    });
    const fox = member({
      outletName: "Fox News — Politics",
      leadParagraph: "U.S. Rep. Tom Tiffany and a pilot escaped with minor injuries after their small plane lost power and made an emergency landing in a lake Saturday night.",
      leadMarkerCategories: ["grounded"],
    });
    const notes = buildFramingNotes([pbs, fox]);
    const leadEmphasis = notes.find((n) => n.technique === "lead_emphasis")!;
    expect(leadEmphasis.text).toBe("Opens with loaded or speculative wording: 0 of 2 outlets.");
  });
});
