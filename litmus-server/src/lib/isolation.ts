// Isolation mode. Set LITMUS_ISOLATED=1 to run the funnel against a scratch
// database with fixture model responses, so an experiment cannot touch
// production, cannot spend money, and cannot deploy.
//
// The DSN check is an ALLOWLIST of local hosts, not a denylist of known
// production ones. A new production host that nobody added to a pattern would
// slip through a denylist silently; here it fails closed.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export const ISOLATED = (process.env.LITMUS_ISOLATED ?? "").trim() === "1";
export const FAKE_MODEL = (process.env.ANTHROPIC_FAKE ?? "").trim() === "1";

// ANTHROPIC_FAKE alone used to be enough to serve fixture responses. That meant
// a single stray variable could write fixture scores into whatever database was
// configured — including production — while every log line looked normal.
// Fixtures are a property of an isolated run, so they are only available inside
// one, and asking for them anywhere else is an error rather than a no-op.
export function assertFakeModelIsIsolated(): void {
  if (FAKE_MODEL && !ISOLATED) {
    throw new Error(
      "ANTHROPIC_FAKE=1 without LITMUS_ISOLATED=1. Fixture model responses are only " +
        "available inside an isolated run; outside one they would persist fabricated " +
        "scores to a real database. Set LITMUS_ISOLATED=1 or unset ANTHROPIC_FAKE.",
    );
  }
}

export function isLocalDsn(dsn: string): boolean {
  // Socket-path DSNs (host=/tmp/...) never leave the machine.
  if (dsn.startsWith("postgres://") || dsn.startsWith("postgresql://")) {
    try {
      const host = new URL(dsn).hostname;
      return LOCAL_HOSTS.has(host);
    } catch {
      return false;
    }
  }
  if (/(^|\s)host=\//.test(dsn)) return true;
  return false;
}

export function assertIsolatedDsn(dsn: string): void {
  if (!ISOLATED) return;
  if (!isLocalDsn(dsn)) {
    throw new Error(
      "LITMUS_ISOLATED=1 but DATABASE_URL is not a local scratch database. " +
        "Isolated runs may only write to localhost. Refusing to connect.",
    );
  }
}

// Isolated runs must not carry deploy credentials. Finding them means the run
// was launched from a shell that could publish, which is exactly the accident
// isolation exists to prevent.
export function assertNoDeployCredentials(): void {
  if (!ISOLATED) return;
  const present = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter(
    (k) => (process.env[k] ?? "").trim() !== "",
  );
  if (present.length > 0) {
    throw new Error(
      `LITMUS_ISOLATED=1 but deploy credentials are present in the environment (${present.join(", ")}). ` +
        "Unset them before running an isolated experiment.",
    );
  }
}
