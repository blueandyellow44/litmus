import { describe, expect, it } from "vitest";
import { nonStaffSpeechSpans } from "./speakerTurns.js";
import { dropNonStaffSpeech, isTooWeakToMark, markerWhy } from "./markerGuards.js";

const spoken = (text: string) => nonStaffSpeechSpans(text).map(([a, b]) => text.slice(a, b).trim());

// Shaped on PBS NewsHour's Hegseth segment, 2026-10-02.
const PBS = `Defense Secretary Pete Hegseth says he is reshaping the military. Geoff Bennett discussed more with Peter Feaver.

Geoff Bennett:

In a speech yesterday, Hegseth offered a blunt description of the Pentagon.

Pete Hegseth, U.S. Defense Secretary:

We are no longer the woke department or the weak department. The ideological clowns are out.

Geoff Bennett:

For analysis, I spoke with Peter Feaver.

Peter Feaver, Duke University:

Thanks for having me.

Geoff Bennett:

Is there merit to what he's doing?

Peter Feaver:

It's not transparent enough, I think.`;

// Shaped on NPR's California debate piece, 2026-10-01.
const NPR = `MICHEL MARTIN, HOST:

The candidates sparred in a debate.

GUY MARZORATI, BYLINE: Becerra came in with a wide lead.

XAVIER BECERRA: Who's never balanced a budget the size of California.

MARZORATI: Hilton is a former Fox News commentator.

STEVE HILTON: All you ever say is Trump, Trump, Trump.`;

describe("nonStaffSpeechSpans", () => {
  it("silos a PBS newsmaker and guest, never the host", () => {
    const s = spoken(PBS);
    expect(s).toContain("We are no longer the woke department or the weak department. The ideological clowns are out.");
    expect(s).toContain("Thanks for having me.");
    // The guest's later, untitled label is still the guest.
    expect(s).toContain("It's not transparent enough, I think.");
    expect(s.join(" ")).not.toContain("blunt description");
    expect(s.join(" ")).not.toContain("Is there merit");
  });

  it("silos NPR guests and keeps HOST and BYLINE turns, including the surname repeat", () => {
    const s = spoken(NPR);
    expect(s.join(" ")).toContain("never balanced a budget");
    expect(s.join(" ")).toContain("Trump, Trump, Trump");
    expect(s.join(" ")).not.toContain("wide lead");
    expect(s.join(" ")).not.toContain("former Fox News commentator");
    expect(s.join(" ")).not.toContain("sparred in a debate");
  });

  it("leaves ordinary articles and newsletter section heads alone", () => {
    expect(nonStaffSpeechSpans("The mayor spoke Tuesday.\n\nShe said the plan would work.")).toEqual([]);
    const newsletter = "FIRST ON FOX:\n\nA coalition pressed the agency.\n\nWORKING OUT THE KINKS: The department began.\n\nJACOBS WINS: He won.";
    expect(nonStaffSpeechSpans(newsletter)).toEqual([]);
    const statement = "Mark Zandi, chief economist at Moody's, said in a statement shared with Newsweek :\n\nThe market is looking through it.\n\nPhotograph: Getty";
    expect(nonStaffSpeechSpans(statement)).toEqual([]);
  });
});

describe("dropNonStaffSpeech", () => {
  it("drops a mark on a guest's words and keeps the host's", () => {
    const markers = [
      { text: "ideological clowns", category: "loaded_terms", intensity: 4 },
      { text: "blunt description", category: "grounded", intensity: 2 },
    ];
    expect(dropNonStaffSpeech(markers, PBS).map((m) => m.text)).toEqual(["blunt description"]);
  });

  it("keeps a phrase the host also used in their own voice", () => {
    const text = PBS.replace("For analysis", "Those ideological clowns, he said. For analysis");
    const markers = [{ text: "ideological clowns", category: "loaded_terms", intensity: 4 }];
    expect(dropNonStaffSpeech(markers, text)).toHaveLength(1);
  });
});

describe("isTooWeakToMark", () => {
  it("refuses a lone function word at any intensity, and a loaded mark rated 1", () => {
    expect(isTooWeakToMark({ text: "But", category: "language_intensity", intensity: 1 })).toBe(true);
    expect(isTooWeakToMark({ text: "But", category: "language_intensity", intensity: 4 })).toBe(true);
    expect(isTooWeakToMark({ text: "at the center of", category: "language_intensity", intensity: 1 })).toBe(true);
  });
  it("keeps real loaded wording and low-intensity grounded wording", () => {
    expect(isTooWeakToMark({ text: "self-appointed", category: "loaded_terms", intensity: 3 })).toBe(false);
    expect(isTooWeakToMark({ text: "A federal judge has twice said", category: "grounded", intensity: 1 })).toBe(false);
  });
});

describe("markerWhy", () => {
  it("keeps a usable reason, drops a missing one, and caps a long one", () => {
    expect(markerWhy("  labels his role as illegitimate ")).toEqual({ why: "labels his role as illegitimate" });
    expect(markerWhy(undefined)).toEqual({});
    expect(markerWhy("   ")).toEqual({});
    expect(markerWhy("x".repeat(300)).why!.length).toBe(140);
  });
});
