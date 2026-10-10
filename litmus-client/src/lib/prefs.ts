// localStorage-backed user preferences. No accounts in v1.
// Wrap reads in try/catch in case localStorage is unavailable (private mode, SSR).

import type { Lean } from "./types.ts";

const KEY = "litmus.prefs.v1";

export interface Prefs {
  enabledSourceIds: number[] | null;     // null = all enabled
  leanFilter: Lean[] | null;              // null = no filter
  balanceMode: boolean;                   // auto-spread across leans
  showOriginalFirst: boolean;             // article detail toggle
}

const DEFAULTS: Prefs = {
  enabledSourceIds: null,
  leanFilter: null,
  balanceMode: false,
  showOriginalFirst: true,
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // ignore — private mode or quota exceeded
  }
}

export function updatePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...patch };
  savePrefs(next);
  return next;
}
