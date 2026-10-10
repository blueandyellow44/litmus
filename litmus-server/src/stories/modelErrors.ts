// Model errors that no retry, batch split or next-pair attempt can fix.
//
// Found 2026-09-22 (docs/run-failures/inventory-2026-09-22.md): with the
// account locked by its usage limit, the ledger treated every 400 like a
// one-off. Assignment split each failed batch in half and tried again (56
// calls from 8 batches), then flagged every article; the sweep marked every
// article incomplete, which also became a flag; and the critic moved on to
// the next of hundreds of merge pairs, one silent failure at a time. Flagged
// articles are never offered again, so a lockout quietly threw away the day.
//
// A fatal error now ends the run instead: nothing is flagged, articles not
// yet placed stay unassigned for the next run, and the reason is logged and
// recorded on the run.

export class FatalModelError extends Error {
  readonly reason: string;
  constructor(reason: string, cause: unknown) {
    super(`${reason}: ${messageOf(cause).slice(0, 300)}`, { cause });
    this.name = "FatalModelError";
    this.reason = reason;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  // The SDK's APIError message starts with the HTTP status: "400 {...}".
  const leading = /^(\d{3})\s/.exec(messageOf(error));
  return leading ? Number(leading[1]) : null;
}

// Returns the reason when the error is fatal, null when a retry might help.
export function fatalModelErrorReason(error: unknown): string | null {
  if (error instanceof FatalModelError) return error.reason;
  const status = statusOf(error);
  const message = messageOf(error).toLowerCase();
  if (message.includes("usage limit")) return "account usage limit reached";
  if (message.includes("credit balance") || message.includes("billing")) return "account billing or credit problem";
  if (status === 401) return "API key rejected (401)";
  if (status === 403) return "API key not permitted (403)";
  if (status === 404 && message.includes("model")) return "model not found (404)";
  return null;
}

export function isFatalModelError(error: unknown): boolean {
  return fatalModelErrorReason(error) !== null;
}

// The error as a FatalModelError, or null when a retry might help.
export function toFatalModelError(error: unknown): FatalModelError | null {
  const reason = fatalModelErrorReason(error);
  if (reason === null) return null;
  return error instanceof FatalModelError ? error : new FatalModelError(reason, error);
}

// Re-throws a fatal error as FatalModelError; returns normally otherwise, so a
// caller's existing fallback still handles one-off failures.
export function rethrowIfFatal(error: unknown): void {
  const fatal = toFatalModelError(error);
  if (fatal) throw fatal;
}

// Thrown instead of making a call once another call in the same phase hit a
// fatal error (concurrency.ts). No request was sent, so callers record no
// usage row for it; they throw `fatal`, the error that stopped the phase.
export class CallSkippedError extends Error {
  constructor(readonly fatal: FatalModelError) {
    super(`call not started: ${fatal.reason}`);
    this.name = "CallSkippedError";
  }
}
