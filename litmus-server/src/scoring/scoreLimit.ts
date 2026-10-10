// How many articles a scoring cycle may pay for.
//
// SCORE_LIMIT is a SAFETY CAP, not a dial. It can lower the ceiling for an
// experiment or a cheap run; it cannot raise it. A knob that reads from the
// environment and can also increase spend is one typo away from an expensive
// afternoon, and the environment is exactly where a stray value comes from.
//
// Raising the real ceiling is a code change to MAX_PER_CYCLE, reviewed like any
// other, because the cost decision behind 40 was deliberate: see scoreCron.

export class ScoreLimitError extends Error {}

export function resolveScoreLimit(raw: string | undefined, maxPerCycle: number): number {
  const value = (raw ?? "").trim();
  if (value === "") return maxPerCycle;

  // Reject before Number() so "5abc", "1e3" and " " do not become plausible
  // numbers by coercion.
  if (!/^\d+$/.test(value)) {
    throw new ScoreLimitError(
      `SCORE_LIMIT must be a positive whole number; got "${raw}". ` +
        "Fractions, negatives and anything non-numeric are refused rather than rounded.",
    );
  }

  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ScoreLimitError(`SCORE_LIMIT must be at least 1; got "${raw}".`);
  }
  if (n > maxPerCycle) {
    throw new ScoreLimitError(
      `SCORE_LIMIT=${n} exceeds MAX_PER_CYCLE=${maxPerCycle}. It is a cap that can only ` +
        "lower the ceiling. Raising it is a code change to MAX_PER_CYCLE, not an env var.",
    );
  }
  return n;
}
