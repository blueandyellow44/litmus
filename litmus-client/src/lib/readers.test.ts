import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pacificMonday, weeklyEvents, countVisit, WEEK_KEY } from "./readers";
import { onRequestPost, COUNTED } from "../../functions/api/count";

describe("weekly readers", () => {
  it("turns the week at midnight Monday Pacific, across DST and the new year", () => {
    expect(pacificMonday(Date.parse("2026-10-26T06:30:00Z"))).toBe("2026-10-19");
    expect(pacificMonday(Date.parse("2026-10-26T07:30:00Z"))).toBe("2026-10-26");
    expect(pacificMonday(Date.parse("2026-11-02T07:59:00Z"))).toBe("2026-10-26");
    expect(pacificMonday(Date.parse("2026-11-02T08:01:00Z"))).toBe("2026-11-02");
    expect(pacificMonday(Date.parse("2027-01-01T20:00:00Z"))).toBe("2026-12-28");
  });

  it("counts a browser once a week, returning only after a counted last week", () => {
    const now = Date.parse("2026-10-21T20:00:00Z");
    expect(weeklyEvents(null, now).events).toEqual(["reader_week"]);
    expect(weeklyEvents("2026-10-19", now).events).toEqual([]);
    expect(weeklyEvents("2026-10-12", now).events).toEqual(["reader_week", "reader_returning"]);
    expect(weeklyEvents("2026-10-05", now).events).toEqual(["reader_week"]);
    expect(weeklyEvents("nonsense", now).events).toEqual(["reader_week"]);
  });

  describe("in the browser", () => {
    let sent: string[];
    let store: Map<string, string>;
    const storage = () => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    beforeEach(() => {
      sent = [];
      store = new Map();
      vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => { sent.push(JSON.parse(init.body).event); return new Response(null, { status: 204 }); }));
      vi.stubGlobal("window", { localStorage: storage() });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("keeps one date, sends event names only, and counts a letter landing", () => {
      store.set(WEEK_KEY, "2026-10-12");
      countVisit("/letter", Date.parse("2026-10-21T20:00:00Z"));
      countVisit("/", Date.parse("2026-10-22T20:00:00Z"));
      expect(sent).toEqual(["letter_visit", "reader_week", "reader_returning"]);
      expect([...store.entries()]).toEqual([[WEEK_KEY, "2026-10-19"]]);
    });

    it("counts nothing weekly when storage is blocked, and never throws", () => {
      vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
      expect(() => countVisit("/")).not.toThrow();
      expect(sent).toEqual([]);
    });
  });
});

describe("POST /api/count", () => {
  const rows = new Map<string, number>();
  const DB = { prepare: () => ({ bind: (day: string, event: string) => ({ run: async () => { rows.set(`${day}|${event}`, (rows.get(`${day}|${event}`) ?? 0) + 1); } }) }) };
  const req = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://litmustimes.com/api/count", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  beforeEach(() => rows.clear());

  it("adds listed events to the day and refuses anything else", async () => {
    for (const e of COUNTED) expect((await onRequestPost({ request: req({ event: e }), env: { DB } })).status).toBe(204);
    for (const bad of [{ event: "reader_id_1" }, { event: 3 }, {}, null]) {
      expect((await onRequestPost({ request: req(bad), env: { DB } })).status).toBe(400);
    }
    expect([...rows.keys()].map((k) => k.split("|")[1]).sort()).toEqual([...COUNTED].sort());
  });

  it("refuses another site's page and survives a missing database", async () => {
    expect((await onRequestPost({ request: req({ event: "reader_week" }, { origin: "https://elsewhere.example" }), env: { DB } })).status).toBe(403);
    expect(rows.size).toBe(0);
    expect((await onRequestPost({ request: req({ event: "reader_week" }), env: {} })).status).toBe(204);
  });
});
