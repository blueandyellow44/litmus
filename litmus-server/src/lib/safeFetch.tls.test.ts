import { describe, it, expect, beforeAll, afterAll } from "vitest";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeGet, PUBLIC_ONLY, type FetchPolicy } from "./safeFetch.js";

// safeFetch must resume TLS sessions across requests, as the libraries' own
// fetching did. CNN answered every fresh handshake with 403 and every resumed
// session normally (2026-10-07); a version of safeFetch that built a new agent
// per request lost an article that way, and no test noticed. This one would.

const LOOPBACK_FIXTURE: FetchPolicy = {
  isAllowedAddress: (a) => a === "127.0.0.1",
  isAllowedPort: () => true,
  resolve: PUBLIC_ONLY.resolve,
};

let server: https.Server;
let base: string;
let certDir: string;
let savedTlsSetting: string | undefined;
const resumed: boolean[] = [];

beforeAll(async () => {
  // A throwaway self-signed pair, as in ingestion/rssPoller.redirect.test.ts.
  certDir = await mkdtemp(path.join(tmpdir(), "litmus-tls-resume-"));
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  savedTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  server = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (_req, res) => {
    res.end("synthetic");
  });
  server.on("secureConnection", (socket) => resumed.push(socket.isSessionReused()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `https://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (savedTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsSetting;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(certDir, { recursive: true, force: true });
});

describe("safeGet over TLS", () => {
  it("resumes the TLS session on a later request, on a new connection", async () => {
    const opts = { headers: {}, maxRedirects: 0, maxBytes: 1024, timeoutMs: 5_000, policy: LOOPBACK_FIXTURE };
    for (let i = 0; i < 3; i++) {
      const res = await safeGet(`${base}/a${i}`, opts);
      expect(res.body.toString()).toBe("synthetic");
    }
    expect(resumed).toHaveLength(3); // three connections: keep-alive stays off
    expect(resumed[0]).toBe(false);
    expect(resumed.slice(1)).toContain(true);
  });
});
