// Serve a frozen LITMUS edition (a mirrored copy of a deployed build) locally,
// for filming and for rating articles, with the SPA fallback the live Pages
// site has. No network, no build, no database.
//
//   node scripts/serve-frozen-edition.mjs [dir] [--port=5190]
//
// Frozen editions live OUTSIDE this repo (Max, 2026-09-26), in iCloud Drive
// under LITMUS/; the default is the 2026-09-21 edition kept for filming.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const dir = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? path.join(process.env.HOME ?? "", "Library/Mobile Documents/com~apple~CloudDocs/LITMUS/frozen-edition-2026-09-21"));
const port = Number((process.argv.find((a) => a.startsWith("--port=")) ?? "--port=5190").slice(7));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file = path.join(dir, urlPath);
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    file = path.extname(urlPath) ? "" : path.join(dir, "index.html");
  }
  if (!file) { res.writeHead(404).end("not found"); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
}).listen(port, "127.0.0.1", () => console.log(`frozen edition ${dir} on http://127.0.0.1:${port}/`));
