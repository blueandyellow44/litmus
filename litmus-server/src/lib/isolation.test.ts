import { describe, it, expect, afterEach, vi } from "vitest";
import { isLocalDsn } from "./isolation.js";

// The guard is an allowlist, so the tests that matter are the rejections: a
// host nobody anticipated must fail closed. A detector is untrusted until it is
// observed failing on a known-bad input.
describe("isLocalDsn", () => {
  it("accepts local hosts", () => {
    expect(isLocalDsn("postgres://u:p@localhost:5432/litmus")).toBe(true);
    expect(isLocalDsn("postgres://u:p@127.0.0.1:5432/litmus")).toBe(true);
    expect(isLocalDsn("postgresql://u:p@localhost/litmus")).toBe(true);
    expect(isLocalDsn("host=/tmp/pgsock dbname=litmus")).toBe(true);
  });

  it("rejects remote hosts, including ones no pattern anticipated", () => {
    expect(isLocalDsn("postgres://u:p@ep-cool-name.us-east-2.aws.neon.tech/litmus")).toBe(false);
    expect(isLocalDsn("postgres://u:p@db.example.com:5432/litmus")).toBe(false);
    expect(isLocalDsn("postgres://u:p@10.0.0.7:5432/litmus")).toBe(false);
    expect(isLocalDsn("postgres://u:p@localhost.evil.com/litmus")).toBe(false);
  });

  it("rejects unparseable input rather than guessing", () => {
    expect(isLocalDsn("")).toBe(false);
    expect(isLocalDsn("not a dsn")).toBe(false);
    expect(isLocalDsn("postgres://")).toBe(false);
  });
});

// ISOLATED and FAKE_MODEL are read at module load, so each case re-imports the
// module under a fresh environment. Testing them any other way would test the
// environment this file happened to start in.
async function loadWith(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("./isolation.js");
}

const ISOLATION_VARS = [
  "LITMUS_ISOLATED",
  "ANTHROPIC_FAKE",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
];
const saved = Object.fromEntries(ISOLATION_VARS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ISOLATION_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.resetModules();
});

describe("assertFakeModelIsIsolated", () => {
  it("REFUSES fixtures outside an isolated run", async () => {
    const iso = await loadWith({ ANTHROPIC_FAKE: "1", LITMUS_ISOLATED: undefined });
    expect(() => iso.assertFakeModelIsIsolated()).toThrow(/ANTHROPIC_FAKE=1 without LITMUS_ISOLATED=1/);
  });

  it("refuses when isolation is asked for in a way that is not exactly 1", async () => {
    const iso = await loadWith({ ANTHROPIC_FAKE: "1", LITMUS_ISOLATED: "true" });
    expect(() => iso.assertFakeModelIsIsolated()).toThrow();
  });

  it("allows fixtures inside an isolated run", async () => {
    const iso = await loadWith({ ANTHROPIC_FAKE: "1", LITMUS_ISOLATED: "1" });
    expect(() => iso.assertFakeModelIsIsolated()).not.toThrow();
  });

  it("is silent when fixtures were never requested", async () => {
    const iso = await loadWith({ ANTHROPIC_FAKE: undefined, LITMUS_ISOLATED: undefined });
    expect(() => iso.assertFakeModelIsIsolated()).not.toThrow();
  });
});

// assertIsolatedSnapshotOut and assertIsolatedApiUrl (and their tests) lived
// here until they were found to be dead code: nothing in the server ever
// called them. build-snapshot.mjs is the process that actually writes the
// published snapshot and reads the remote API, and it is a plain node script
// that imports none of this module — so these functions protected nothing,
// while their passing tests implied they did. The real, exercised guard for
// that boundary is scripts/isolation-guard.mjs (positive scratch-root
// containment, not a deny-list), tested in
// scripts/snapshot-writer-guard-test.mjs and scripts/isolation-guards-test.mjs.

// The escape proof. A production-shaped environment inherited from the calling
// shell must not survive into an isolated run: every one of these is refused,
// and refusal is the default rather than something the caller opts into.
describe("inherited production-like environment cannot escape isolation", () => {
  it("refuses a production database and deploy credentials", async () => {
    const iso = await loadWith({
      LITMUS_ISOLATED: "1",
      CLOUDFLARE_API_TOKEN: "cf-token-from-the-parent-shell",
      CLOUDFLARE_ACCOUNT_ID: "73b94d8e92209bdb6b522b18cfdc1122",
    });

    expect(() =>
      iso.assertIsolatedDsn("postgres://u:p@ep-prod.us-east-2.aws.neon.tech/litmus"),
    ).toThrow(/not a local scratch database/);
    expect(() => iso.assertNoDeployCredentials()).toThrow(/deploy credentials are present/);
  });
});
