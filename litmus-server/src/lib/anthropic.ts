import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";
import { fakeAnthropic } from "./fakeAnthropic.js";
import { assertFakeModelIsIsolated } from "./isolation.js";

// Model routing — single source of truth. If the API names change, update here.
// Haiku: cheap, batched scoring during ingest.
// Sonnet: on-demand translation generation + clustering.
export const models = {
  scorer: "claude-haiku-4-5-20251001",
  // Haiku 4.5 everywhere (Max, 2026-10-02: "use haiku and jev, not sonnet").
  translator: "claude-haiku-4-5-20251001",
  clusterer: "claude-haiku-4-5-20251001",
  // Haiku 4.5 (Max, 2026-09-20): matched Sonnet 5's cohesion (66.7%) and
  // separation (100%, zero false merges) once sweep's story shard was sized
  // for its smaller context window (src/stories/sweep.ts), at real,
  // accurately-priced cost roughly a third of Sonnet's ($6.68 vs $24.41 on
  // the same 200-article archive, 2026-09-20).
  stories: "claude-haiku-4-5",
} as const;

// Singleton SDK client. Lazy-init so importing this module doesn't crash if
// ANTHROPIC_API_KEY is unset (e.g. during pure ingestion runs that never score).
let _client: Anthropic | null = null;
export function anthropic(): Anthropic {
  // The gate runs on every call, not once at import, so there is no ordering in
  // which a caller reaches fixtures without passing it.
  assertFakeModelIsIsolated();

  // Fixture mode for isolated runs. Returns canned tool responses and never
  // constructs the real SDK, so an isolated run cannot reach the network or
  // spend money even if a key happens to be in the environment.
  if (env.ANTHROPIC_FAKE) {
    return fakeAnthropic() as unknown as Anthropic;
  }
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set; required for scoring/translation/clustering");
  }
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}
