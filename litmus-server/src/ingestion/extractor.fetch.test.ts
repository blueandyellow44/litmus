import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import { extractArticle } from "./extractor.js";
import { itemUrl } from "./feedItem.js";
import { PUBLIC_ONLY, type FetchPolicy } from "../lib/safeFetch.js";

// The security baseline's reproduction (2026-10-07), kept as a regression test:
// a feed entry linking to a loopback page, directly or by redirect, was fetched
// and its text stored as the article. Under the production policy it must fall
// back to the feed text without the page ever being requested. The publisher
// path itself must keep working, including the AMP fallback.

const LOOPBACK_FIXTURE: FetchPolicy = {
  isAllowedAddress: (a) => a === "127.0.0.1",
  isAllowedPort: () => true,
  resolve: PUBLIC_ONLY.resolve,
};

const PARAGRAPH = "Only synthetic local test data, written for this fixture. ".repeat(40);
function page(canonicalPath: string | null): string {
  const canonical = canonicalPath ? `<link rel="canonical" href="${base}${canonicalPath}">` : "";
  return `<html><head><meta charset="utf-8"><title>Synthetic article</title>${canonical}</head>
<body><article><h1>Synthetic article</h1><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p></article></body></html>`;
}

let hits: string[] = [];
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/private") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page("/private"));
    } else if (req.url === "/redirect") {
      res.writeHead(302, { location: "/private" });
      res.end();
    } else if (req.url === "/news/refused") {
      res.writeHead(403);
      res.end();
    } else if (req.url === "/news/refused/amp/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page("/news/refused"));
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

describe("extractArticle under the production policy", () => {
  it.each(["/private", "/redirect"])("never requests a loopback article URL (%s)", async (path) => {
    hits = [];
    const url = itemUrl({ link: `${base}${path}` });
    expect(url).not.toBeNull(); // the feed stage still accepts it; the fetch stage refuses
    const result = await extractArticle(url!, "<p>Feed summary.</p>");
    expect(result.via).toBe("feed");
    expect(result.text).toBe("Feed summary.");
    expect(hits).toEqual([]);
  });
});

describe("extractArticle on a permitted publisher (fixture policy)", () => {
  it("reads the page, following a redirect", async () => {
    const result = await extractArticle(`${base}/redirect`, "", LOOPBACK_FIXTURE);
    expect(result.via).toBe("publisher");
    expect(result.wordCount).toBeGreaterThan(200);
  });

  it("falls back to the publisher's own AMP page when the article is refused", async () => {
    hits = [];
    const result = await extractArticle(`${base}/news/refused`, "", LOOPBACK_FIXTURE);
    expect(result.via).toBe("publisher");
    expect(result.wordCount).toBeGreaterThan(200);
    expect(hits).toEqual(["/news/refused", "/news/refused/amp/"]);
  });
});
