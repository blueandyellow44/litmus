import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pollFeedDetailed, FEED_TIMEOUT_MS } from "./rssPoller.js";
import { PUBLIC_ONLY, type FetchPolicy } from "../lib/safeFetch.js";
import type { Source } from "../types.js";

// These fixtures live on 127.0.0.1 and random ports, which the production
// policy refuses (that refusal is tested below and in lib/safeFetch.test.ts).
// The fixture policy is passed explicitly; nothing global is loosened.
const LOOPBACK_FIXTURE: FetchPolicy = {
  isAllowedAddress: (address) => address === "127.0.0.1",
  isAllowedPort: () => true,
  resolve: PUBLIC_ONLY.resolve,
};

// The regression this pins: rssPoller used to pick its keep-alive-off agent from
// the feed URL's ORIGINAL scheme, and rss-parser carried that agent through a
// redirect by re-entering parseURL with the new location. An http:// feed that
// 301s to https:// therefore handed an http.Agent to https.get, Node threw
// ERR_INVALID_PROTOCOL, and pollFeed swallowed it — so Fox News and both BBC
// feeds returned zero articles per edition for three weeks while their ledger
// line looked identical to a feed that had published nothing.
//
// The check that originally found this needed the real internet. This one does
// not: a local http server 301s to a local HTTPS server, so it is deterministic
// and runs offline. The scheme change is the whole point — an http-to-http
// redirect does not reproduce the bug.
//
// It asserts ARTICLES, not process exit. Termination was already covered by
// check-no-socket-leak.mjs, and termination is exactly what this bug preserved
// while returning nothing.

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Redirected Feed</title>
  <item>
    <title>First article</title>
    <link>https://example.test/articles/first</link>
    <pubDate>Mon, 01 Sep 2026 12:00:00 GMT</pubDate>
    <description>Body of the first article.</description>
  </item>
  <item>
    <title>Second article</title>
    <link>https://example.test/articles/second</link>
    <pubDate>Mon, 01 Sep 2026 13:00:00 GMT</pubDate>
    <description>Body of the second article.</description>
  </item>
</channel></rss>`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function source(rssUrl: string): Source {
  return { id: 1, name: "Fixture Feed", rssUrl } as Source;
}

describe("pollFeedDetailed across an http -> https redirect", () => {
  let redirectServer: http.Server;
  let tlsServer: https.Server;
  let redirectUrl: string;
  let targetUrl: string;
  let certDir: string;
  let savedTlsSetting: string | undefined;

  beforeAll(async () => {
    // A throwaway self-signed pair for 127.0.0.1, generated here so the repo
    // carries no key material and the fixture cannot expire.
    certDir = await mkdtemp(path.join(tmpdir(), "litmus-tls-"));
    const keyPath = path.join(certDir, "key.pem");
    const certPath = path.join(certDir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });

    // Trusting this one certificate is not possible per-request here: the
    // poller owns its agents by design. Relaxing verification for the duration
    // of this file is the narrowest available scope, and it is restored after.
    savedTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    const tlsPort = await freePort();
    tlsServer = https.createServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/rss+xml" });
        res.end(FEED_XML);
      },
    );
    await new Promise<void>((r) => tlsServer.listen(tlsPort, "127.0.0.1", () => r()));
    targetUrl = `https://127.0.0.1:${tlsPort}/feed.xml`;

    const redirectPort = await freePort();
    redirectServer = http.createServer((_req, res) => {
      res.writeHead(301, { location: targetUrl });
      res.end();
    });
    await new Promise<void>((r) => redirectServer.listen(redirectPort, "127.0.0.1", () => r()));
    redirectUrl = `http://127.0.0.1:${redirectPort}/feed.xml`;
  }, 60_000);

  afterAll(async () => {
    if (savedTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsSetting;
    await new Promise<void>((r) => redirectServer.close(() => r()));
    await new Promise<void>((r) => tlsServer.close(() => r()));
    await rm(certDir, { recursive: true, force: true });
  });

  it("returns the ARTICLES from the redirect target, not merely an empty success", async () => {
    const r = await pollFeedDetailed(source(redirectUrl), LOOPBACK_FIXTURE);
    expect(r.error).toBeNull();
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.title).toBe("First article");
    expect(r.items[0]!.url).toBe("https://example.test/articles/first");
  });

  it("reports the resolved https URL so the seed can be corrected", async () => {
    const r = await pollFeedDetailed(source(redirectUrl), LOOPBACK_FIXTURE);
    expect(r.resolvedUrl).toBe(targetUrl);
  });

  it("counts nothing as dropped for a well-formed feed", async () => {
    const r = await pollFeedDetailed(source(redirectUrl), LOOPBACK_FIXTURE);
    expect(r.entries).toBe(2);
    expect(r.dropped["no-url"]).toBe(0);
    expect(r.dropped["no-title"]).toBe(0);
  });

  it("leaves no open handles behind", async () => {
    const before = process.getActiveResourcesInfo().filter((h) => h === "TCPWRAP").length;
    await pollFeedDetailed(source(redirectUrl), LOOPBACK_FIXTURE);
    await new Promise((r) => setTimeout(r, 250));
    const after = process.getActiveResourcesInfo().filter((h) => h === "TCPWRAP").length;
    // The fixture servers themselves are listening handles, so the assertion is
    // that polling does not ACCUMULATE sockets, not that the count is zero.
    expect(after).toBeLessThanOrEqual(before + 1);
  });
});

describe("pollFeedDetailed on an unreachable feed", () => {
  it("reports an error rather than an empty feed, and does not hang", async () => {
    const port = await freePort(); // nothing is listening here
    const started = Date.now();
    const r = await pollFeedDetailed(source(`http://127.0.0.1:${port}/feed.xml`), LOOPBACK_FIXTURE);
    expect(r.items).toHaveLength(0);
    expect(r.error).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(FEED_TIMEOUT_MS);
  });
});

describe("the feed fetch is bounded", () => {
  it("has an explicit timeout, so one stalled server cannot hang the whole ingest", () => {
    expect(FEED_TIMEOUT_MS).toBeGreaterThan(0);
    expect(FEED_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

// Security baseline 2026-10-07: a feed URL, or a redirect from one, that points
// at a private address must never be requested.
describe("pollFeedDetailed under the production policy", () => {
  let hits = 0;
  let server: http.Server;
  let feedUrl: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(FEED_XML);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    feedUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/feed.xml`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("refuses a loopback feed without sending it a request", async () => {
    const r = await pollFeedDetailed(source(feedUrl));
    expect(r.items).toHaveLength(0);
    expect(r.error).toMatch(/not allowed/);
    expect(hits).toBe(0);
  });

  it("refuses a feed whose redirect points at a private address", async () => {
    const redirector = http.createServer((_req, res) => {
      res.writeHead(301, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(redirector.address() as net.AddressInfo).port}/feed.xml`;
    try {
      // The first hop is a permitted fixture; only the redirect target is refused.
      const r = await pollFeedDetailed(source(url), LOOPBACK_FIXTURE);
      expect(r.items).toHaveLength(0);
      expect(r.error).toMatch(/address not allowed: 169\.254\.169\.254/);
    } finally {
      await new Promise<void>((r) => redirector.close(() => r()));
    }
  });
});
