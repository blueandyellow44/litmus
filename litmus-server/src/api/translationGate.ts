// The gate on on-demand translation (2026-10-10, from the secure-launch
// finding: the route took no sign-in and made a paid model call with no cap).
//
// The published paper is static and never runs this server, so the route is
// reachable only where someone starts the API. It is therefore OFF unless
// ENABLE_ON_DEMAND_TRANSLATION=1, and when on, new translations are capped per
// UTC day for the life of the process. A cached translation costs nothing and
// is never counted.

export type GateRefusal = { status: 403 | 429; error: "translation_disabled" | "translation_daily_cap" };

export interface TranslationGate {
  /** null when the route may run at all; a refusal when it is switched off. */
  enabled(): GateRefusal | null;
  /** Reserve one paid translation for today. null when reserved. */
  reserve(): GateRefusal | null;
  /** Give a reservation back when the paid call was never made. */
  release(): void;
}

export function parseDailyCap(raw: string | undefined, fallback = 25): number {
  const v = (raw ?? "").trim();
  if (v === "") return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`TRANSLATION_DAILY_CAP must be a whole number; got "${v}"`);
  return Number(v);
}

export function createTranslationGate(opts: { enabled: boolean; dailyCap: number; now?: () => number }): TranslationGate {
  const now = opts.now ?? Date.now;
  let day = "";
  let used = 0;
  const roll = (): void => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
  };
  return {
    enabled: () => (opts.enabled ? null : { status: 403, error: "translation_disabled" }),
    reserve: () => {
      if (!opts.enabled) return { status: 403, error: "translation_disabled" };
      roll();
      if (used >= opts.dailyCap) return { status: 429, error: "translation_daily_cap" };
      used += 1;
      return null;
    },
    release: () => {
      roll();
      if (used > 0) used -= 1;
    },
  };
}
