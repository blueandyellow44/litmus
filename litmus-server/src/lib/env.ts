import "dotenv/config";
import { parseDailyCap } from "../api/translationGate.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  PORT: Number(process.env.PORT ?? 8787),
  LOG_LEVEL: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
  // Fixture model responses instead of paid API calls. See lib/fakeAnthropic.ts.
  // Never set this in CI or any run whose output is measured.
  ANTHROPIC_FAKE: (process.env.ANTHROPIC_FAKE ?? "").trim() === "1",
  // On-demand translation (POST /api/translations/:id) makes a paid model call
  // for whoever asks, so it is off unless switched on, and capped per day
  // when on (api/translationGate.ts). The published paper never uses it.
  ENABLE_ON_DEMAND_TRANSLATION: (process.env.ENABLE_ON_DEMAND_TRANSLATION ?? "").trim() === "1",
  TRANSLATION_DAILY_CAP: parseDailyCap(process.env.TRANSLATION_DAILY_CAP),
  // SCORE_LIMIT is deliberately NOT parsed here. Number() turns "" into 0 and
  // "5abc" into NaN, and a second lenient parser beside a strict one is how the
  // two drift apart. scoring/scoreLimit.ts owns it, and validates it as a cap.
  // Overrides models.stories for every Story Ledger model call in one run
  // (assignment, sweep, critic) - a model-comparison lever, never set in
  // production. Undefined when unset, so every existing call's own
  // `options.model ?? models.stories` default is unchanged.
  STORY_MODEL: process.env.STORY_MODEL || undefined,
  // The assessment's own model (2026-09-26): unset means the same as
  // STORY_MODEL / models.stories. Exists for the Haiku-vs-Sonnet 5 assessment
  // trial; grouping never reads it.
  ASSESSMENT_MODEL: process.env.ASSESSMENT_MODEL || undefined,
  // Rehearsal knobs for the fake client only (scripts/ledger-rehearsal.mjs);
  // ignored unless ANTHROPIC_FAKE=1. Parsed and validated in fakeAnthropic.ts.
  ANTHROPIC_FAKE_LATENCY_MS: process.env.ANTHROPIC_FAKE_LATENCY_MS,
  ANTHROPIC_FAKE_STORIES: process.env.ANTHROPIC_FAKE_STORIES,
  ANTHROPIC_FAKE_FAIL: process.env.ANTHROPIC_FAKE_FAIL,
  // Who judges the P/H numbers (Max, 2026-09-27, "yes build it"): "jev" makes
  // TypeSafe's Jev (Cloudflare Workers AI) judge the five dimensions, the flags
  // and the band while Haiku still writes every text field; "haiku" (the
  // default) is the scorer as it was. Anything else is a startup error, so a
  // typo cannot silently fall back.
  P_H_JUDGE: parseChoice("P_H_JUDGE", ["haiku", "jev"] as const, "haiku"),
  // Strip page furniture (captions, promos, bylines) with Jev before scoring
  // (same ruling). "off" by default; the raw text is never modified either way.
  FURNITURE_FILTER: parseChoice("FURNITURE_FILTER", ["off", "jev"] as const, "off"),
  // Who makes the Story Ledger's same-event decisions (Max, 2026-10-02, "Story
  // ledger grouping too"): "jev" has Jev decide attach / no match / merge while
  // Haiku still names new stories and reviews splits (stories/jevGrouping.ts).
  // "haiku" (the default) is the ledger as it was.
  STORY_JUDGE: parseChoice("STORY_JUDGE", ["haiku", "jev"] as const, "haiku"),
  // Jev runs on Cloudflare Workers AI. The dedicated names win; otherwise the
  // account and token the Pages deploy already uses are tried.
  JEV_ACCOUNT_ID: process.env.JEV_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || "",
  JEV_API_TOKEN: process.env.JEV_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "",
} as const;

function parseChoice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name} must be one of ${allowed.join(", ")}; got "${raw}"`);
}
