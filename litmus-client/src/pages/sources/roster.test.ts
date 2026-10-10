import { describe, expect, it } from "vitest";
import type { SourceDTO } from "../../lib/types.ts";
import { accessLabel, rosterCountLine, sourceTypeLabel, summarizeRoster } from "./roster.ts";

function src(id: number, lean: string, enabled = true): SourceDTO {
  return {
    id,
    name: `Outlet ${id}`,
    rssUrl: "",
    lean: lean as SourceDTO["lean"],
    type: "newspaper",
    paywallStatus: "free",
    reliability: 3,
    enabled,
  };
}

describe("summarizeRoster", () => {
  it("groups in baseline order and drops empty groups", () => {
    const r = summarizeRoster([src(1, "right"), src(2, "left"), src(3, "right")]);
    expect(r.groups.map((g) => g.key)).toEqual(["left", "right"]);
    expect(r.groups[1]?.items.map((s) => s.id)).toEqual([1, 3]);
  });

  it("keeps an off-list baseline under Unrated instead of losing it", () => {
    const r = summarizeRoster([src(1, "center"), src(2, "sideways")]);
    const counted = r.groups.reduce((n, g) => n + g.items.length, 0);
    expect(counted).toBe(r.total);
    expect(r.groups.at(-1)).toMatchObject({ key: "unrated", label: "Unrated" });
  });

  it("counts read and switched-off outlets", () => {
    const r = summarizeRoster([src(1, "center"), src(2, "center", false)]);
    expect(r).toMatchObject({ total: 2, read: 1, off: 1 });
    expect(rosterCountLine(r)).toBe("2 outlets in the roster, 1 currently read, 1 switched off.");
    expect(rosterCountLine({ total: 1, read: 1, off: 0 })).toBe("1 outlets in the roster, 1 currently read.");
  });

  it("handles an empty roster", () => {
    expect(summarizeRoster([])).toEqual({ groups: [], total: 0, read: 0, off: 0 });
  });
});

describe("labels", () => {
  it("names known values and passes unknown ones through", () => {
    expect(sourceTypeLabel("digital-native")).toBe("Digital native");
    expect(accessLabel("hard")).toBe("Hard paywall");
    expect(accessLabel("donation")).toBe("donation");
  });
});
