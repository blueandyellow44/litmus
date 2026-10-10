import { beforeEach, describe, expect, it, vi } from "vitest";

let reply: unknown = { reasons: [] };
let fail = false;
vi.mock("../lib/anthropic.js", () => ({
  anthropic: () => ({
    messages: {
      create: async () => {
        if (fail) throw new Error("fixture outage");
        return { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "t", name: "submit_reasons", input: reply }] };
      },
    },
  }),
}));
const { biggestDriver, driversText, isDriverReason, isReason, retryReasons } = await import("./reasonCheck.js");
type Dimension = "headline" | "language" | "sourcing" | "fallacies" | "structure";

// Three real one-liners from the live edition, 2026-10-02 (audit section 3.3):
// each retells the news and says nothing about how it was written.
const AUDIT_FAILURES = [
  "An Iranian spokeswoman said the U.S. delivered a counterproposal.",
  "Mayor Zohran Mamdani announced an antisemitism strategy Tuesday, including funding increases from 3 to 29 million dollars annually, but did not adopt a formal definition of antisemitism or formally recognize Israel.",
  "Christa Pike survived two lethal injections in an attempted execution in Tennessee on Wednesday; authorities are investigating what went wrong.",
];

const req = (articleId: number, failedSummary: string, driver: Dimension | null = "headline") => ({
  articleId, title: "T", band: "Grounded", composite: 2.2, dimensionNotes: { language: "Plain." }, failedSummary,
  driver, drivers: "headline 2.6 pushed it up",
});

describe("isReason", () => {
  it("fails the three audit summaries", () => {
    for (const s of AUDIT_FAILURES) expect(isReason(s)).toBe(false);
  });
  it("passes real verdicts", () => {
    expect(isReason("An opinion column arguing that Attorney General Letitia James has shown partiality toward an accuser.")).toBe(true);
    expect(isReason("The piece frames the conflict through loaded adjectives and one-sided emphasis.")).toBe(true);
    expect(isReason("Straightforward wire-style reporting with attributed facts.")).toBe(true);
  });
  it("fails empty and missing summaries", () => {
    expect(isReason("")).toBe(false);
    expect(isReason(null)).toBe(false);
    expect(isReason(undefined)).toBe(false);
  });
});

describe("retryReasons", () => {
  beforeEach(() => { fail = false; });
  it("keeps a retry that passes and stores null for one that fails again", async () => {
    reply = { reasons: [
      { article_id: 1, summary: "A plain headline and attributed sourcing keep it Grounded." },
      { article_id: 2, summary: AUDIT_FAILURES[1] },
    ] };
    const out = await retryReasons([req(1, AUDIT_FAILURES[0]!), req(2, AUDIT_FAILURES[1]!), req(3, AUDIT_FAILURES[2]!)], { model: "m" });
    expect(out.get(1)).toBe("A plain headline and attributed sourcing keep it Grounded.");
    expect(out.get(2)).toBeNull();
    expect(out.get(3)).toBeNull(); // the model returned nothing for it
  });
  it("ignores an article id it never asked about", async () => {
    reply = { reasons: [{ article_id: 99, summary: "A loaded headline drove it." }] };
    const out = await retryReasons([req(1, AUDIT_FAILURES[0]!)], { model: "m" });
    expect([...out.keys()]).toEqual([1]);
    expect(out.get(1)).toBeNull();
  });
  it("stores null for every article when the call fails, and never throws", async () => {
    fail = true;
    const out = await retryReasons([req(1, AUDIT_FAILURES[0]!)], { model: "m" });
    expect(out.get(1)).toBeNull();
  });
});

// Plan step 1 (Max, 2026-10-02): the Why line names what set the number.
describe("the Why line names the score's biggest driver", () => {
  // Fox's Mamdani piece: effective sourcing 3.0 set the number.
  const fox = { headline: 2.6, language: 1.9, sourcing: 3, fallacies: 1.6, structure: 1.5 };
  it("finds the driver from the breakdown, heavier weight first on a tie", () => {
    expect(biggestDriver(fox)).toBe("sourcing");
    expect(biggestDriver({ headline: 3, sourcing: 3 })).toBe("headline");
    expect(biggestDriver(null)).toBeNull();
  });
  it("refuses a reason that talks about the wrong part of the writing", () => {
    expect(isDriverReason("A plain headline keeps it calm.", "sourcing")).toBe(false);
    expect(isDriverReason("Leans on one-sided sourcing: Mamdani's office is never quoted.", "sourcing")).toBe(true);
  });
  it("states the drivers in plain words", () => {
    expect(driversText(fox)).toBe("sourcing 3.0, headline 2.6 pushed it up; structure 1.5, fallacies 1.6, language 1.9 held it down");
  });
  it("keeps a retry only when it names the driver", async () => {
    fail = false;
    reply = { reasons: [
      { article_id: 1, summary: "A plain headline and neutral language." },
      { article_id: 2, summary: "Sources from one side only, with the mayor's office absent." },
    ] };
    const out = await retryReasons([req(1, "x", "sourcing"), req(2, "x", "sourcing")], { model: "m" });
    expect(out.get(1)).toBeNull();
    expect(out.get(2)).toBe("Sources from one side only, with the mayor's office absent.");
  });
});
