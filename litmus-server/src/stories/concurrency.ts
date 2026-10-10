// Bounded concurrency for the Story Ledger's model calls.
//
// Found 2026-09-26 (Codex review of a9d3a56): after a fatal model error the
// run kept going in two ways. Assignment's and sweep's semaphores freed their
// slot before the caller classified the error, so every queued batch still
// started (200 articles at concurrency 5 attempted all eight batches after a
// usage-limit rejection). And Promise.all rejected while sibling calls were
// still in flight, so the run was closed as aborted before their usage rows
// were written; the 10:18 lockout rehearsal logged eight calls and recorded
// one. Now the limiter latches the fatal error before it frees the slot, and
// every fan-out settles before it rejects.

import { CallSkippedError, FatalModelError, toFatalModelError } from "./modelErrors.js";

export class ModelCallLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private fatal: FatalModelError | null = null;

  constructor(private readonly maximum: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      if (this.fatal) throw new CallSkippedError(this.fatal);
      return await fn();
    } catch (error) {
      // Latch before `finally` wakes the next waiter, so it sees the stop.
      if (!this.fatal && !(error instanceof CallSkippedError)) this.fatal = toFatalModelError(error);
      throw error;
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

// Promise.all, except it waits for every promise to settle before rejecting,
// so work already started finishes and is accounted for. A fatal model error
// wins over any other rejection.
export async function settleAll<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const failures = settled
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (failures.length > 0) throw failures.find((error) => error instanceof FatalModelError) ?? failures[0];
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!);
      } catch (error) {
        // Stop handing out work: a fatal model error must not be followed by
        // every other worker making its own doomed calls.
        next = items.length;
        throw error;
      }
    }
  }
  await settleAll(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
