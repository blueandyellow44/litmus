// The story components rendered to static markup: what each one prints, the
// states it must never leave blank, and the rules it enforces rather than
// trusts. No DOM is needed; the checks are on the HTML.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { AI_DISCLOSURE_DID_NOT, AI_DISCLOSURE_ID, AI_DISCLOSURE_WROTE, AiDisclosure } from "./AiDisclosure.tsx";
import { Byline } from "./Byline.tsx";
import { DISTORTION_DEFINITION, EvidenceCard, NO_RECORD_STATE, recordSourceLine, type EvidenceFinding } from "./EvidenceCard.tsx";
import { FramingNotes, LAYER3_HEADING, NO_NOTES_YET, SINGLE_OUTLET_NOTE } from "./FramingNotes.tsx";
import { MemberRowDesktop, MemberRowMobile } from "./MemberRow.tsx";
import { MATRIX_TITLE, StoryMatrix } from "./StoryMatrix.tsx";
import { TemperatureStrip } from "./TemperatureStrip.tsx";
import { BYLINE_HREF, BYLINE_TEXT } from "../../lib/brand.ts";
import { headlineOnly, member } from "../../lib/storyTestData.ts";

const html = (el: ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);
// React escapes apostrophes in static markup, so a constant with one is
// compared in its escaped form; the component copy itself stays plain.
const escaped = (text: string) => text.replace(/'/g, "&#x27;");

describe("TemperatureStrip", () => {
  it("prints the range as number and band word, with a tick per scored member", () => {
    const out = html(<TemperatureStrip composites={[1.5, 2.4, null]} />);
    expect(out).toContain("1.5");
    expect(out).toContain("Grounded");
    expect(out).toContain("2.4");
    expect(out).toContain('aria-label="Temperature strip: 1.5 Grounded to 2.4 Grounded, 2 scored reports"');
    expect(out.match(/title="[0-9.]+ [A-Za-z ]+"/g)).toHaveLength(2);
  });
  it("says Not yet scored when nothing is", () => {
    expect(html(<TemperatureStrip composites={[]} />)).toContain("Not yet scored");
  });
});

describe("StoryMatrix", () => {
  const members = [
    member({ outletName: "Politico", composite: 2, politicalLean: -12 }),
    member({ outletName: "Fox News", composite: 4.1, politicalLean: 60 }),
    headlineOnly({ outletName: "WSJ" }),
  ];
  it("labels every dot with outlet, number and band word, and describes itself", () => {
    const out = html(<StoryMatrix members={members} preset="storyDesktop" id="mx" />);
    expect(out).toContain(MATRIX_TITLE);
    expect(out).toContain("Politico");
    expect(out).toContain("2.0 Grounded");
    expect(out).toContain("4.1 Running Hot");
  });
  it("leaves headline-only reports out entirely: no dot, no row, no name (2026-09-26)", () => {
    const out = html(<StoryMatrix members={members} preset="storyMobile" id="mx" />);
    expect(out).not.toContain('stroke-width="1.5"');
    expect(out).not.toMatch(/Headline only/);
  });
  it("carries a table fallback with a row per member it reads in full", () => {
    const out = html(<StoryMatrix members={members} preset="front" id="mx" />);
    expect(out.match(/<tr>/g)).toHaveLength(3); // header plus two read members; headline-only left out
    expect(out).toContain("Read in full");
    expect(out).not.toContain("Headline only, not scored");
  });
  it("names the empty state instead of drawing an empty chart", () => {
    const out = html(<StoryMatrix members={[member({ composite: null })]} preset="front" id="mx" />);
    expect(out).toContain("No scored report to plot yet.");
    expect(out).toContain("Analysis is pending");
    expect(out).not.toContain("<svg");
  });
});

describe("MemberRow", () => {
  it("renders the outlet, the headline as a link out, the score and the highlighted excerpt", () => {
    const m = member({ outletName: "Axios — Politics & Policy", composite: 2.3, url: "https://axios.test/x" });
    for (const out of [html(<MemberRowDesktop member={m} />), html(<MemberRowMobile member={m} />)]) {
      expect(out).toContain("Axios");
      expect(out).toContain('href="https://axios.test/x"');
      expect(out).toContain("2.3");
      expect(out).toContain("Grounded");
      expect(out).toContain('class="hl-loaded"');
      expect(out).toContain("Read it at Axios");
      expect(out).toContain("Full analysis");
      expect(out).toContain(`/articles/${m.articleId}`);
    }
  });
  it("gives a headline-only member a headline and a link, nothing else", () => {
    const m = headlineOnly({ outletName: "WSJ", url: "https://wsj.test/y" });
    for (const out of [html(<MemberRowDesktop member={m} />), html(<MemberRowMobile member={m} />)]) {
      expect(out).toContain("Headline only, not scored");
      expect(out).toContain('href="https://wsj.test/y"');
      expect(out).not.toContain("<blockquote");
      expect(out).not.toContain("Full analysis");
      expect(out).not.toContain("Grounded");
    }
  });
  it("names the origin of a syndicated copy", () => {
    const m = member({ kind: "syndicated", syndicatedOfArticleId: 7 });
    expect(html(<MemberRowMobile member={m} originName="Reuters" />)).toContain("Carries Reuters&#x27;s copy");
  });
  it("keeps the mobile outlet link at 44px", () => {
    expect(html(<MemberRowMobile member={member()} />)).toContain("min-h-[44px]");
  });
});

describe("FramingNotes", () => {
  it("uses the spec heading and prints a note with its tag, technique and counts", () => {
    const out = html(
      <FramingNotes
        layout="desktop"
        singleOutlet={false}
        notes={[{ technique: "lead_emphasis", label: "Legitimate framing", text: "Leads with cost: 3 of 5 outlets", counts: [{ outletName: "Politico", value: "cost" }] }]}
      />,
    );
    expect(out).toContain(escaped(LAYER3_HEADING));
    expect(out).toContain("Legitimate framing");
    expect(out).toContain("Lead emphasis");
    expect(out).toContain("Leads with cost: 3 of 5 outlets");
    expect(out).toContain("<dt");
    expect(out).toContain("Politico");
  });
  it("explains a single-outlet story and an untested one instead of going blank", () => {
    expect(html(<FramingNotes layout="mobile" singleOutlet notes={[]} />)).toContain(SINGLE_OUTLET_NOTE);
    expect(html(<FramingNotes layout="mobile" singleOutlet={false} notes={[]} />)).toContain(NO_NOTES_YET);
  });
  it("never prints the word Distortion", () => {
    expect(html(<FramingNotes layout="desktop" singleOutlet={false} notes={[]} />)).not.toContain("Distortion");
  });
});

describe("EvidenceCard", () => {
  const finding: EvidenceFinding = {
    verdict: "Legitimate framing",
    technique: "Emphasis choice",
    outletName: "The Atlantic",
    composite: 2.3,
    quote: { text: "The warnings came as a code red for the industry.", markers: [{ text: "code red", category: "loaded_terms", intensity: 3 }] },
    record: { fact: "Four labs signed the letter.", reportedBy: ["Politico", "CNBC"] },
    why: "The words are the outlet's emphasis. Two other reports carry the same fact. Nothing states more than the record supports.",
  };
  it("renders the Measured order: their words, the record, reported by, why, dispute", () => {
    const out = html(<EvidenceCard finding={finding} />);
    const order = ["Their words", "code red", "What the other reports say", "Four labs signed the letter.", "Reported by 2 outlets: Politico, CNBC", "Why we say this", "Dispute this"];
    let last = -1;
    for (const needle of order) {
      const at = out.indexOf(needle);
      expect(at, needle).toBeGreaterThan(last);
      last = at;
    }
    expect(out).toContain('class="hl-loaded"');
    expect(out).toContain("<details");
    expect(out).not.toContain(DISTORTION_DEFINITION);
  });
  it("carries the definition beside a Distortion tag", () => {
    const out = html(<EvidenceCard finding={{ ...finding, verdict: "Distortion" }} />);
    expect(out).toContain("Distortion");
    expect(out).toContain(DISTORTION_DEFINITION);
  });
  it("refuses to show a verdict with no record", () => {
    const out = html(<EvidenceCard finding={{ ...finding, record: { fact: "x", reportedBy: [] } }} />);
    expect(out).toContain(NO_RECORD_STATE);
    expect(out).not.toContain("Legitimate framing");
  });
  it("names a primary record when that is the evidence", () => {
    expect(recordSourceLine({ fact: "x", reportedBy: [], primaryRecord: { label: "Docket 24-CR-118", url: "https://court.test" } })).toBe("Primary record: Docket 24-CR-118");
    expect(recordSourceLine({ fact: "x", reportedBy: ["A"] })).toBe("Reported by 1 outlet: A");
  });
});

describe("AiDisclosure and Byline", () => {
  it("states what AI wrote and what it did not, once, under a fixed id", () => {
    const out = html(<AiDisclosure />);
    expect(out).toContain(`id="${AI_DISCLOSURE_ID}"`);
    expect(out).toContain(AI_DISCLOSURE_WROTE);
    expect(out).toContain(escaped(AI_DISCLOSURE_DID_NOT));
    // Production runs Haiku and Jev only (Max, 2026-10-02); no Sonnet call exists.
    expect(AI_DISCLOSURE_WROTE).toContain("Claude Haiku");
    expect(AI_DISCLOSURE_WROTE).toContain("judged by Jev");
    expect(AI_DISCLOSURE_WROTE).not.toContain("Sonnet");
    expect(AI_DISCLOSURE_WROTE).toContain("wrote each story assessment");
    expect(AI_DISCLOSURE_DID_NOT).toContain("outlets' own words");
    expect(out).toContain('href="/legal"');
  });
  it("links the byline to maxsheahan.com with no styling of its own", () => {
    const out = html(<Byline />);
    expect(out).toContain(`href="${BYLINE_HREF}"`);
    expect(out).toContain(BYLINE_TEXT);
    expect(BYLINE_HREF).toBe("https://maxsheahan.com");
  });
});
