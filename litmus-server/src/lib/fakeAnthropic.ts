// Fixture model client for isolated runs (ANTHROPIC_FAKE=1).
//
// It answers every tool call the funnel makes with a well-formed response of
// the right shape, so refresh.sh can run end to end for $0. The shapes are
// deliberately minimal-but-valid: the point is to exercise plumbing, ordering,
// and persistence, never to stand in for a judgement. Nothing it returns is a
// score, and no calibration number may ever be measured from a fake run.
//
// callCount is what the isolation test asserts against the real SDK: a fake run
// that reached the network would show up as a real client being constructed.

import { env } from "./env.js";
import { logger } from "./logger.js";

export interface FakeCall {
  tool: string;
  model: string;
}

const calls: FakeCall[] = [];
export function fakeCalls(): readonly FakeCall[] {
  return calls;
}

interface CreateParams {
  model: string;
  tools?: Array<{ name: string }>;
  tool_choice?: { type: string; name?: string };
  messages: Array<{ role: string; content: string }>;
  system?: string;
  max_tokens: number;
}

function toolResponse(name: string, input: unknown, model: string) {
  return {
    id: `msg_fake_${calls.length}`,
    type: "message" as const,
    role: "assistant" as const,
    model,
    // stop_reason "tool_use" is the healthy path; the truncation guards the
    // real callers have must never be triggered by a fixture.
    stop_reason: "tool_use" as const,
    stop_sequence: null,
    content: [{ type: "tool_use" as const, id: `toolu_fake_${calls.length}`, name, input }],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// The ids the caller asked about, recovered from the user message so the
// fixture honours the one contract that matters: ids in, same ids out.
//
// The two callers name the field differently — the scorer serialises
// "article_id", the clusterer serialises "id" — and a fixture that only knew
// the scorer's spelling silently returned zero clusters, which looked exactly
// like a model declining to cluster anything.
function idsFrom(content: string, key: string): number[] {
  const ids: number[] = [];
  const re = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) ids.push(Number(m[1]));
  return ids;
}

function fakeScores(content: string, model: string) {
  const ids = idsFrom(content, "article_id");
  return toolResponse(
    "submit_scores",
    {
      scores: ids.map((id) => ({
        article_id: id,
        headline: 2.0,
        language: 2.0,
        sourcing: 2.0,
        fallacies: 1.0,
        structure: 2.0,
        band: "Grounded",
        flags: {
          emotional_lede: false,
          loaded_headline: false,
          fallacy_count: 0,
          one_sided_sourcing: false,
          opinion_column: false,
          register: "news",
        },
        rationale: {
          headline: "fixture",
          language: "fixture",
          sourcing: "fixture",
          fallacies: "fixture",
          structure: "fixture",
          summary: "Fixture score from an isolated run. Not a judgement.",
        },
        markers: [],
        excerpt_paragraphs: [0],
        political_lean: 0,
        article_summary: "Fixture summary produced by an isolated run.",
        section: "politics",
        // Required since the non-article gate (scoring/contentType.ts). Without
        // it every fixture score is refused, nothing publishes, and the
        // isolation proof fails for a reason unrelated to isolation.
        content_type: "article",
      })),
    },
    model,
  );
}

// Two clusters of two, drawn from the ids actually offered, so the cluster
// parser, the freshness filter and replaceAllClusters all get exercised.
function fakeClusters(content: string, model: string) {
  const ids = idsFrom(content, "id");
  const clusters: Array<{ topic: string; summary: string; article_ids: number[] }> = [];
  for (let i = 0; i + 1 < Math.min(ids.length, 4); i += 2) {
    clusters.push({
      topic: `Fixture story ${clusters.length + 1}`,
      summary: "Fixture cluster from an isolated run.",
      article_ids: [ids[i]!, ids[i + 1]!],
    });
  }
  return toolResponse("submit_clusters", { clusters }, model);
}

// Rehearsal realism (scripts/ledger-rehearsal.mjs, 2026-09-22). Both opt-in,
// so every existing fixture run behaves exactly as before.
//
// ANTHROPIC_FAKE_LATENCY_MS: every call waits this long before answering, so a
// rehearsal's wall clock reflects how many calls run one after another. With
// no delay a 2,000-call serial phase finishes in under a second and a timeout
// can never show up.
//
// ANTHROPIC_FAKE_STORIES=per-article: assignment opens one new story per
// article, headlined with that article's real title. The default pairs
// articles under "Fixture event N" headlines, and because every one of those
// shares the capitalised word "Fixture", the critic's proper-noun merge
// filter pairs every story with every other one: a count no real edition
// produces. Real titles make the merge-candidate count realistic.
function fakeLatencyMs(): number {
  const raw = (env.ANTHROPIC_FAKE_LATENCY_MS ?? "").trim();
  if (raw === "") return 0;
  if (!/^\d+$/.test(raw)) throw new Error(`ANTHROPIC_FAKE_LATENCY_MS must be a whole number of ms; got "${raw}"`);
  return Number(raw);
}

// ANTHROPIC_FAKE_FAIL=usage-limit: every call fails the way the real API did
// from 2026-09-21 on, with the same status and message, so the funnel's
// behaviour under an account lockout can be rehearsed without one.
const USAGE_LIMIT_MESSAGE =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}';

function fakeFailure(): Error | null {
  const raw = (env.ANTHROPIC_FAKE_FAIL ?? "").trim();
  if (raw === "") return null;
  if (raw === "usage-limit") return Object.assign(new Error(USAGE_LIMIT_MESSAGE), { status: 400 });
  throw new Error(`ANTHROPIC_FAKE_FAIL must be "usage-limit"; got "${raw}"`);
}

function fakeStoriesMode(): "pairs" | "per-article" {
  const raw = (env.ANTHROPIC_FAKE_STORIES ?? "").trim();
  if (raw === "" || raw === "pairs") return "pairs";
  if (raw === "per-article") return raw;
  throw new Error(`ANTHROPIC_FAKE_STORIES must be "pairs" or "per-article"; got "${raw}"`);
}

function batchArticles(content: string): Array<{ id: number; title: string }> {
  const json = content.slice(content.indexOf("{"));
  const body = JSON.parse(json) as { articles?: Array<{ article_id?: unknown; title?: unknown }> };
  return (body.articles ?? [])
    .filter((a): a is { article_id: number; title: string } => typeof a.article_id === "number" && typeof a.title === "string")
    .map((a) => ({ id: a.article_id, title: a.title }));
}

function fakeStoryAssignmentsPerArticle(content: string, model: string) {
  return toolResponse(
    "submit_story_decisions",
    {
      decisions: batchArticles(content).map((article) => ({
        article_id: article.id,
        action: "new",
        new_story_key: `rehearsal-${article.id}`,
        headline: article.title,
        event_statement: article.title,
        confidence: "high",
        reason: "Rehearsal: one story per article, headlined with its real title.",
      })),
    },
    model,
  );
}

function fakeStoryAssignments(content: string, model: string) {
  if (fakeStoriesMode() === "per-article") return fakeStoryAssignmentsPerArticle(content, model);
  const ids = [...new Set(idsFrom(content, "article_id"))];
  return toolResponse(
    "submit_story_decisions",
    {
      decisions: ids.map((id, index) => ({
        article_id: id,
        action: "new",
        new_story_key: `fixture-event-${Math.floor(index / 2) + 1}`,
        headline: `Fixture event ${Math.floor(index / 2) + 1}`,
        event_statement: `Fixture actors report event ${Math.floor(index / 2) + 1} on this occasion.`,
        confidence: "high",
        reason: "Fixture same-event decision.",
      })),
    },
    model,
  );
}

function fakeSweep(content: string, model: string) {
  const ids = [...new Set(idsFrom(content, "article_id"))];
  return toolResponse(
    "submit_sweep_results",
    {
      results: ids.map((id) => ({
        article_id: id,
        action: "none",
        reason: "Fixture found no older same event.",
      })),
    },
    model,
  );
}

function fakeSplit(content: string, model: string) {
  const ids = [...new Set(idsFrom(content, "article_id"))];
  return toolResponse(
    "submit_split_review",
    {
      groups: [{
        headline: "fixture event",
        event_statement: "fixture actors report one event on one occasion.",
        article_ids: ids,
      }],
      reason: "Fixture keeps one event together.",
    },
    model,
  );
}

function fakeStoryAssessment(model: string) {
  return toolResponse(
    "submit_story_assessment",
    {
      headline: "Fixture event happens",
      event_statement: "Fixture actors take one action on one occasion.",
      touches_politics: true,
      paragraphs: [
        "Fixture actors did a fixture thing for a fixture reason, according to the members offered to this story.",
        "The story continues with a second fixture paragraph, giving a little more of the who, when, and where.",
      ],
    },
    model,
  );
}

export function fakeAnthropic() {
  return {
    messages: {
      async create(params: CreateParams) {
        const tool = params.tool_choice?.name ?? params.tools?.[0]?.name ?? "unknown";
        calls.push({ tool, model: params.model });
        const content = params.messages.map((m) => m.content).join("\n");
        logger.info("fake model call", { tool, model: params.model, call: calls.length });
        const latencyMs = fakeLatencyMs();
        if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
        const failure = fakeFailure();
        if (failure) throw failure;

        switch (tool) {
          case "submit_scores":
            return fakeScores(content, params.model);
          case "submit_clusters":
            return fakeClusters(content, params.model);
          case "submit_story_decisions":
            return fakeStoryAssignments(content, params.model);
          case "submit_sweep_results":
            return fakeSweep(content, params.model);
          case "submit_split_review":
            return fakeSplit(content, params.model);
          case "submit_story_assessment":
            return fakeStoryAssessment(params.model);
          case "submit_merge_review":
            return toolResponse(
          "submit_merge_review",
              { decision: "no", reason: "fixture keeps distinct story ids." },
              params.model,
            );
          case "submit_markers":
            return toolResponse("submit_markers", { markers: [] }, params.model);
          case "submit_translation":
            return toolResponse(
              "submit_translation",
              { headline: "Fixture", body: "Fixture translation from an isolated run.", removed: [] },
              params.model,
            );
          default:
           throw new Error(`fake anthropic: no fixture for tool "${tool}"`);
        }
      },
    },
  };
}
