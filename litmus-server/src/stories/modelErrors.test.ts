import { describe, expect, it } from "vitest";
import { FatalModelError, fatalModelErrorReason, isFatalModelError, rethrowIfFatal } from "./modelErrors.js";

// The exact response production got on 2026-09-21 and 2026-09-22.
const USAGE_LIMIT =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."},"request_id":"req_011CfJqs5iSNBmo5LaYzBXn5"}';

const withStatus = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("fatal model errors", () => {
  it("treats the production usage-limit response as fatal, with or without a status field", () => {
    expect(fatalModelErrorReason(new Error(USAGE_LIMIT))).toBe("account usage limit reached");
    expect(fatalModelErrorReason(withStatus(400, USAGE_LIMIT))).toBe("account usage limit reached");
  });

  it("treats a rejected key, a forbidden key, a missing model and a billing problem as fatal", () => {
    expect(isFatalModelError(withStatus(401, "401 invalid x-api-key"))).toBe(true);
    expect(isFatalModelError(withStatus(403, "403 permission_error"))).toBe(true);
    expect(isFatalModelError(withStatus(404, "404 model: claude-haiku-9 not found"))).toBe(true);
    expect(isFatalModelError(new Error("400 Your credit balance is too low"))).toBe(true);
  });

  it("leaves errors a retry can fix to the caller's own fallback", () => {
    expect(isFatalModelError(withStatus(429, "429 rate_limit_error"))).toBe(false);
    expect(isFatalModelError(withStatus(529, "529 overloaded_error"))).toBe(false);
    expect(isFatalModelError(withStatus(500, "500 api_error"))).toBe(false);
    expect(isFatalModelError(withStatus(400, "400 prompt is too long"))).toBe(false);
    expect(isFatalModelError(withStatus(404, "404 not_found_error: batch"))).toBe(false);
    expect(isFatalModelError(new Error("Request timed out."))).toBe(false);
    expect(isFatalModelError("not even an error")).toBe(false);
  });

  it("rethrows fatal errors wrapped once, and returns for the rest", () => {
    expect(() => rethrowIfFatal(new Error(USAGE_LIMIT))).toThrow(FatalModelError);
    const wrapped = new FatalModelError("account usage limit reached", new Error(USAGE_LIMIT));
    try {
      rethrowIfFatal(wrapped);
    } catch (error) {
      expect(error).toBe(wrapped);
    }
    expect(() => rethrowIfFatal(withStatus(429, "429 rate_limit_error"))).not.toThrow();
  });
});
