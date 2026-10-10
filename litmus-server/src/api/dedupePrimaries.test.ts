import { describe, expect, it } from "vitest";
import { dedupePrimaries } from "./dedupePrimaries.js";
import type { StoryMemberDTO } from "./storyTypes.js";

let id = 0;
const m = (over: Partial<StoryMemberDTO>): StoryMemberDTO => ({
  articleId: ++id, outletKey: "the-hill", outletName: "The Hill", sourceLean: "center", title: "t", url: "u",
  publishedAt: null, kind: "full", syndicatedOfArticleId: null, role: "primary", composite: 2,
  politicalLean: 0, howItWasTold: null, heat: null, excerpt: null, ...over,
});

describe("dedupePrimaries", () => {
  it("keeps one primary per outlet and marks the rest Also filed", () => {
    const out = dedupePrimaries([m({ composite: 2.0 }), m({ composite: 3.5 }), m({ outletKey: "pbs", composite: 1.8 }), m({ composite: null })]);
    expect(out.filter((x) => x.role === "primary").map((x) => x.outletKey)).toEqual(["the-hill", "pbs"]);
    expect(out.filter((x) => x.alsoFiled)).toHaveLength(2);
    // The kept filing is the first scored one, never the hottest.
    expect(out[0]!.role).toBe("primary");
    expect(out[1]!.alsoFiled).toBe(true);
  });
  it("prefers a scored filing over an earlier unscored one, and full text over a wire copy", () => {
    const out = dedupePrimaries([m({ composite: null }), m({ kind: "syndicated", composite: 2 }), m({ composite: 2.4 })]);
    expect(out.map((x) => x.role)).toEqual(["secondary", "secondary", "primary"]);
  });
  it("leaves roundups and headline-only members alone", () => {
    const out = dedupePrimaries([m({}), m({ role: "secondary" }), m({ kind: "headline_only", composite: null })]);
    expect(out[1]!.alsoFiled).toBeUndefined();
    expect(out[2]!.role).toBe("primary");
  });
});
