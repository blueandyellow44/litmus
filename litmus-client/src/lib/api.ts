// Typed fetch wrappers for the litmus-server API.
// One function per endpoint. Errors throw — callers handle.

import type { ArticleSummaryDTO, ArticleDetailDTO, SourceDTO, TranslationDTO, ClusterDTO, ClusterArticleDTO, SectionSummaryDTO, SectionPageDTO } from "./types.ts";
import { evaluateEdition, type EditionStatus } from "./edition.ts";
import type { StoryDTO, StoryListDTO } from "./storyTypes.ts";
import { decodeEntities } from "./entities.ts";

const BASE = "/api"; // dev: proxied by vite.config.ts; prod: same origin.

// Demo build (VITE_DEMO=true): serve a frozen snapshot of the API so the paper
// runs on Cloudflare Pages with no backend. Vite inlines the flag at build time,
// so the live build tree-shakes the snapshot import away entirely.
const DEMO = import.meta.env.VITE_DEMO === "true";
let snapshotP: Promise<any> | null = null;
function snapshot(): Promise<any> {
  if (!snapshotP) snapshotP = import("../demo/snapshot.json").then((m) => (m as { default: unknown }).default);
  return snapshotP;
}

export class ApiHttpError extends Error {
  constructor(public status: number, public code: string, public detail?: string) {
    super(`API ${status} ${code}${detail ? `: ${detail}` : ""}`);
    this.name = "ApiHttpError";
  }
}

async function getJson<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

async function request<T>(method: "GET" | "POST", path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    let code = "http_error";
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      if (body?.error) code = body.error;
      if (body?.detail) detail = body.detail;
    } catch {
      // non-JSON error body — fall through with default code
    }
    throw new ApiHttpError(res.status, code, detail);
  }
  return res.json() as Promise<T>;
}

// When this edition was compiled and how old its content is. The manifest is
// frozen into the snapshot at build time (scripts/edition-manifest.mjs); a live
// API build has no such record, so it honestly reports "unknown" rather than
// letting the masthead infer a date from the browser clock.
export async function fetchEditionStatus(): Promise<EditionStatus> {
  if (DEMO) return evaluateEdition((await snapshot()).edition);
  return evaluateEdition(null);
}

export interface ArticlePage {
  articles: ArticleSummaryDTO[];
  // Every eligible article in the edition, not the page size.
  total: number;
  nextCursor: string | null;
}

// One page of the feed.
//
// The demo build has no server, so it pages over the frozen snapshot with the
// same signature and the same cursor semantics. Both sides must page the SAME
// way or the shipped paper and the local one disagree about what "page 2" is —
// and the demo build is the one that ships. The snapshot's `articles` array is
// already in the server's order (newest first, id-tiebroken), so the cursor is
// just the index of the last row served, encoded so no caller can do arithmetic
// on it and start depending on the encoding.
export async function fetchArticlePage(limit = 50, cursor: string | null = null): Promise<ArticlePage> {
  if (DEMO) {
    const all = ((await snapshot()).articles ?? []) as ArticleSummaryDTO[];
    const start = decodeDemoCursor(cursor);
    const page = all.slice(start, start + limit);
    const end = start + page.length;
    return { articles: page, total: all.length, nextCursor: end < all.length ? encodeDemoCursor(end) : null };
  }
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  const data = await getJson<Partial<ArticlePage> & { articles?: ArticleSummaryDTO[] }>(`/articles?${qs}`);
  const articles = data.articles ?? [];
  return {
    articles,
    // An older server that returns only `{ articles }` reports the page length
    // as the total rather than claiming a number it did not send. The feed then
    // says "152 articles" for a 152-row page, which is true, instead of
    // "showing 50 of undefined".
    total: typeof data.total === "number" ? data.total : articles.length,
    nextCursor: data.nextCursor ?? null,
  };
}

// How many pages the whole-edition load will follow before it stops and admits
// it is incomplete. 40 pages of 200 is 8,000 articles, far beyond any edition
// this paper produces; the cap exists so a server bug that never returns a null
// cursor cannot spin the browser forever.
const MAX_EDITION_PAGES = 40;

export interface EditionLoad {
  articles: ArticleSummaryDTO[];
  // The edition total the server reports. Equal to articles.length on a
  // complete load.
  total: number;
  // False when the walk stopped early: the page cap was hit, or a page failed.
  // The UI needs this, because "no articles match your filters" and "the rest of
  // the edition never arrived" are different sentences and only one of them is
  // about the reader's filters.
  complete: boolean;
  // Set when a page failed, so the page can say what went wrong.
  error: string | null;
}

// The COMPLETE edition, for surfaces whose controls have to be honest.
//
// All Stories filters, counts and sorts describe "this edition", and they can
// only do that over the whole set. Filtering the 50 rows that happen to be
// loaded and calling the result "3 articles from Fox News" is a claim about the
// edition drawn from a sample of it — the reader has no way to know whether
// three is the answer or the first page's share of it.
//
// The server keeps its keyset pagination, which is the right shape for an API.
// This walks it. In the demo build there is nothing to walk: the entire snapshot
// is already in the browser, having been shipped as part of the bundle, so the
// "load" is a slice of an array that is already in memory.
export async function fetchEntireEdition(pageSize = 200): Promise<EditionLoad> {
  const all: ArticleSummaryDTO[] = [];
  const seen = new Set<number>();
  let cursor: string | null = null;
  let total = 0;

  for (let page = 0; page < MAX_EDITION_PAGES; page++) {
    let res: ArticlePage;
    try {
      res = await fetchArticlePage(pageSize, cursor);
    } catch (err) {
      return {
        articles: all,
        total: Math.max(total, all.length),
        complete: false,
        error: err instanceof ApiHttpError ? err.message : String(err),
      };
    }
    total = res.total;
    // De-duplicate across the join. The cursor is exact, but an edition rebuilt
    // mid-walk could still repeat a row, and a duplicate in a list whose whole
    // claim is completeness is worse than a slow load.
    for (const a of res.articles) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      all.push(a);
    }
    if (!res.nextCursor) return { articles: all, total, complete: true, error: null };
    cursor = res.nextCursor;
  }

  return {
    articles: all,
    total: Math.max(total, all.length),
    complete: false,
    error: `stopped after ${MAX_EDITION_PAGES} pages`,
  };
}

// Opaque on purpose: a caller that can read the cursor will eventually add one
// to it, and then the demo and the live build page differently.
function encodeDemoCursor(index: number): string {
  return btoa(`demo:${index}`);
}
function decodeDemoCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const decoded = atob(cursor);
    if (!decoded.startsWith("demo:")) return 0;
    const n = Number(decoded.slice(5));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    // A malformed cursor restarts the feed. It travels in a URL; a truncated
    // one is a normal event, not an error worth a blank page.
    return 0;
  }
}

export async function fetchArticle(id: number): Promise<ArticleDetailDTO> {
  if (DEMO) {
    const a = (await snapshot()).articleDetail[String(id)];
    if (!a) throw new ApiHttpError(404, "not_found");
    return a;
  }
  return getJson<ArticleDetailDTO>(`/articles/${id}`);
}

export async function fetchSources(): Promise<SourceDTO[]> {
  if (DEMO) return (await snapshot()).sources;
  const data = await getJson<{ sources: SourceDTO[] }>(`/sources`);
  return data.sources;
}

// Trigger (or fetch cached) bias-stripped translation for an article.
// POST is the right verb here — the first call has a side effect (Claude call
// + DB write). Subsequent calls short-circuit to the cached row server-side.
export async function generateTranslation(
  articleId: number,
): Promise<{ translation: TranslationDTO | null; cached: boolean }> {
  if (DEMO) {
    // No server to call in the demo: return any translation frozen into the snapshot.
    const a = (await snapshot()).articleDetail[String(articleId)];
    return { translation: a?.translation ?? null, cached: true };
  }
  return request("POST", `/translations/${articleId}`);
}

export async function fetchClusters(): Promise<ClusterDTO[]> {
  if (DEMO) return (await snapshot()).clusters;
  const data = await getJson<{ clusters: ClusterDTO[] }>(`/clusters`);
  return data.clusters;
}

export async function fetchClusterArticles(clusterId: number): Promise<ClusterArticleDTO[]> {
  // Frozen into the snapshot by scripts/build-snapshot.mjs. This used to return
  // an empty array with the note "not part of the demo surface", which silently
  // removed the side-by-side comparison from the PUBLISHED paper — the demo
  // build is what ships, so anything absent here is absent for every reader.
  // The cluster carried leanCounts, so a story could show that it spanned left
  // and right while being unable to show what either side actually said.
  if (DEMO) return (await snapshot()).clusterArticles?.[clusterId] ?? [];
  const data = await getJson<{ articles: ClusterArticleDTO[] }>(`/clusters/${clusterId}/articles`);
  return data.articles;
}

export async function fetchSections(): Promise<SectionSummaryDTO[]> {
  if (DEMO) return (await snapshot()).sections;
  const data = await getJson<{ sections: SectionSummaryDTO[] }>(`/sections`);
  return data.sections;
}

// 404s with code "unknown_section" for a bad slug — callers handle via ApiHttpError.
export async function fetchSection(slug: string): Promise<SectionPageDTO> {
  if (DEMO) {
    const s = (await snapshot()).section[slug.toLowerCase()];
    if (!s) throw new ApiHttpError(404, "unknown_section");
    return s;
  }
  return getJson<SectionPageDTO>(`/sections/${encodeURIComponent(slug)}`);
}

// ── Stories ─────────────────────────────────────────────────────────────────
//
// The story-first paper (docs/plans/story-first-build-2026-09-13.md, C4). The
// snapshot freezes `stories` in edition order; the live API serves the same
// StoryListDTO from /api/stories. Until the server phases land, the demo
// snapshot's `stories` come from scripts/stories-fixture.mjs, built from the
// edition's clusters, so the UI can be built and checked on real shapes.
//
// A demo snapshot with NO `stories` array is an edition built before this
// contract existed, not a quiet news day, and the two must not look alike: the
// first throws, the second is an empty list the page can say something about.

export async function fetchStories(): Promise<StoryDTO[]> {
  if (DEMO) {
    const stories = (await snapshot()).stories;
    if (!Array.isArray(stories)) throw new ApiHttpError(404, "no_story_list", "this edition carries no story list");
    return (stories as StoryDTO[]).map(withDecodedTitles);
  }
  const data = await getJson<StoryListDTO>(`/stories`);
  return (data.stories ?? []).map(withDecodedTitles);
}

// Text stored before ingest decoded it still carries "&#039;" and the like
// (Max's phone, 2026-10-09: "&#039;Grandmother Tree&#039;"). Decoded here, at
// the one place stories enter the page, so every card, block and label gets
// the same text. Highlight markers are matched by their text, not by offset,
// so the excerpt and its markers are decoded together and still line up.
export function withDecodedTitles(story: StoryDTO): StoryDTO {
  return {
    ...story,
    headline: decodeEntities(story.headline),
    members: story.members.map((m) => ({
      ...m,
      title: decodeEntities(m.title),
      excerpt: m.excerpt && {
        ...m.excerpt,
        paragraphs: m.excerpt.paragraphs.map(decodeEntities),
        markers: m.excerpt.markers.map((mk) => ({ ...mk, text: decodeEntities(mk.text) })),
      },
      heat: m.heat && { ...m.heat, lede: m.heat.lede && decodeEntities(m.heat.lede) },
    })),
  };
}

// One story by slug (the /story/:slug route) or by id. 404s with code
// "unknown_story" for anything else, so the page can say "no such story"
// rather than "something broke".
export async function fetchStory(slugOrId: string): Promise<StoryDTO> {
  if (DEMO) {
    const stories = await fetchStories();
    const story = stories.find((s) => s.slug === slugOrId || s.id === slugOrId);
    if (!story) throw new ApiHttpError(404, "unknown_story");
    return story;
  }
  return withDecodedTitles(await getJson<StoryDTO>(`/stories/${encodeURIComponent(slugOrId)}`));
}
