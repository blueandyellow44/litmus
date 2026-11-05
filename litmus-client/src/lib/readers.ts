// Weekly readers (Max, 2026-10-21, for the speedrun application: "litmus and
// wally walks"). The GTM's "weekly returning readers" line had no instrument:
// Web Analytics is cookieless and cannot tell a returning reader from a new one.
//
// This browser remembers one date, the Monday (Pacific) it was last counted.
// The date never leaves the device. The first visit in a new week adds one to
// "reader_week", and to "reader_returning" when last week was counted too. A
// visit that lands on /letter adds one to "letter_visit". The server keeps a
// day, an event name and a number; it never learns who.
import { LETTER_LANDING_PATH } from "./letter";

export const WEEK_KEY = "litmus.countedWeek";
const ZONE = "America/Los_Angeles";
const DAY_MS = 86_400_000;

export type Counted = "reader_week" | "reader_returning" | "letter_visit";

export function pacificMonday(ms: number): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  const noonUtc = Date.parse(`${date}T12:00:00Z`);
  const sinceMonday = (new Date(noonUtc).getUTCDay() + 6) % 7;
  return new Date(noonUtc - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

export function weeklyEvents(remembered: string | null, nowMs: number): { monday: string; events: Counted[] } {
  const monday = pacificMonday(nowMs);
  if (remembered === monday) return { monday, events: [] };
  const lastMonday = pacificMonday(Date.parse(`${monday}T12:00:00Z`) - 7 * DAY_MS);
  return { monday, events: remembered === lastMonday ? ["reader_week", "reader_returning"] : ["reader_week"] };
}

function send(event: Counted): void {
  try {
    void fetch("/api/count", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Counting never gets in the way of reading.
  }
}

/** Count this visit: once a week per browser, plus a letter landing. Never throws. */
export function countVisit(pathname: string, nowMs: number = Date.now()): void {
  if (pathname === LETTER_LANDING_PATH) send("letter_visit");
  try {
    const { monday, events } = weeklyEvents(window.localStorage.getItem(WEEK_KEY), nowMs);
    if (events.length === 0) return;
    window.localStorage.setItem(WEEK_KEY, monday);
    events.forEach(send);
  } catch {
    // Blocked storage: this browser is not counted, rather than counted every visit.
  }
}
