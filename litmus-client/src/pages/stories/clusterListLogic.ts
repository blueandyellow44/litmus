// All Stories: the pure half of the page. Filter and sort definitions, the URL
// state, the filtering and sorting themselves, and every sentence that reports a
// count. Both ClusterListDesktop.tsx and ClusterListMobile.tsx render from this
// through useClusterList.ts, so the two versions cannot disagree about what a
// filter matches or what a count says. Nothing here touches React.
//
// The history of the page, and why the controls cover the whole edition:
//
// Two rounds of defect here, and the second is subtler than the first. The page
// originally fetched 50 articles, offered no way to get more, and printed "50
// articles across the spectrum" — a sentence true about the page and false about
// the edition. Pagination fixed the reading. It did not fix the CONTROLS: every
// filter, every source in the source dropdown, every count and every sort still
// operated over whatever happened to be loaded. Filtering to Fox News and seeing
// "3 articles" was a claim about the edition computed from a sample of it, and
// nothing on screen said so.
//
// So the page now holds the complete edition and every control operates over all
// of it. Rendering is still incremental: the numbers describe the edition while
// the DOM describes the screen.

import type { ArticleSummaryDTO, Lean } from "../../lib/types.ts";
import { PH_BANDS, bandForComposite, isValidComposite, UNRATED_LABEL } from "../../lib/phBand.ts";
import { baselineLabel, framingLabel } from "../../components/meta.tsx";

export type Mode = "feed" | "clusters";
export type Load = "loading" | "ready" | "error";

// How many rows are drawn at once. Purely a rendering budget: filters, counts
// and sorts never look at it. One budget for both versions, so "Showing the
// first 50" means the same thing on a phone and a desktop.
export const RENDER_STEP = 50;

// Sorts the edition can honestly offer.
//
// "Most covered" is deliberately ABSENT. It shipped in an earlier pass and it
// was wrong: with no cluster identifier on ArticleSummaryDTO it approximated
// "same story" by normalising headline words, which is a text-similarity guess
// wearing the clothes of an authoritative coverage count. It would happily rank
// two unrelated stories that share four long words above a story six outlets
// actually covered. A coverage-volume sort needs a real cluster id and the
// cluster's own article and source counts on the DTO; until the API carries
// those, the honest number of sorts is five.
//
// Nothing here is called popular or trending either. LITMUS holds no reach,
// readership or click data at all.
export const SORTS = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "ph-high", label: "P/H high to low" },
  { key: "ph-low", label: "P/H low to high" },
  { key: "source", label: "Source A–Z" },
] as const;
export type SortKey = (typeof SORTS)[number]["key"];
// Exported so a test can assert the whole set rather than a sample of it, which
// is what catches a sort quietly reappearing.
export const SORT_KEYS: readonly SortKey[] = SORTS.map((s) => s.key);
const SORT_KEY_SET = new Set<string>(SORT_KEYS);

export const BASELINES: Lean[] = ["left", "center-left", "center", "center-right", "right"];
export const FRAMINGS = ["Left", "Center-left", "Center", "Center-right", "Right"] as const;
export const PAYWALL_OPTIONS = [
  { key: "any", label: "Any" },
  { key: "open", label: "Full text" },
  { key: "restricted", label: "Paywalled or partial" },
] as const;
export type PaywallKey = (typeof PAYWALL_OPTIONS)[number]["key"];

export const ANY = "__any__";

export interface Filters {
  section: string;
  baseline: string;
  framing: string;
  band: string;
  source: string;
  paywall: PaywallKey;
}

export const NO_FILTERS: Filters = {
  section: ANY,
  baseline: ANY,
  framing: ANY,
  band: ANY,
  source: ANY,
  paywall: "any",
};

// ── URL state ──────────────────────────────────────────────────────────────
//
// A filtered view is a thing a reader wants to link to, come back to, and reach
// with the back button. Holding it only in component state meant a reload
// silently reset it and a shared link showed the sender something different from
// what they were looking at. It also means a reader who switches between the
// desktop and mobile versions keeps their view: the URL carries it across.

const PARAM: Record<keyof Filters, string> = {
  section: "section",
  baseline: "outlet",
  framing: "framing",
  band: "band",
  source: "source",
  paywall: "access",
};

export function filtersFromParams(p: URLSearchParams): Filters {
  const read = (key: keyof Filters, fallback: string) => p.get(PARAM[key]) ?? fallback;
  const paywall = read("paywall", "any");
  return {
    section: read("section", ANY),
    baseline: read("baseline", ANY),
    framing: read("framing", ANY),
    band: read("band", ANY),
    source: read("source", ANY),
    // An unrecognised access value falls back rather than filtering everything
    // out: a hand-edited URL should degrade to a wider view, never an empty one.
    paywall: isPaywallKey(paywall) ? paywall : "any",
  };
}

export function modeFromParams(p: URLSearchParams): Mode {
  return p.get("view") === "clusters" ? "clusters" : "feed";
}

export function sortFromParams(p: URLSearchParams): SortKey {
  const raw = p.get("sort") ?? "";
  return isSortKey(raw) ? raw : "newest";
}

export function paramsFrom(filters: Filters, sort: SortKey, mode: Mode): URLSearchParams {
  const p = new URLSearchParams();
  for (const key of Object.keys(PARAM) as (keyof Filters)[]) {
    const v = filters[key];
    const isDefault = key === "paywall" ? v === "any" : v === ANY;
    if (!isDefault) p.set(PARAM[key], v);
  }
  if (sort !== "newest") p.set("sort", sort);
  if (mode !== "feed") p.set("view", mode);
  return p;
}

export function isSortKey(v: string): v is SortKey {
  return SORT_KEY_SET.has(v);
}

export function isPaywallKey(v: string): v is PaywallKey {
  return PAYWALL_OPTIONS.some((o) => o.key === v);
}

export function activeFilterCount(filters: Filters): number {
  return (Object.keys(filters) as (keyof Filters)[]).filter((k) =>
    k === "paywall" ? filters[k] !== "any" : filters[k] !== ANY,
  ).length;
}

// ── Filtering and sorting, over the complete edition ───────────────────────

export function applyFilters(articles: ArticleSummaryDTO[], f: Filters): ArticleSummaryDTO[] {
  return articles.filter((a) => {
    if (f.section !== ANY && (a.score?.section ?? "") !== f.section) return false;
    if (f.baseline !== ANY && a.sourceLean !== f.baseline) return false;
    if (f.framing !== ANY) {
      const lean = a.score?.politicalLean;
      // "Unknown" is not "Center". An article with no framing reading is
      // excluded from every framing filter rather than answering to one of them.
      if (typeof lean !== "number" || !Number.isFinite(lean)) return false;
      if (framingLabel(lean) !== f.framing) return false;
    }
    if (f.band !== ANY) {
      const band = bandForComposite(a.score?.composite);
      // Same rule for the P/H band: a row whose composite is not a number on the
      // scale matches no band, including the calmest one.
      if (!band) return f.band === UNRATED_LABEL;
      if (band.label !== f.band) return false;
    }
    if (f.source !== ANY && a.sourceName !== f.source) return false;
    if (f.paywall !== "any") {
      const restricted = a.paywallFlag || a.extractionStatus !== "full";
      if (f.paywall === "open" && restricted) return false;
      if (f.paywall === "restricted" && !restricted) return false;
    }
    return true;
  });
}

export function applySort(articles: ArticleSummaryDTO[], sort: SortKey): ArticleSummaryDTO[] {
  // Every comparator ends on id so the order is total. Without it two articles
  // sharing a sort value can swap places between renders, which reads as the
  // list shuffling itself.
  const byId = (a: ArticleSummaryDTO, b: ArticleSummaryDTO) => b.id - a.id;
  const time = (a: ArticleSummaryDTO) => Date.parse(a.publishedAt ?? a.fetchedAt) || 0;
  // An unusable composite sorts to the END in both directions rather than
  // masquerading as the calmest or the hottest thing on the page.
  const ph = (a: ArticleSummaryDTO, whenInvalid: number) =>
    isValidComposite(a.score?.composite) ? (a.score!.composite as number) : whenInvalid;
  const out = [...articles];
  switch (sort) {
    case "newest":
      return out.sort((a, b) => time(b) - time(a) || byId(a, b));
    case "oldest":
      return out.sort((a, b) => time(a) - time(b) || byId(a, b));
    case "ph-high":
      return out.sort((a, b) => ph(b, -Infinity) - ph(a, -Infinity) || byId(a, b));
    case "ph-low":
      return out.sort((a, b) => ph(a, Infinity) - ph(b, Infinity) || byId(a, b));
    case "source":
      return out.sort((a, b) => a.sourceName.localeCompare(b.sourceName) || byId(a, b));
  }
}

// Option lists come from the COMPLETE edition, so the source dropdown offers
// every outlet that filed rather than every outlet on page one.
export function sectionsIn(articles: ArticleSummaryDTO[]): string[] {
  return [...new Set(articles.map((a) => a.score?.section).filter((s): s is string => !!s))].sort();
}

export function sourcesIn(articles: ArticleSummaryDTO[]): string[] {
  return [...new Set(articles.map((a) => a.sourceName))].sort();
}

// ── The seven controls, described once ─────────────────────────────────────
//
// The desktop rail and the mobile disclosure lay these out differently, but the
// labels, the option wording and the order are the same list, so neither
// version can offer a filter the other lacks.

export type FieldKey = keyof Filters | "sort";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectField {
  key: FieldKey;
  label: string;
  value: string;
  options: SelectOption[];
}

export function selectFields(filters: Filters, sort: SortKey, sections: string[], sources: string[]): SelectField[] {
  return [
    {
      key: "section",
      label: "Section",
      value: filters.section,
      options: [{ value: ANY, label: "All sections" }, ...sections.map((s) => ({ value: s, label: s }))],
    },
    {
      key: "baseline",
      label: "Outlet baseline",
      value: filters.baseline,
      options: [{ value: ANY, label: "Any outlet" }, ...BASELINES.map((b) => ({ value: b, label: baselineLabel(b) }))],
    },
    {
      key: "framing",
      label: "Article framing",
      value: filters.framing,
      options: [{ value: ANY, label: "Any framing" }, ...FRAMINGS.map((f) => ({ value: f, label: f }))],
    },
    {
      key: "band",
      label: "P/H band",
      value: filters.band,
      options: [
        { value: ANY, label: "Any band" },
        ...PH_BANDS.map((b) => ({ value: b.label as string, label: b.label })),
        { value: UNRATED_LABEL, label: UNRATED_LABEL },
      ],
    },
    {
      key: "source",
      label: "Source",
      value: filters.source,
      options: [{ value: ANY, label: "All sources" }, ...sources.map((s) => ({ value: s, label: s }))],
    },
    {
      key: "paywall",
      label: "Access",
      value: filters.paywall,
      options: PAYWALL_OPTIONS.map((p) => ({ value: p.key, label: p.label })),
    },
    {
      key: "sort",
      label: "Sort",
      value: sort,
      options: SORTS.map((s) => ({ value: s.key, label: s.label })),
    },
  ];
}

// ── Copy that reports a count ──────────────────────────────────────────────

export const LOADING_EDITION = "Loading the edition…";
export const GROUPING_STORIES = "Grouping stories…";

export interface CountInputs {
  loaded: number;
  editionTotal: number;
  editionComplete: boolean;
  matched: number;
  shown: number;
}

// The honest count. It describes the EDITION, because the filters do.
export function countLine({ loaded, editionTotal, editionComplete, matched, shown }: CountInputs): string {
  const filtering = matched !== loaded;
  const head = filtering
    ? `${matched} of ${loaded} articles in this edition match.`
    : `${loaded} article${loaded === 1 ? "" : "s"} in this edition.`;
  const showing = shown < matched ? ` Showing the first ${shown}.` : "";
  const partial =
    !editionComplete && editionTotal > loaded
      ? ` Part of this edition could not be loaded: ${loaded} of ${editionTotal} arrived.`
      : "";
  return head + showing + partial;
}

// Filters describe the edition, and say so. An earlier version of this line had
// to warn that they only covered what was loaded.
export function filterScopeNote(editionComplete: boolean): string {
  return editionComplete
    ? "Filters and sort cover every article in this edition."
    : "Part of this edition could not be loaded, so filters cover only what arrived.";
}

export function showMoreLabel(remaining: number): string {
  return `Show ${Math.min(RENDER_STEP, remaining)} more`;
}

export function remainingNote(remaining: number, filtering: boolean): string {
  return `${remaining} more ${filtering ? "match" : "in this edition"}`;
}

// Only worth saying once the reader has paged past the first budget.
export function endOfListNote(matched: number, shown: number, filtering: boolean): string | null {
  if (shown !== matched || matched <= RENDER_STEP) return null;
  return `That is all ${matched} ${filtering ? "matching articles" : "articles in this edition"}.`;
}

export function clearFiltersLabel(active: number): string {
  return `Clear ${active} filter${active === 1 ? "" : "s"}`;
}

// The verb is the only device difference: a phone reader taps.
export function clusterCountLine(count: number, verb: "Click" | "Tap"): string {
  return `${count} stor${count === 1 ? "y" : "ies"} several outlets covered. ${verb} a story to see how each one told it.`;
}

// Grouping is computed over the whole edition and the filter controls are not
// shown in that view, but the filters stay in the URL and return with Feed. A
// reader who filtered to Business and then grouped would otherwise read three
// edition-wide stories as three Business stories. Silence there is a false claim
// by omission, so the view says what it covers.
export function groupedFilterNote(active: number): string | null {
  if (active === 0) return null;
  return `Grouped stories cover the whole edition. Your ${active} filter${active === 1 ? "" : "s"} still appl${
    active === 1 ? "ies" : "y"
  } in Feed.`;
}

// The mobile disclosure's closing action. It names the result the filters
// produced, so the reader sees a change took effect at the control they just
// used instead of 700px above it.
export function showResultsLabel(matched: number, filtering: boolean): string {
  if (!filtering) return `Show all ${matched} article${matched === 1 ? "" : "s"}`;
  if (matched === 0) return "No articles match";
  return `Show ${matched} matching article${matched === 1 ? "" : "s"}`;
}

// A cluster's lean spread as readable parts, in the bar's left-to-right order.
// The counts are OUTLET baselines (the server counts sources.lean per member
// article), never the articles' own framing, so the legend says so. Zero counts
// are dropped exactly as the bar drops their segments.
export interface LeanSpreadPart {
  lean: Lean;
  label: string;
  count: number;
}

export function leanSpreadParts(leanCounts: Record<string, number>): LeanSpreadPart[] {
  return BASELINES.flatMap((lean) => {
    const count = leanCounts[lean] ?? 0;
    return count > 0 ? [{ lean, label: baselineLabel(lean), count }] : [];
  });
}
