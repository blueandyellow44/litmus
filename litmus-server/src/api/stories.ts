// GET /api/stories — the story-first front page's data (docs/plans/
// story-first-build-2026-09-13.md). Assembles StoryDTO from the Story Ledger's
// tables (stories, story_members) joined against articles/sources/scores.
//
// Only status = 'open' stories are offered; 'dormant' stories are still real
// but not part of the current edition, and 'merged' stories are redirects, not
// content. assessment/notes default to their honest empty states (null /
// []) when S4/S5 have not run for a story yet — StoryCard already renders
// those states, this is not a shortcut. coverage.excluded is not yet wired to
// a per-story sweep report (v1); sweepComplete reflects the most recently
// finished story run.

import { Router, type Request, type Response } from "express";
import { pool } from "../db/client.js";
import type { Queryable } from "../db/repos/storiesRepo.js";
import { logger } from "../lib/logger.js";
import { buildExcerptWindow, splitParagraphs } from "../lib/paragraphs.js";
import { dropNonStaffSpeech, isTooWeakToMark } from "../scoring/markerGuards.js";
import { biggestDriver, isDriverReason, DIMENSIONS } from "../scoring/reasonCheck.js";
import { dedupePrimaries } from "./dedupePrimaries.js";
import { buildFramingNotes, type FramingNoteMemberInput } from "../stories/framingNotes.js";
import { firstSentence } from "../stories/assessment.js";
import type { MarkerCategory } from "../scoring/calibration.js";
import type { PHMarker } from "../scoring/phScorer.js";
import type { HeatDimension, StoryDTO, StoryExcerptDTO, StoryHeatDTO, StoryMemberDTO } from "./storyTypes.js";

export const storiesRouter = Router();

// Mirrors OUTLET_KEY_SQL in stories/retrieval.ts — one identity per outlet
// across sister feeds, computed the same way everywhere it is computed.
const OUTLET_KEY_SQL = `COALESCE(
  src.outlet_key,
  NULLIF(btrim(lower(regexp_replace(split_part(src.name, ' — ', 1), '[^A-Za-z0-9]+', '-', 'g')), '-'), ''),
  'source-' || src.id::text
)`;

interface StoryFeedRow {
  story_id: string;
  slug: string;
  section: string | null;
  headline: string;
  event_statement: string;
  assessment_text: string | null;
  assessment_model: string | null;
  assessment_generated_at: Date | null;
  touches_politics: boolean | null;
  first_seen_at: Date;
  updated_at: Date;
  article_id: number;
  role: "primary" | "secondary";
  kind: "full" | "headline_only" | "syndicated";
  syndicated_of_article_id: number | null;
  title: string;
  url: string;
  published_at: Date | null;
  raw_text: string;
  source_name: string;
  source_lean: StoryMemberDTO["sourceLean"];
  outlet_key: string;
  composite: number | null;
  political_lean: number | null;
  rationale_json: ({ summary?: string | null } & Partial<Record<HeatDimension, string | null>>) | null;
  breakdown: { effectiveDimensions?: Record<string, unknown>; raised?: unknown } | null;
  flags: Record<string, unknown> | null;
  markers: PHMarker[] | null;
  excerpt_indices: number[] | null;
}

// null composite means headline-only or unscored: nothing to build an excerpt
// from, the same floor storyMemberKind (ledger.ts) already applies.
function memberExcerpt(row: StoryFeedRow): StoryExcerptDTO | null {
  if (row.composite === null) return null;
  // The same two guards the scorer now applies, run here too so scores stored
  // before them are published under the same rules (markerGuards.ts).
  const markers = dropNonStaffSpeech(row.markers ?? [], row.raw_text).filter((m) => !isTooWeakToMark(m));
  return buildExcerptWindow(row.raw_text, row.excerpt_indices ?? [], markers);
}

function isDimensions(v: unknown): v is Record<HeatDimension, number> {
  return !!v && typeof v === "object" && DIMENSIONS.every((d) => Number.isFinite((v as Record<string, unknown>)[d]));
}

// What set the number, read from the score's own record; the card shows the
// driver's evidence when the body has no loaded span to quote. Null when the
// telling is unscored or was scored before the breakdown and flags existed.
export function toHeat(row: Pick<StoryFeedRow, "composite" | "breakdown" | "flags" | "rationale_json" | "raw_text">, excerpt: StoryExcerptDTO | null): StoryHeatDTO | null {
  if (row.composite === null) return null;
  const dims = row.breakdown?.effectiveDimensions;
  if (!isDimensions(dims)) return null;
  const driver = biggestDriver(dims);
  if (!driver) return null;
  const flags = row.flags ?? {};
  const floors = Array.isArray(row.breakdown?.raised) ? row.breakdown!.raised.filter((f): f is string => typeof f === "string") : [];
  const note = row.rationale_json?.[driver];
  // The lede is published only when the excerpt already opens with it (the
  // excerpt window can start later, and its first paragraph can be cut to the
  // legal word cap), so this adds no text outside the excerpt's window.
  const firstParagraph = splitParagraphs(row.raw_text)[0] ?? null;
  const lede = firstParagraph !== null ? firstSentence(firstParagraph) : null;
  const ledeShown = lede !== null && lede.length > 0 && excerpt !== null && (excerpt.paragraphs[0] ?? "").startsWith(lede);
  return {
    driver,
    dimensions: { headline: dims.headline, language: dims.language, sourcing: dims.sourcing, fallacies: dims.fallacies, structure: dims.structure },
    loadedHeadline: flags.loadedHeadline === true,
    emotionalLede: flags.emotionalLede === true,
    oneSidedSourcing: flags.oneSidedSourcing === true,
    fallacyCount: typeof flags.fallacyCount === "number" && Number.isFinite(flags.fallacyCount) ? flags.fallacyCount : 0,
    floors,
    note: typeof note === "string" && note.trim().length > 0 ? note.trim() : null,
    lede: ledeShown ? lede : null,
  };
}

function toMember(row: StoryFeedRow, excerpt: StoryExcerptDTO | null): StoryMemberDTO {
  return {
    articleId: row.article_id,
    outletKey: row.outlet_key,
    outletName: row.source_name,
    sourceLean: row.source_lean,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at?.toISOString() ?? null,
    kind: row.kind,
    syndicatedOfArticleId: row.syndicated_of_article_id,
    role: row.role,
    composite: row.composite,
    politicalLean: row.political_lean,
    // A reason that names what set the number, or nothing (Max, 2026-10-02):
    // scores stored before the write-time check get the same test here.
    howItWasTold: row.composite !== null && isDriverReason(row.rationale_json?.summary, biggestDriver(row.breakdown?.effectiveDimensions))
      ? row.rationale_json!.summary!.trim()
      : null,
    heat: toHeat(row, excerpt),
    excerpt,
  };
}

function toFramingInput(row: StoryFeedRow, excerpt: StoryExcerptDTO | null): FramingNoteMemberInput {
  const lead = excerpt?.paragraphs[0] ?? null;
  return {
    outletName: row.source_name,
    role: row.role,
    leadParagraph: lead,
    leadMarkerCategories: lead
      ? (excerpt!.markers.filter((m) => lead.includes(m.text)).map((m) => m.category as MarkerCategory))
      : [],
  };
}

async function latestSweepComplete(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ sweep_complete: boolean }>(
    `SELECT sweep_complete FROM story_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
  );
  return rows[0]?.sweep_complete ?? false;
}

// The edition's open stories, each with every member and what can be shown
// about it without a full body: excerpt, score, framing. Exported (not just
// the route) so an integration test can call it directly against a real
// database without going through HTTP.
export async function listStoriesFeed(db: Queryable = pool): Promise<StoryDTO[]> {
  const [{ rows }, sweepComplete] = await Promise.all([
    db.query<StoryFeedRow>(
      `SELECT st.id AS story_id, st.slug, st.section, st.headline, st.event_statement,
              st.assessment_text, st.assessment_model, st.assessment_generated_at,
              st.touches_politics, st.first_seen_at, st.updated_at,
              sm.article_id, sm.role, sm.kind, sm.syndicated_of_article_id,
              a.title, a.url, a.published_at, COALESCE(a.clean_text, a.raw_text) AS raw_text,
              src.name AS source_name, src.lean AS source_lean, ${OUTLET_KEY_SQL} AS outlet_key,
              sc.composite, sc.political_lean, sc.rationale_json, sc.markers, sc.excerpt_indices, sc.breakdown, sc.flags
         FROM stories st
         JOIN story_members sm ON sm.story_id = st.id
         JOIN articles a ON a.id = sm.article_id
         JOIN sources src ON src.id = a.source_id
         LEFT JOIN scores sc ON sc.article_id = a.id
        WHERE st.status = 'open'
        ORDER BY st.updated_at DESC, st.id, sm.added_at`,
    ),
    latestSweepComplete(db),
  ]);

  const byStory = new Map<string, StoryFeedRow[]>();
  for (const row of rows) {
    const group = byStory.get(row.story_id) ?? [];
    group.push(row);
    byStory.set(row.story_id, group);
  }

  const stories = [...byStory.entries()].map(([storyId, memberRows]) => {
    const meta = memberRows[0]!;
    const excerpts = memberRows.map((row) => memberExcerpt(row));
    const members = dedupePrimaries(memberRows.map((row, i) => toMember(row, excerpts[i]!)));
    const notes = buildFramingNotes(memberRows.map((row, i) => toFramingInput(row, excerpts[i]!)));

    const primaryOutletKeys = new Set(members.filter((m) => m.role === "primary").map((m) => m.outletKey));
    // The range comes from the same one-per-outlet set as the outlet count.
    const composites = members.filter((m) => m.role === "primary").map((m) => m.composite).filter((c): c is number => c !== null);

    return {
      id: storyId,
      slug: meta.slug,
      section: meta.section,
      headline: meta.headline,
      eventStatement: meta.event_statement,
      assessment: meta.assessment_text
        ? {
            text: meta.assessment_text,
            model: meta.assessment_model ?? "",
            generatedAt: meta.assessment_generated_at?.toISOString() ?? "",
          }
        : null,
      touchesPolitics: meta.touches_politics ?? null,
      firstSeenAt: meta.first_seen_at.toISOString(),
      updatedAt: meta.updated_at.toISOString(),
      outletCount: primaryOutletKeys.size,
      memberCount: members.length,
      phMin: composites.length > 0 ? Math.min(...composites) : null,
      phMax: composites.length > 0 ? Math.max(...composites) : null,
      singleOutlet: primaryOutletKeys.size <= 1,
      members,
      notes,
      coverage: { excluded: [], sweepComplete },
    };
  });

  // Single-outlet stories are not "sufficient sources" to publish as their
  // own front-page story (found 2026-09-21: a failed/partial ledger run can
  // leave hundreds of never-merged single-article stubs open, and shipping
  // all of them - 685 in one real edition - is most of what made the client
  // look hung, not just the bundle). This is the same outletCount >= 2 bar
  // storyModel.ts's scheduleStoryReveal already applies client-side for the
  // drip; applying it at the source means the client never has to fetch,
  // parse, or hold the excluded stories at all.
  return stories.filter((story) => !story.singleOutlet);
}

// GET /api/stories
storiesRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const stories = await listStoriesFeed();
    res.json({ stories });
  } catch (err) {
    logger.error("GET /stories failed", { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "internal_error" });
  }
});
