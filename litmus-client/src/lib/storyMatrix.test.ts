import { describe, expect, it } from "vitest";
import {
  MATRIX_PRESETS,
  drawOrder,
  hollowLane,
  axisWordBoxes,
  labelBox,
  fitMatrix,
  layoutLabels,
  unlabelledPoints,
  matrixDescription,
  matrixHeight,
  matrixPoints,
  plotHeight,
  presetFor,
  xForLean,
  yForComposite,
} from "./storyMatrix.ts";
import { headlineOnly, member } from "./storyTestData.ts";

const P = MATRIX_PRESETS.storyDesktop;

describe("scales", () => {
  it("are fixed to the whole domain and never zoom to the data", () => {
    expect(xForLean(-100, P)).toBe(P.m.l);
    expect(xForLean(100, P)).toBe(P.w - P.m.r);
    expect(xForLean(0, P)).toBe(P.m.l + (P.w - P.m.l - P.m.r) / 2);
    expect(yForComposite(5, P)).toBe(P.m.t);
    expect(yForComposite(1, P)).toBe(P.m.t + plotHeight(P));
    // Hotter is higher: a smaller y.
    expect(yForComposite(4, P)).toBeLessThan(yForComposite(2, P));
  });
  it("clamps corrupt values to the edge rather than drawing off the chart", () => {
    expect(xForLean(500, P)).toBe(xForLean(100, P));
    expect(yForComposite(0, P)).toBe(yForComposite(1, P));
  });
  it("shortens the front matrix for three members or fewer", () => {
    expect(presetFor("front", 3).h).toBe(210);
    expect(presetFor("front", 4).h).toBe(MATRIX_PRESETS.front.h);
    expect(presetFor("storyDesktop", 1).h).toBe(P.h);
  });
});

describe("matrixPoints", () => {
  it("plots only primary scored members with a lean, and colours by band", () => {
    const pts = matrixPoints(
      [
        member({ composite: 1.2, politicalLean: -80 }),
        member({ composite: 4.6, politicalLean: 80 }),
        headlineOnly(),
        member({ composite: null }),
        member({ politicalLean: null }),
        member({ role: "secondary" }),
        member({ kind: "syndicated", syndicatedOfArticleId: 1, composite: 2, politicalLean: 0 }),
      ],
      P,
    );
    expect(pts).toHaveLength(3);
    expect(pts[0]?.hex.toLowerCase()).toBe("#c0c9ce");
    expect(pts[1]?.hex.toLowerCase()).toBe("#ad3118");
    expect(pts[2]?.extra).toBe("wire copy");
    expect(pts[0]?.scoreLine).toBe("1.2 Proportionate");
    expect(pts[0]?.title).toBe(`${pts[0]?.name} 1.2 Proportionate`);
  });
  it("draws calm dots first so hot ones sit on top", () => {
    const pts = matrixPoints([member({ composite: 4 }), member({ composite: 1.5 }), member({ composite: 2.6 })], P);
    expect(drawOrder(pts).map((p) => p.composite)).toEqual([1.5, 2.6, 4]);
  });
});

describe("layoutLabels", () => {
  const stacked = [
    member({ outletName: "Politico", composite: 2, politicalLean: -12 }),
    member({ outletName: "CNBC", composite: 2.05, politicalLean: -10 }),
    member({ outletName: "Axios", composite: 2.1, politicalLean: -8 }),
    member({ outletName: "The Atlantic", composite: 2.3, politicalLean: 6 }),
    member({ outletName: "BBC News", composite: 2.4, politicalLean: 8 }),
  ];

  it("spreads a clump so labels never overlap, and keeps them inside the plot", () => {
    const labels = layoutLabels(matrixPoints(stacked, P), P);
    // CNBC (2.05) and Axios (2.1) overlap and both read "2.1 Grounded", so they
    // share one label; all five dots are named.
    expect(labels.flatMap((l) => l.ids)).toHaveLength(5);
    expect(labels).toHaveLength(4);
    const bySide = new Map<string, number[]>();
    for (const l of labels) bySide.set(l.anchor, [...(bySide.get(l.anchor) ?? []), l.y]);
    for (const ys of bySide.values()) {
      const sorted = [...ys].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(P.labelGap);
    }
    for (const l of labels) {
      expect(labelBox(l).y0).toBeGreaterThanOrEqual(P.m.t - 6);
      expect(l.y).toBeLessThanOrEqual(P.m.t + plotHeight(P));
    }
  });

  it("splits the dots into a left half and a right half with opposite anchors", () => {
    const labels = layoutLabels(matrixPoints(stacked, P), P);
    expect(labels.filter((l) => l.anchor === "end").flatMap((l) => l.ids)).toHaveLength(3);
    expect(labels.filter((l) => l.anchor === "start").flatMap((l) => l.ids)).toHaveLength(2);
  });

  it("puts a lone label to the right, and flips it when it would run off the plot", () => {
    const centre = layoutLabels(matrixPoints([member({ politicalLean: 0 })], P), P);
    expect(centre[0]?.anchor).toBe("start");
    const farRight = layoutLabels(matrixPoints([member({ outletName: "A Very Long Outlet Name Indeed", politicalLean: 100 })], P), P);
    expect(farRight[0]?.anchor).toBe("end");
    expect(farRight[0]?.x).toBeLessThan(xForLean(100, P));
  });

  it("joins every label to its own dot with a leader", () => {
    const pts = matrixPoints(stacked, P);
    const labels = layoutLabels(pts, P);
    for (const l of labels) {
      // A shared label's leader starts from the middle of its dots.
      const own = pts.filter((p) => l.ids.includes(p.id));
      expect(l.leader.y1).toBeCloseTo(own.reduce((t, p) => t + p.y, 0) / own.length);
      expect(l.leader.y2).toBe(l.y);
    }
  });

  it("returns nothing for nothing", () => {
    expect(layoutLabels([], P)).toEqual([]);
  });

  it("gives dots drawn on top of each other one label only when their scores read the same", () => {
    const same = layoutLabels(matrixPoints([member({ outletName: "The Guardian", composite: 1.2, politicalLean: 0 }), member({ outletName: "PBS NewsHour", composite: 1.2, politicalLean: 0 })], P), P);
    expect(same).toHaveLength(1);
    expect(same[0]!.rows[0]!.text).toBe("The Guardian, PBS NewsHour");
    expect(same[0]!.rows[1]!.text).toBe("1.2 Proportionate");
    const differ = layoutLabels(matrixPoints([member({ composite: 1.2, politicalLean: 0 }), member({ composite: 1.3, politicalLean: 0 })], P), P);
    expect(differ).toHaveLength(2);
  });
});

describe("hollowLane", () => {
  it("is absent when every member was read", () => {
    expect(hollowLane([member(), member()], P)).toBeNull();
    expect(matrixHeight(P, 0)).toBe(P.h);
  });
  it("spaces hollow dots across the plot, labelled when the names fit", () => {
    const lane = hollowLane([member(), headlineOnly({ outletName: "WSJ" }), headlineOnly({ outletName: "NYT — US" })], P);
    expect(lane).not.toBeNull();
    expect(lane!.dots.map((d) => d.name)).toEqual(["WSJ", "NYT"]);
    expect(lane!.labelled).toBe(true);
    expect(lane!.dots[0]!.x).toBeLessThan(lane!.dots[1]!.x);
    expect(lane!.y).toBeGreaterThan(P.h);
    expect(matrixHeight(P, 2)).toBe(P.h + P.laneHeight);
  });
  it("falls back to a summary line when the names would collide, and still names every outlet", () => {
    const many = Array.from({ length: 12 }, (_, i) => headlineOnly({ outletName: `Very Long Outlet Name ${i}` }));
    const lane = hollowLane(many, MATRIX_PRESETS.front)!;
    expect(lane.labelled).toBe(false);
    expect(lane.dots).toHaveLength(12);
    for (const m of many) expect(lane.summary).toContain(m.outletName);
    expect(lane.summary.startsWith("12 headline only: ")).toBe(true);
  });
});

describe("matrixDescription", () => {
  it("lists every plotted, hollow and pending member for a screen reader", () => {
    const d = matrixDescription([
      member({ outletName: "Politico", composite: 2, politicalLean: -12 }),
      headlineOnly({ outletName: "WSJ" }),
      member({ outletName: "Slow", composite: null }),
    ]);
    expect(d).toContain("Politico: P/H 2.0 Grounded, lean -12");
    // Headline-only reports are left out of the site (2026-09-26).
    expect(d).not.toContain("WSJ");
    expect(d).toContain("Not yet scored: Slow");
  });
});

// 2026-09-26: Max's phone showed labels running into the axis words and off the
// right edge; 25 of 102 front-matrix labels in the live edition were outside
// the plot.
describe("labels on a phone-width matrix", () => {
  const crowd = [
    member({ outletName: "PBS NewsHour", composite: 1.2, politicalLean: -60 }),
    member({ outletName: "Slate", composite: 3.6, politicalLean: -70 }),
    member({ outletName: "American Greatness", composite: 1.8, politicalLean: 5 }),
    member({ outletName: "Washington Examiner", composite: 2.2, politicalLean: 95 }),
    member({ outletName: "Newsweek", composite: 2.0, politicalLean: -95 }),
    member({ outletName: "Breitbart", composite: 2.1, politicalLean: 80 }),
  ];
  const pts = matrixPoints(crowd, presetFor("front", crowd.length));
  const p = presetFor("front", crowd.length);
  const labels = layoutLabels(pts, p);
  const box = labelBox;

  // Since 2026-10-09 a label may use the left margin between the band words,
  // never the words themselves.
  it("keeps every label inside the chart and clear of the axis words on the left", () => {
    for (const l of labels) {
      const b = box(l);
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(p.w - p.m.r);
      for (const a of axisWordBoxes(p)) expect(b.x0 < a.x1 && a.x0 < b.x1 && b.y0 < a.y1 && a.y0 < b.y1).toBe(false);
    }
  });

  it("never overlaps another label or covers a dot", () => {
    const boxes = labels.map(box);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
      }
      for (const d of pts) {
        const b = boxes[i]!;
        expect(d.x + p.r > b.x0 && d.x - p.r < b.x1 && d.y + p.r > b.y0 && d.y - p.r < b.y1).toBe(false);
      }
    }
  });

  it("names every dot: labelled in the chart or listed under it", () => {
    expect(labels.length + unlabelledPoints(pts, labels).length).toBe(pts.length);
  });
});

// 2026-10-09, Max's phone: Daily Wire, NPR and BBC News at 1.6 labelled, but
// Breitbart, near the centre at 2.8, went to "Also on the chart: ..." because a
// centre dot has no room beside it on a 343px chart. "They all need to be
// labeled in matrix."
describe("fitMatrix labels every dot", () => {
  const fourOutlets = [
    member({ outletName: "Daily Wire", composite: 1.6, politicalLean: -3 }),
    member({ outletName: "NPR", composite: 1.6, politicalLean: -12 }),
    member({ outletName: "BBC News", composite: 1.6, politicalLean: 1 }),
    member({ outletName: "Breitbart", composite: 2.8, politicalLean: 5 }),
  ];

  it("labels the centre dot from the screenshot", () => {
    const { points, labels } = fitMatrix(fourOutlets, "front");
    expect(unlabelledPoints(points, labels)).toEqual([]);
    expect(labels.flatMap((l) => l.rows.map((r) => r.text))).toContain("Breitbart");
  });

  it("labels a tight crowd of twelve at one spot, growing the chart if it must", () => {
    const crowd = Array.from({ length: 12 }, (_, i) =>
      member({ outletName: `Outlet Number ${i}`, composite: 2 + (i % 3) * 0.05, politicalLean: (i % 4) - 2 }),
    );
    const { p, points, labels } = fitMatrix(crowd, "front");
    expect(unlabelledPoints(points, labels)).toEqual([]);
    const boxes = labels.map(labelBox);
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(p.w - p.m.r);
      expect(b.y1).toBeLessThanOrEqual(p.m.t + plotHeight(p));
      for (const d of points) expect(d.x + p.r > b.x0 && d.x - p.r < b.x1 && d.y + p.r > b.y0 && d.y - p.r < b.y1).toBe(false);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(false);
    }
  });

  it("keeps the approved height when everything already fits", () => {
    expect(fitMatrix([member({ politicalLean: -50 })], "front").p.h).toBe(presetFor("front", 1).h);
  });
});

describe("hollow lane with an outlet that filed twice", () => {
  it("shows one dot per outlet and counts the repeat", () => {
    const lane = hollowLane([headlineOnly({ outletName: "New York Times" }), headlineOnly({ outletName: "New York Times — Politics" }), headlineOnly({ outletName: "WSJ" })], P)!;
    expect(lane.dots.map((d) => d.name)).toEqual(["New York Times ×2", "WSJ"]);
  });
});
