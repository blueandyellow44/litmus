// The one server endpoint on litmustimes.com (2026-10-21): add one to a day's
// total for a listed event. No id, no address, no time of day is kept.
// Binding: D1 database as DB (Pages project "litmus", production).

interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
}
interface Env { DB?: D1Like }

export const COUNTED = new Set(["reader_week", "reader_returning", "letter_visit"]);

export function pacificDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { event?: unknown } | null;
  const event = typeof body?.event === "string" ? body.event : "";
  if (!COUNTED.has(event)) return Response.json({ error: "Unknown event." }, { status: 400 });
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return Response.json({ error: "Not from here." }, { status: 403 });
  if (!env.DB) {
    console.warn("count: no DB binding; nothing counted");
    return new Response(null, { status: 204 });
  }
  try {
    await env.DB.prepare(
      "INSERT INTO counts (day, event, n) VALUES (?1, ?2, 1) ON CONFLICT(day, event) DO UPDATE SET n = n + 1",
    ).bind(pacificDay(Date.now()), event).run();
  } catch (e) {
    console.warn(`count: could not count ${event}`, e);
  }
  return new Response(null, { status: 204 });
}
