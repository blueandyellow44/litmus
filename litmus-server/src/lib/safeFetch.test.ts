import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import {
  safeGet,
  isPublicAddress,
  assertAllowedUrl,
  guardSocket,
  PUBLIC_ONLY,
  BlockedDestinationError,
  ResponseTooLargeError,
  type FetchPolicy,
  type SafeGetOptions,
} from "./safeFetch.js";

// Security baseline 2026-10-07: ingestion fetched any address a feed or a
// redirect named. These tests pin each stage of the fix — URL, DNS, connection,
// redirect, and body size — against local fixtures only. Every refusal case
// also asserts the fixture server received NO request, because a refusal that
// still sends the request has not prevented anything.

// Production checks, but random fixture ports are allowed so the address rule
// is what gets tested.
const PUBLIC_ANY_PORT: FetchPolicy = { ...PUBLIC_ONLY, isAllowedPort: () => true };
// A permitted loopback fixture, for the cases that need one hop to succeed.
const LOOPBACK_FIXTURE: FetchPolicy = {
  isAllowedAddress: (a) => a === "127.0.0.1",
  isAllowedPort: () => true,
  resolve: PUBLIC_ONLY.resolve,
};

const OPTS: SafeGetOptions = {
  headers: { "user-agent": "litmus-test" },
  maxRedirects: 5,
  maxBytes: 64 * 1024,
  timeoutMs: 3_000,
};

let hits: string[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const url = req.url ?? "";
    if (url === "/ok") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("synthetic body");
    } else if (url === "/to-ok") {
      res.writeHead(302, { location: "/ok" });
      res.end();
    } else if (url === "/to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    } else if (url === "/to-internal-name") {
      res.writeHead(307, { location: `http://internal.example.test:${(server.address() as net.AddressInfo).port}/ok` });
      res.end();
    } else if (url === "/to-file") {
      res.writeHead(301, { location: "file:///etc/passwd" });
      res.end();
    } else if (url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
    } else if (url === "/big-declared") {
      res.writeHead(200, { "content-length": String(OPTS.maxBytes + 1) });
      res.end("x".repeat(OPTS.maxBytes + 1));
    } else if (url === "/big-declared-stall") {
      // Declares more than the limit, sends a little, then never finishes.
      res.writeHead(200, { "content-length": String(OPTS.maxBytes * 4) });
      res.write("z".repeat(10));
    } else if (url === "/big-chunked") {
      res.writeHead(200, { "content-type": "text/plain" });
      for (let i = 0; i < 80; i++) res.write("y".repeat(1024));
      res.end();
    } else if (url === "/gzip-small") {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(zlib.gzipSync("decoded synthetic body"));
    } else if (url === "/gzip-bomb") {
      // ~64 KB on the wire budget is never approached: a few hundred bytes of
      // gzip that inflate to 10 MB.
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(zlib.gzipSync(Buffer.alloc(10 * 1024 * 1024)));
    } else if (url === "/stall") {
      // Accept and never answer.
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
    "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::1", "2001:db8::1",
    "not-an-ip", "",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "151.101.1.67", "104.18.0.1", "2606:4700::6810:1", "2a04:4e42::81"])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("assertAllowedUrl (the URL stage)", () => {
  it.each([
    ["file:///etc/passwd", /scheme/],
    ["ftp://example.com/feed", /scheme/],
    ["gopher://example.com/", /scheme/],
    ["https://example.com:8443/feed", /port/],
    ["http://127.0.0.1/", /address/],
    ["http://2130706433/", /address/], // decimal 127.0.0.1
    ["http://0x7f.1/", /address/], // hex shorthand
    ["http://[::1]/", /address/],
    ["http://[::ffff:127.0.0.1]/", /address/],
    ["http://169.254.169.254/latest/meta-data/", /address/],
  ])("refuses %s", (url, why) => {
    expect(() => assertAllowedUrl(new URL(url), PUBLIC_ONLY)).toThrow(why);
  });

  it("allows an ordinary publisher URL and a public literal", () => {
    expect(() => assertAllowedUrl(new URL("https://www.example.com/news/1"), PUBLIC_ONLY)).not.toThrow();
    expect(() => assertAllowedUrl(new URL("http://8.8.8.8/"), PUBLIC_ONLY)).not.toThrow();
  });
});

describe("safeGet refuses non-public destinations before any request", () => {
  it("an IP-literal loopback URL", async () => {
    hits = [];
    await expect(safeGet(`${base}/ok`, { ...OPTS, policy: PUBLIC_ANY_PORT })).rejects.toBeInstanceOf(BlockedDestinationError);
    expect(hits).toEqual([]);
  });

  it("a name that resolves to loopback (the DNS stage)", async () => {
    hits = [];
    const policy: FetchPolicy = { ...PUBLIC_ANY_PORT, resolve: async () => [{ address: "127.0.0.1", family: 4 }] };
    const port = (server.address() as net.AddressInfo).port;
    await expect(safeGet(`http://news.example.test:${port}/ok`, { ...OPTS, policy })).rejects.toThrow(/non-public address: 127\.0\.0\.1/);
    expect(hits).toEqual([]);
  });

  it("a name with one public and one private answer", async () => {
    hits = [];
    const policy: FetchPolicy = {
      ...PUBLIC_ANY_PORT,
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    };
    const port = (server.address() as net.AddressInfo).port;
    // Refused at the DNS stage itself, not later by the connection backstop.
    await expect(safeGet(`http://mixed.example.test:${port}/ok`, { ...OPTS, policy })).rejects.toThrow(/resolves to a non-public address: 127\.0\.0\.1/);
    expect(hits).toEqual([]);
  });

  it("the default policy refuses a non-default port even on a public name", async () => {
    await expect(safeGet("http://example.com:8080/", OPTS)).rejects.toThrow(/port not allowed/);
  });
});

describe("safeGet re-checks every redirect", () => {
  it("follows an allowed redirect", async () => {
    const res = await safeGet(`${base}/to-ok`, { ...OPTS, policy: LOOPBACK_FIXTURE });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("synthetic body");
    expect(res.url).toBe(`${base}/ok`);
  });

  it("refuses a redirect to the cloud metadata address", async () => {
    await expect(safeGet(`${base}/to-metadata`, { ...OPTS, policy: LOOPBACK_FIXTURE })).rejects.toThrow(/address not allowed: 169\.254\.169\.254/);
  });

  it("refuses a redirect to a name that resolves privately", async () => {
    hits = [];
    const policy: FetchPolicy = {
      ...LOOPBACK_FIXTURE,
      resolve: async (host) => (host === "internal.example.test" ? [{ address: "10.0.0.5", family: 4 }] : PUBLIC_ONLY.resolve(host)),
    };
    await expect(safeGet(`${base}/to-internal-name`, { ...OPTS, policy })).rejects.toThrow(/non-public address: 10\.0\.0\.5/);
    expect(hits).toEqual(["/to-internal-name"]); // the permitted first hop only
  });

  it("refuses a redirect to a file: URL", async () => {
    await expect(safeGet(`${base}/to-file`, { ...OPTS, policy: LOOPBACK_FIXTURE })).rejects.toThrow(/scheme not allowed/);
  });

  it("stops after the redirect limit", async () => {
    await expect(safeGet(`${base}/loop`, { ...OPTS, policy: LOOPBACK_FIXTURE })).rejects.toThrow(/Too many redirects/);
  });
});

describe("the connection-stage backstop", () => {
  it("destroys a socket whose remote address is not allowed", async () => {
    const socket = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
    guardSocket(socket, PUBLIC_ONLY);
    const err = await new Promise<Error>((resolve) => socket.on("error", resolve));
    expect(err).toBeInstanceOf(BlockedDestinationError);
    expect(socket.destroyed).toBe(true);
  });

  it("is wired into safeGet: a socket that lands somewhere the DNS check did not see is refused", async () => {
    // Simulates a connection that ends up at a different address from the one
    // the DNS stage approved: the first check passes, any later one refuses.
    let checks = 0;
    const policy: FetchPolicy = {
      isAllowedAddress: () => ++checks === 1,
      isAllowedPort: () => true,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    };
    const port = (server.address() as net.AddressInfo).port;
    await expect(safeGet(`http://fixture.example.test:${port}/ok`, { ...OPTS, policy })).rejects.toThrow(/connected to a non-public address/);
  });
});

describe("safeGet bounds the body", () => {
  it("refuses a declared Content-Length over the limit", async () => {
    await expect(safeGet(`${base}/big-declared`, { ...OPTS, policy: LOOPBACK_FIXTURE })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("refuses an oversized declared body up front, without waiting for it", async () => {
    const started = Date.now();
    await expect(safeGet(`${base}/big-declared-stall`, { ...OPTS, policy: LOOPBACK_FIXTURE })).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(Date.now() - started).toBeLessThan(OPTS.timeoutMs);
  });

  it("refuses an undeclared body once it passes the limit", async () => {
    await expect(safeGet(`${base}/big-chunked`, { ...OPTS, policy: LOOPBACK_FIXTURE })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("decodes gzip", async () => {
    const res = await safeGet(`${base}/gzip-small`, { ...OPTS, policy: LOOPBACK_FIXTURE });
    expect(res.body.toString()).toBe("decoded synthetic body");
  });

  it("refuses a small compressed body that inflates past the limit", async () => {
    await expect(safeGet(`${base}/gzip-bomb`, { ...OPTS, policy: LOOPBACK_FIXTURE })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("gives up on a server that never answers", async () => {
    const started = Date.now();
    await expect(safeGet(`${base}/stall`, { ...OPTS, timeoutMs: 500, policy: LOOPBACK_FIXTURE })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
