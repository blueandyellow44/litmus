// Parsing the model's output in a way that can say NO.
//
// The previous shape of this code was a family of `sanitize*` functions, and the
// name was the problem. Sanitising means taking whatever arrived and returning
// something usable, which for a scoring pipeline means inventing the parts that
// did not arrive. The reasoning written above the old `sanitizeFlags` was that a
// missing flag should "resolve to the SAFE value — the one that adds nothing",
// because a hallucinated penalty is worse than a missed one. That is true as far
// as it goes, and it is the wrong frame: BOTH are fabrications. `false` is not a
// safe default for "did this piece suppress a side?" — it is an answer, it is
// published as an answer, and it is one the model never gave.
//
// The same applies to `political_lean`. It defaulted to 0, which does not mean
// "we do not know". On the page it renders as "Article framing: Center", plots a
// dot dead centre on The Map, and satisfies a reader filtering for centrist
// coverage. Unknown became a specific, checkable, wrong claim. "Unknown is not
// no, through every downstream consumer" is the rule; collapsing it here is where
// that gets violated first.
//
// So each parser returns either a value or a reason it could not produce one, and
// the caller drops the article. Clamping survives in exactly the places where the
// intent is unambiguous — 5.4 on a 1-5 scale is a model overshooting a range it
// was told, and a lean of 140 is the same — but nothing here converts an absence
// into a number.

import { LABELS, type Label } from "./calibration.js";
import { REGISTERS, type CompositeFlags, type Register } from "./composite.js";

const LABEL_SET = new Set<string>(LABELS);
const REGISTER_SET = new Set<string>(REGISTERS);

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const fail = (...problems: string[]): Parsed<never> => ({ ok: false, problems });
const pass = <T>(value: T): Parsed<T> => ({ ok: true, value });

// ── Flags ──────────────────────────────────────────────────────────────────

// Exact types, not truthiness. `bool(v) => v === true` looks strict and is not:
// it maps the string "false", the number 0, null and undefined all to false
// without complaint, so a model returning `"loaded_headline": "true"` (a string)
// would have had the flag silently read as FALSE — the opposite of what it said.
function parseBool(o: Record<string, unknown>, key: string, problems: string[]): boolean | null {
  const v = o[key];
  if (typeof v === "boolean") return v;
  problems.push(`flags.${key} must be a boolean, received ${JSON.stringify(v)}`);
  return null;
}

// A count, so: a finite integer, not negative. Clamped at the top because a
// model reporting 40 distinct fallacies has overshot a scale rather than said
// something unreadable, and the floor ladder saturates at 3 anyway.
const MAX_FALLACY_COUNT = 10;
function parseFallacyCount(o: Record<string, unknown>, problems: string[]): number | null {
  const v = o.fallacy_count;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    problems.push(`flags.fallacy_count must be a finite number, received ${JSON.stringify(v)}`);
    return null;
  }
  if (v < 0) {
    problems.push(`flags.fallacy_count must not be negative, received ${v}`);
    return null;
  }
  return Math.min(MAX_FALLACY_COUNT, Math.round(v));
}

// Register is load-bearing twice over: it selects the marker exemption in both
// marking passes, and inside computeComposite a non-news register halves the
// language weight and switches off two floors. Defaulting it to "news" was the
// least-harm choice, but it is still a choice the model did not make, and on a
// sports or culture piece it is the wrong one — which is exactly why the per-
// source pin exists. An invalid register is now a rejection, and the pin still
// overrides a VALID one afterwards.
function parseRegister(o: Record<string, unknown>, problems: string[]): Register | null {
  const v = o.register;
  if (typeof v === "string" && REGISTER_SET.has(v)) return v as Register;
  problems.push(`flags.register must be one of ${REGISTERS.join(", ")}, received ${JSON.stringify(v)}`);
  return null;
}

export function parseFlags(raw: unknown): Parsed<CompositeFlags> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail(`flags must be an object, received ${JSON.stringify(raw)}`);
  }
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];

  const emotionalLede = parseBool(o, "emotional_lede", problems);
  const loadedHeadline = parseBool(o, "loaded_headline", problems);
  const oneSidedSourcing = parseBool(o, "one_sided_sourcing", problems);
  const opinionColumn = parseBool(o, "opinion_column", problems);
  const fallacyCount = parseFallacyCount(o, problems);
  const register = parseRegister(o, problems);

  if (problems.length > 0) return { ok: false, problems };

  return pass({
    emotionalLede: emotionalLede!,
    loadedHeadline: loadedHeadline!,
    fallacyCount: fallacyCount!,
    oneSidedSourcing: oneSidedSourcing!,
    opinionColumn: opinionColumn!,
    register: register!,
  });
}

// ── Political lean ─────────────────────────────────────────────────────────

// The second of LITMUS's two lenses, and it is published as "Article framing".
// There is no honest default: 0 is a claim that the piece sits at the centre.
export function parsePoliticalLean(raw: unknown): Parsed<number> {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fail(`political_lean must be a finite number, received ${JSON.stringify(raw)}`);
  }
  return pass(Math.max(-100, Math.min(100, Math.round(raw))));
}

// ── The declared band ──────────────────────────────────────────────────────

// The model's holistic read, and the only cross-check on the five dimensions.
// It used to be optional: `sanitizeBand` returned null for anything unrecognised
// and `judgeDeclaredBand` treats null as agreement, so a model that stopped
// returning a band would have switched the check off silently while every log
// line stayed green. A check that can be disabled by the thing it checks is not
// a check. It is required now.
// The band names before the 2026-10-02 rename (Max: Practical and Hysterical
// became Proportionate and Hyperbolic). A model that still answers in the old
// words means the same band, so the read is kept rather than the article lost.
const RENAMED_BANDS: Record<string, Label> = { Practical: "Proportionate", Hysterical: "Hyperbolic" };

export function parseDeclaredBand(raw: unknown): Parsed<Label> {
  if (typeof raw === "string" && LABEL_SET.has(raw)) return pass(raw as Label);
  if (typeof raw === "string" && raw in RENAMED_BANDS) return pass(RENAMED_BANDS[raw]!);
  return fail(`band is required and must be one of ${LABELS.join(", ")}, received ${JSON.stringify(raw)}`);
}

// ── Reconciling what came back against what was asked for ──────────────────

export interface IdReconciliation {
  // article_id -> the single entry for it. Only ids that appeared exactly once
  // AND were requested.
  usable: Map<number, unknown>;
  duplicated: number[];
  missing: number[];
  unrequested: number[];
}

// `new Map(scores.map(s => [s.article_id, s]))` is last-write-wins, and it does
// it in silence. Two entries for one article — which is a real failure mode when
// a batch confuses the model — meant the second one won and the first vanished,
// with no log line and no way to know which of the two answers the reader is
// looking at. Neither is trustworthy once they disagree, so both are dropped and
// the article is re-queued.
//
// An id that was never requested is a different problem: the model has invented
// or transposed an article number, and using it would attach one article's score
// to another's body.
export function reconcileIds<T extends { article_id?: unknown }>(
  requestedIds: number[],
  entries: T[],
): IdReconciliation {
  const requested = new Set(requestedIds);
  const seen = new Map<number, T[]>();
  const unrequested: number[] = [];

  for (const e of entries) {
    const id = e?.article_id;
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    if (!requested.has(id)) {
      unrequested.push(id);
      continue;
    }
    const list = seen.get(id) ?? [];
    list.push(e);
    seen.set(id, list);
  }

  const usable = new Map<number, unknown>();
  const duplicated: number[] = [];
  for (const [id, list] of seen) {
    if (list.length === 1) usable.set(id, list[0]);
    else duplicated.push(id);
  }

  const missing = requestedIds.filter((id) => !seen.has(id));

  return {
    usable,
    duplicated: duplicated.sort((a, b) => a - b),
    missing,
    unrequested: [...new Set(unrequested)].sort((a, b) => a - b),
  };
}
