// TypeSafe's Jev, called through Cloudflare Workers AI's REST endpoint.
//
// Jev does not write text. It answers typed questions (yes/no, a choice, a
// score) with probabilities, which is why LITMUS uses it only to JUDGE
// (Max, 2026-09-27): Haiku still writes every word a reader sees.
//
// Isolated runs (ANTHROPIC_FAKE=1) must never reach the network, so this
// refuses to run there; callers fall back to the Haiku-only path.
import { env } from "./env.js";
import { logger } from "./logger.js";

export const JEV_MODEL = "typesafe/jev";
// Cloudflare's price for Jev: $0.042 per million input tokens; output is free.
export const JEV_INPUT_DOLLARS_PER_MILLION = 0.042;
const MAX_ATTEMPTS = 8;
// A 429 is the gateway's limit for the whole account, not one call: it pauses
// every Jev call in the process, so the other workers stop adding to it
// (2026-10-02: per-call backoff alone still lost one sweep call in ~900).
let pausedUntil = 0;
// Cloudflare's shared gateway answered 429 at five concurrent Jev calls
// (2026-09-27), and runBatches runs five batches of four at once, so every Jev
// call in the process queues through this limit.
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next(); else active--;
}

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface JevAnswer {
  type: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  inputTokens: number;
}

export function jevAvailable(): boolean {
  return !env.ANTHROPIC_FAKE && env.JEV_ACCOUNT_ID !== "" && env.JEV_API_TOKEN !== "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function askJev(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
  await acquire();
  try {
    return await askJevUnlimited(state, questions);
  } finally {
    release();
  }
}

async function askJevUnlimited(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
  if (env.ANTHROPIC_FAKE) throw new Error("Jev is disabled in isolated (ANTHROPIC_FAKE) runs");
  if (!jevAvailable()) throw new Error("Jev is not configured: set JEV_ACCOUNT_ID and JEV_API_TOKEN (or the CLOUDFLARE_ pair)");
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.JEV_ACCOUNT_ID}/ai/run`;
  const body = JSON.stringify({ model: JEV_MODEL, input: { state, questions } });
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) await sleep(wait);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${env.JEV_API_TOKEN}`, "Content-Type": "application/json" }, body });
    } catch (err) {
      // A dropped connection is transient.
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(Math.min(20_000, 500 * 2 ** attempt));
      continue;
    }
    const json = (await res.json().catch(() => null)) as { success?: boolean; errors?: unknown; result?: any } | null;
    if (res.ok && json?.success !== false) {
      // The REST envelope nests Jev's own result one level down.
      const result = json?.result?.result ?? json?.result ?? {};
      return { answers: result.answers ?? {}, inputTokens: result.usage?.input_tokens ?? 0 };
    }
    lastError = `HTTP ${res.status} ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`;
    // Only rate limits and server errors are worth waiting out; an auth or input error will not fix itself.
    if (res.status !== 429 && res.status < 500) break;
    const backoff = Math.min(20_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 500);
    if (res.status === 429) pausedUntil = Math.max(pausedUntil, Date.now() + backoff);
    await sleep(backoff);
  }
  logger.warn("jev call failed", { err: lastError });
  throw new Error(`Jev call failed: ${lastError}`);
}
