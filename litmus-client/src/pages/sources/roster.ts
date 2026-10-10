// The roster's derived values, shared by the desktop and mobile Sources pages.
// Pure, so both versions group, count and label outlets identically and the
// logic is testable without rendering.
//
// It deliberately carries no `reliability`. That field is an internal judgement
// with no published rubric and no named authority (see
// litmus-server/sources/README.md); printing it would present an opinion as a
// rating of a publication.

import type { Lean, PaywallStatus, SourceDTO, SourceType } from "../../lib/types.ts";
import { baselineLabel } from "../../components/meta.tsx";

export const LEAN_ORDER: Lean[] = ["left", "center-left", "center", "center-right", "right"];

// The key for outlets whose baseline is not one of the five. The type says that
// cannot happen, but the roster arrives as JSON; an off-list value used to drop
// the outlet from every group while the headline count still included it. It is
// shown under "Unrated" (baselineLabel's own word) rather than silently lost.
export const UNRATED = "unrated";

export interface RosterGroup {
  key: Lean | typeof UNRATED;
  label: string;
  items: SourceDTO[];
}

export interface RosterSummary {
  groups: RosterGroup[];
  total: number;
  read: number;
  off: number;
}

export function summarizeRoster(sources: SourceDTO[]): RosterSummary {
  const known = new Set<string>(LEAN_ORDER);
  const groups: RosterGroup[] = LEAN_ORDER.map((lean) => ({
    key: lean,
    label: baselineLabel(lean),
    items: sources.filter((s) => s.lean === lean),
  }));
  groups.push({ key: UNRATED, label: baselineLabel(UNRATED), items: sources.filter((s) => !known.has(s.lean)) });

  const read = sources.filter((s) => s.enabled).length;
  return {
    groups: groups.filter((g) => g.items.length > 0),
    total: sources.length,
    read,
    off: sources.length - read,
  };
}

// The count sentence, identical on both versions.
export function rosterCountLine({ total, read, off }: Pick<RosterSummary, "total" | "read" | "off">): string {
  return `${total} outlets in the roster, ${read} currently read${off > 0 ? `, ${off} switched off` : ""}.`;
}

// Display words for the roster's enum values. The page used to print the raw
// keys ("digital-native", "hard"); these say the same thing in plain words and
// fall back to the raw value rather than hiding an unexpected one.
const TYPE_LABEL: Record<SourceType, string> = {
  wire: "Wire service",
  newspaper: "Newspaper",
  magazine: "Magazine",
  broadcast: "Broadcast",
  "digital-native": "Digital native",
};

const ACCESS_LABEL: Record<PaywallStatus, string> = {
  free: "Free",
  metered: "Metered",
  hard: "Hard paywall",
};

export function sourceTypeLabel(type: string): string {
  return TYPE_LABEL[type as SourceType] ?? type;
}

export function accessLabel(status: string): string {
  return ACCESS_LABEL[status as PaywallStatus] ?? status;
}

export function readLabel(enabled: boolean): string {
  return enabled ? "read" : "not read";
}

// The anchor a group heading carries, so the mobile jump links and any deep
// link resolve to the same place.
export function groupAnchor(key: RosterGroup["key"]): string {
  return `baseline-${key}`;
}
