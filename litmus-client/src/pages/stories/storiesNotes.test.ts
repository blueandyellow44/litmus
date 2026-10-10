// The All Stories page's feedback copy: the grouped view's filter note, the
// mobile disclosure's result button, and the lean legend's parts.

import { describe, expect, it } from "vitest";
import { groupedFilterNote, leanSpreadParts, showResultsLabel } from "./clusterListLogic.ts";

describe("groupedFilterNote", () => {
  it("says nothing when no filter is active", () => {
    expect(groupedFilterNote(0)).toBeNull();
  });

  it("names the ignored filters, singular and plural", () => {
    expect(groupedFilterNote(1)).toBe("Grouped stories cover the whole edition. Your 1 filter still applies in Feed.");
    expect(groupedFilterNote(3)).toBe("Grouped stories cover the whole edition. Your 3 filters still apply in Feed.");
  });
});

describe("showResultsLabel", () => {
  it("reports the whole edition when nothing narrows it", () => {
    expect(showResultsLabel(200, false)).toBe("Show all 200 articles");
    expect(showResultsLabel(1, false)).toBe("Show all 1 article");
  });

  it("reports the matches when filtering", () => {
    expect(showResultsLabel(11, true)).toBe("Show 11 matching articles");
    expect(showResultsLabel(1, true)).toBe("Show 1 matching article");
    expect(showResultsLabel(0, true)).toBe("No articles match");
  });
});

describe("leanSpreadParts", () => {
  it("orders parts left to right and drops zero and unknown leans", () => {
    expect(leanSpreadParts({ right: 1, center: 5, left: 2, "center-left": 0, bogus: 9 })).toEqual([
      { lean: "left", label: "Left", count: 2 },
      { lean: "center", label: "Center", count: 5 },
      { lean: "right", label: "Right", count: 1 },
    ]);
  });

  it("is empty for an empty spread", () => {
    expect(leanSpreadParts({})).toEqual([]);
  });
});
