import { describe, expect, it } from "vitest";
import type { StoryModelClient } from "./assignment.js";
import { assessStory, assessmentOrder, exceedsLength, sentenceCount, type AssessmentMemberPayload } from "./assessment.js";
import type { StoryRecord } from "../db/repos/storiesRepo.js";
import { FatalModelError } from "./modelErrors.js";

function story(over: Partial<StoryRecord> = {}): StoryRecord {
  return {
    id: "st_test",
    slug: "test-story",
    section: "world",
    headline: "Actors do a thing",
    eventStatement: "Actors do a thing on one occasion.",
    assessment: null,
    membershipHash: null,
    touchesPolitics: null,
    firstSeenAt: new Date("2026-09-13T10:00:00Z"),
    updatedAt: new Date("2026-09-13T11:00:00Z"),
    status: "open",
    mergedInto: null,
    anchorArticleId: 1,
    ...over,
  };
}

function member(outlet: string, over: Partial<AssessmentMemberPayload> = {}): AssessmentMemberPayload {
  return {
    outlet,
    title: `${outlet} covers the story`,
    publishedAt: "2026-09-13T10:00:00Z",
    summary: `${outlet}'s neutral summary of what happened.`,
    excerptLead: `${outlet} reports on the event in its own words.`,
    ...over,
  };
}

function response(input: unknown, stopReason = "tool_use") {
  return {
    stop_reason: stopReason,
    usage: { input_tokens: 40, output_tokens: 20 },
    content: [{ type: "tool_use", name: "submit_story_assessment", input }],
  };
}

function fake(factory: (call: number) => unknown): StoryModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    messages: { create: async () => { calls += 1; return factory(calls); } },
  } as StoryModelClient & { calls: number };
}

const GOOD_INPUT = {
  headline: "Rogue agents warning spreads",
  event_statement: "Amodei publishes an essay warning about AI risk.",
  paragraphs: [
    "Anthropic's Dario Amodei published an essay warning that AI progress needs to slow down.",
    "Speaker Johnson said Congress will not lead on regulation and companies should police themselves.",
  ],
  touches_politics: true,
};

describe("assessStory", () => {
  it("accepts a well-formed assessment on the first attempt", async () => {
    const client = fake(() => response(GOOD_INPUT));
    const result = await assessStory(story(), [member("Axios"), member("CNBC")], { client });
    expect(result.assessment).toEqual({
      headline: GOOD_INPUT.headline,
      eventStatement: GOOD_INPUT.event_statement,
      paragraphs: GOOD_INPUT.paragraphs,
      touchesPolitics: true,
      text: GOOD_INPUT.paragraphs.join("\n\n"),
    });
    expect(result.openedWithOutlet).toBe(false);
    expect(result.flagReason).toBeNull();
  });

  it("retries once on a malformed response and then succeeds", async () => {
    const client = fake((call) => (call === 1 ? response({ headline: "" }) : response(GOOD_INPUT)));
    const result = await assessStory(story(), [member("Axios")], { client });
    expect(client.calls).toBe(2);
    expect(result.assessment?.headline).toBe(GOOD_INPUT.headline);
  });

  it("gives up after two malformed responses instead of crashing", async () => {
    const client = fake(() => response({ headline: "" }));
    const result = await assessStory(story(), [member("Axios")], { client });
    expect(client.calls).toBe(2);
    expect(result.assessment).toBeNull();
    expect(result.flagReason).toBeTruthy();
  });

  it("rejects too few or too many paragraphs", async () => {
    const oneParagraph = fake(() => response({ ...GOOD_INPUT, paragraphs: [GOOD_INPUT.paragraphs[0]] }));
    expect((await assessStory(story(), [member("Axios")], { client: oneParagraph })).assessment).toBeNull();

    const fourParagraphs = fake(() => response({ ...GOOD_INPUT, paragraphs: [...GOOD_INPUT.paragraphs, "Three.", "Four."] }));
    expect((await assessStory(story(), [member("Axios")], { client: fourParagraphs })).assessment).toBeNull();
  });

  it("retries once when the opening names an outlet, and accepts the corrected version", async () => {
    const outletLed = { ...GOOD_INPUT, paragraphs: ["Axios reported that Amodei is warning about AI risk.", GOOD_INPUT.paragraphs[1]] };
    const client = fake((call) => (call === 1 ? response(outletLed) : response(GOOD_INPUT)));
    const result = await assessStory(story(), [member("Axios"), member("CNBC")], { client });
    expect(client.calls).toBe(2);
    expect(result.assessment?.paragraphs[0]).toBe(GOOD_INPUT.paragraphs[0]);
    expect(result.openedWithOutlet).toBe(false);
  });

  it("persists an assessment that still opens with an outlet after one retry, but flags it", async () => {
    const outletLed = { ...GOOD_INPUT, paragraphs: ["Axios reported that Amodei is warning about AI risk.", GOOD_INPUT.paragraphs[1]] };
    const client = fake(() => response(outletLed));
    const result = await assessStory(story(), [member("Axios"), member("CNBC")], { client });
    expect(client.calls).toBe(2);
    expect(result.assessment).not.toBeNull();
    expect(result.openedWithOutlet).toBe(true);
  });

  it("treats a non-tool-use stop reason as malformed and retries", async () => {
    const client = fake((call) => (call === 1 ? response(null, "end_turn") : response(GOOD_INPUT)));
    const result = await assessStory(story(), [member("Axios")], { client });
    expect(client.calls).toBe(2);
    expect(result.assessment?.headline).toBe(GOOD_INPUT.headline);
  });
});

describe("assessStory in a real run (2026-09-26)", () => {
  it("ends the run on a locked account instead of failing one story at a time", async () => {
    const client = fake(() => {
      throw Object.assign(new Error("400 You have reached your specified API usage limits."), { status: 400 });
    });
    await expect(assessStory(story(), [member("BBC News"), member("NPR")], { client })).rejects.toThrow(FatalModelError);
    expect(client.calls).toBe(1);
  });

  it("gives each attempt its own call index so a retry never overwrites the first row", async () => {
    const indexes: number[] = [];
    const client = fake((call) => (call === 1 ? response({}) : response(GOOD_INPUT)));
    await assessStory(story(), [member("BBC News"), member("NPR")], {
      client,
      callIndex: 7,
      onUsage: (usage) => { indexes.push(usage.callIndex); },
    });
    expect(indexes).toEqual([7, 8]);
  });

  it("still treats an ordinary 529 as a story-level failure, not a stopped run", async () => {
    const client = fake(() => {
      throw Object.assign(new Error("529 overloaded_error"), { status: 529 });
    });
    const result = await assessStory(story(), [member("BBC News"), member("NPR")], { client });
    expect(result.assessment).toBeNull();
    expect(client.calls).toBe(2);
  });
});

describe("assessStory opening checks (2026-09-26 trial follow-through)", () => {
  const paragraphs = (first: string) => ({ ...GOOD_INPUT, paragraphs: [first, "A second paragraph of detail."] });

  it("retries when the opening says who reported the event, even for an outlet that is not a member", async () => {
    const client = fake((call) => response(paragraphs(call === 1
      ? "CNN reported that its journalists were left off the press pool."
      : "The White House barred CNN from the Air Force One press pool.")));
    const result = await assessStory(story(), [member("Newsweek"), member("The Hill")], { client });
    expect(client.calls).toBe(2);
    expect(result.assessment?.paragraphs[0]).toMatch(/^The White House barred CNN/);
    expect(result.openedWithOutlet).toBe(false);
  });

  it("retries on an 'According to' opening", async () => {
    const client = fake((call) => response(paragraphs(call === 1 ? "According to officials, the bill passed." : "The bill passed.")));
    await assessStory(story(), [member("Axios")], { client });
    expect(client.calls).toBe(2);
  });

  it("does not retry when a non-member outlet is the party to the act, not the teller", async () => {
    const client = fake(() => response(paragraphs("The White House barred CNN from the Air Force One press pool.")));
    const result = await assessStory(story(), [member("Newsweek")], { client });
    expect(client.calls).toBe(1);
    expect(result.openedWithOutlet).toBe(false);
  });

  it("hands every attempt's exact request to onRequest, retries included", async () => {
    const seen: Array<{ callIndex: number; content: string; system: string }> = [];
    const client = fake((call) => response(paragraphs(call === 1 ? "Axios reported the event." : "Actors did a thing.")));
    await assessStory(story(), [member("Axios")], {
      client,
      callIndex: 7,
      onRequest: (request) => { seen.push({ callIndex: request.callIndex, content: request.messages[0].content, system: request.system }); },
    });
    expect(seen.map((s) => s.callIndex)).toEqual([7, 8]);
    expect(seen[0]!.content.startsWith("{")).toBe(true);
    expect(seen[1]!.content).toMatch(/^Correction: /);
    expect(seen[0]!.system).toContain("The event leads.");
  });
});

describe("assessment ceilings and scope (2026-09-26)", () => {
  it("counts sentences, including ones ending in a quotation", () => {
    expect(sentenceCount("One. Two! Three? “Four.”")).toBe(4);
    expect(sentenceCount("No terminal punctuation")).toBe(1);
  });

  it("does not count abbreviation or initial periods as sentence ends", () => {
    expect(sentenceCount("The U.S. and Mr. Smith met on Sept. 5. They agreed.")).toBe(2);
    expect(sentenceCount("Gov. Kehoe signed it. J. D. Vance praised it. The vote was 3.5 points.")).toBe(3);
    expect(sentenceCount("It happened in the U.S.")).toBe(1);
    // Known limit: an acronym that ends one sentence reads like "U.S. Senate"
    // inside one, so this undercounts (1, not 2). It errs toward keeping a
    // paragraph; the prompt still states the four-sentence ceiling.
    expect(sentenceCount("Troops left the U.S. The talks resumed.")).toBe(1);
    expect(sentenceCount("One. Two. Three. Four. Five.")).toBe(5);
  });

  it("keeps a real four-sentence politics paragraph", async () => {
    const para = "The U.S. Senate voted Tuesday. Sen. Smith of N.Y. led the effort. The bill now goes to the House. Gov. Hochul said she would sign it.";
    const client = fake(() => response({ ...GOOD_INPUT, paragraphs: [para, "Short one."] }));
    const result = await assessStory(story(), [member("BBC News"), member("NPR")], { client });
    expect(result.assessment?.paragraphs[0]).toBe(para);
  });

  it("retries a paragraph over four sentences and never keeps it", async () => {
    const long = "One. Two. Three. Four. Five.";
    const client = fake(() => response({ ...GOOD_INPUT, paragraphs: [long, "Short one."] }));
    const result = await assessStory(story(), [member("BBC News"), member("NPR")], { client });
    expect(result.assessment).toBeNull();
    expect(client.calls).toBe(2);
  });

  it("requires the touches_politics answer and returns it", async () => {
    const { touches_politics: _omit, ...withoutScope } = GOOD_INPUT;
    const missing = fake(() => response(withoutScope));
    expect((await assessStory(story(), [member("BBC News"), member("NPR")], { client: missing })).assessment).toBeNull();
    const sports = fake(() => response({ ...GOOD_INPUT, touches_politics: false }));
    expect((await assessStory(story(), [member("BBC News"), member("NPR")], { client: sports })).assessment?.touchesPolitics).toBe(false);
  });
});

describe("assessment refusal reasons", () => {
  it("names the rule that refused an answer", async () => {
    const client = fake(() => response({ ...GOOD_INPUT, paragraphs: ["One. Two. Three. Four. Five.", "Short."] }));
    const result = await assessStory(story(), [member("BBC News"), member("NPR")], { client });
    expect(result.flagReason).toMatch(/sentences per paragraph 5\/1, max 4/);
  });
});

describe("house length: eight sentences in all (2026-09-26)", () => {
  it("refuses nine sentences even when every paragraph is within four", async () => {
    const client = fake(() => response({ ...GOOD_INPUT, paragraphs: ["One ran. Two ran. Three ran.", "Four ran. Five ran. Six ran.", "Seven ran. Eight ran. Nine ran."] }));
    const result = await assessStory(story(), [member("BBC News"), member("NPR")], { client });
    expect(result.assessment).toBeNull();
    expect(result.flagReason).toMatch(/sentences in all 9, max 8/);
  });
  it("keeps eight", async () => {
    const client = fake(() => response({ ...GOOD_INPUT, paragraphs: ["One ran. Two ran. Three ran.", "Four ran. Five ran. Six ran.", "Seven ran. Eight ran."] }));
    expect((await assessStory(story(), [member("BBC News"), member("NPR")], { client })).assessment).not.toBeNull();
  });
  it("marks a stored twelve-sentence summary for rewriting", () => {
    expect(exceedsLength("One ran. Two ran. Three ran. Four ran.\n\nFive ran. Six ran. Seven ran. Eight ran.\n\nNine ran. Ten ran. Eleven ran. Twelve ran.")).toBe(true);
    expect(exceedsLength("One ran. Two ran. Three ran.\n\nFour ran. Five ran.")).toBe(false);
  });
});

describe("assessmentOrder (2026-09-27: today's stories were starved)", () => {
  const at = (d: string) => new Date(d);
  const written = { text: "x", model: "m", generatedAt: at("2026-09-26T00:00:00Z") };
  it("writes up never-assessed stories first, newest first, ahead of bigger backlog stories", () => {
    const today = { id: "a", assessment: null, touchesPolitics: null, firstSeenAt: at("2026-09-27T15:00:00Z") };
    const earlierToday = { id: "b", assessment: null, touchesPolitics: null, firstSeenAt: at("2026-09-27T09:00:00Z") };
    const backlogUnjudged = { id: "c", assessment: written, touchesPolitics: null, firstSeenAt: at("2026-09-26T09:00:00Z") };
    const rewrite = { id: "d", assessment: written, touchesPolitics: true, firstSeenAt: at("2026-09-25T09:00:00Z") };
    const items = [
      { s: rewrite, n: 20 }, { s: backlogUnjudged, n: 16 }, { s: earlierToday, n: 2 }, { s: today, n: 3 },
    ];
    items.sort((x, y) => assessmentOrder(x.s, x.n, y.s, y.n));
    expect(items.map((i) => i.s.id)).toEqual(["a", "b", "c", "d"]);
  });
});
