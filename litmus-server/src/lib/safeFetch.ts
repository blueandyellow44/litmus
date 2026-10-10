import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";

// The one way ingestion reads the network: feeds and article pages both come
// through here, so a URL handed over by a feed can only ever reach the public
// internet.
//
// Why this exists (security baseline, 2026-10-07): a feed entry's link, or a
// redirect from a publisher, was fetched wherever it pointed. A loopback URL and
// a redirect into one were both reproduced with synthetic local pages. Anyone
// who controlled one configured feed, or one redirect a publisher issues, could
// point the ingest runner at its own machine or the cloud runner's private
// network. Following OWASP's SSRF guidance, the destination is checked at every
// stage that can change it:
//
//   1. the URL: http or https only, default port only, and an IP-literal host
//      must be a public address;
//   2. DNS: every address a name resolves to must be public, and the connection
//      is made to exactly those addresses (the check and the connect use the
//      same answer, so a second, different DNS answer cannot slip in);
//   3. the connection: the socket's actual remote address is checked again on
//      connect, as a backstop for any path that skipped 1 or 2;
//   4. every redirect: followed by hand, and each hop goes through 1 to 3.
//
// Response bodies are bounded both on the wire and after decompression, so a
// hostile or broken server cannot exhaust the runner's memory.
//
// Requests go through two agents this module owns, one per protocol, with
// keep-alive off. Node's global agents keep sockets alive, and those sockets held
// the ingest process open until the job timeout (fixed 2026-08-10, see
// scripts/check-no-socket-leak.mjs). The agents are shared rather than made per
// request because a shared agent keeps TLS sessions: CNN answered every fresh TLS
// handshake with 403 (4 of 4) and every resumed session normally (3 of 3,
// measured 2026-10-07), which is how the libraries' own fetching always behaved. Keep-alive
// off means no socket is ever reused, so one request's destination check can
// never be inherited by another.
const HTTP_AGENT = new http.Agent({ keepAlive: false });
const HTTPS_AGENT = new https.Agent({ keepAlive: false });

export class BlockedDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedDestinationError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`response exceeded ${limit} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

// Every range that is not the public internet. IPv4 from the IANA special-
// purpose registry; IPv6 likewise, plus the transition ranges that embed an
// IPv4 address (mapped, NAT64, 6to4, Teredo) because they can carry a private
// one. Publishers do not serve news from any of these.
//
// One list per family on purpose: a BlockList matches IPv4 addresses against
// IPv6 rules through the mapped range, so a single list holding ::ffff:0:0/96
// would refuse every IPv4 address there is.
const NON_PUBLIC_V4 = new net.BlockList();
const NON_PUBLIC_V6 = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
] as const) {
  NON_PUBLIC_V4.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  NON_PUBLIC_V6.addSubnet(prefix, bits, "ipv6");
}

/** True only for an address on the public internet. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, "ipv4");
  if (family === 6) {
    // Global unicast is 2000::/3; everything outside it is reserved or local.
    const first = parseInt(address.split(":")[0] || "0", 16);
    if (!(first >= 0x2000 && first <= 0x3fff)) return false;
    return !NON_PUBLIC_V6.check(address, "ipv6");
  }
  return false;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Where a request may go. Production always uses PUBLIC_ONLY. Tests that need
 * a loopback fixture build their own policy and pass it in explicitly; there is
 * deliberately no environment variable or global switch that could loosen this
 * in a deployed run.
 */
export interface FetchPolicy {
  isAllowedAddress(address: string): boolean;
  /** `port` is "" when the URL uses its scheme's default port. */
  isAllowedPort(protocol: string, port: string): boolean;
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

async function resolveAll(hostname: string): Promise<ResolvedAddress[]> {
  const found = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

export const PUBLIC_ONLY: FetchPolicy = Object.freeze({
  isAllowedAddress: isPublicAddress,
  // Publishers serve feeds and pages on 80 and 443; nothing in the roster uses
  // another port, and an unusual port is how internal services are reached.
  isAllowedPort: (protocol: string, port: string) => port === "" || port === DEFAULT_PORTS[protocol],
  resolve: resolveAll,
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Throws unless the URL may be requested under the policy. Exported for tests. */
export function assertAllowedUrl(url: URL, policy: FetchPolicy): void {
  if (!DEFAULT_PORTS[url.protocol]) throw new BlockedDestinationError(`scheme not allowed: ${url.protocol}`);
  if (!policy.isAllowedPort(url.protocol, url.port)) {
    throw new BlockedDestinationError(`port not allowed: ${url.port}`);
  }
  // WHATWG parsing has already normalised decimal, octal and hex IPv4 forms to
  // dotted quads; IPv6 literals keep their brackets in .hostname.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !policy.isAllowedAddress(host)) {
    throw new BlockedDestinationError(`address not allowed: ${host}`);
  }
}

// Node's `lookup` hook for http.request: resolve, refuse the whole name if ANY
// answer is non-public (a name that mixes public and private answers is either
// misconfigured or an attack), and hand back exactly the checked answers.
function guardedLookup(policy: FetchPolicy): net.LookupFunction {
  return (hostname, options, callback) => {
    policy.resolve(hostname).then(
      (all) => {
        const wanted = options.family === 4 || options.family === 6 ? all.filter((a) => a.family === options.family) : all;
        const refused = wanted.find((a) => !policy.isAllowedAddress(a.address));
        if (refused) {
          callback(new BlockedDestinationError(`${hostname} resolves to a non-public address: ${refused.address}`), "", 4);
          return;
        }
        if (wanted.length === 0) {
          const err = Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" });
          callback(err, "", 4);
          return;
        }
        if (options.all) {
          (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, wanted);
        } else {
          callback(null, wanted[0]!.address, wanted[0]!.family);
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, "", 4),
    );
  };
}

/**
 * The connection-stage backstop: once a socket connects, its real remote
 * address must still be allowed. Exported so a test can exercise it alone.
 */
export function guardSocket(socket: net.Socket, policy: FetchPolicy): void {
  socket.once("connect", () => {
    const remote = socket.remoteAddress;
    if (!remote || !policy.isAllowedAddress(remote)) {
      socket.destroy(new BlockedDestinationError(`connected to a non-public address: ${remote ?? "unknown"}`));
    }
  });
}

function decoderFor(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

// Reads a body into memory, refusing it the moment either the wire bytes or the
// decoded bytes pass the limit. A declared Content-Length over the limit is
// refused before anything is read.
function readBounded(res: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      reject(new ResponseTooLargeError(maxBytes));
      return;
    }
    let wire = 0;
    res.on("data", (chunk: Buffer) => {
      wire += chunk.length;
      if (wire > maxBytes) res.destroy(new ResponseTooLargeError(maxBytes));
    });

    const decoder = decoderFor(res.headers["content-encoding"] as string | undefined);
    const body: Readable = decoder ? res.pipe(decoder) : res;
    if (decoder) res.on("error", (err) => decoder.destroy(err));

    const chunks: Buffer[] = [];
    let decoded = 0;
    body.on("data", (chunk: Buffer) => {
      decoded += chunk.length;
      if (decoded > maxBytes) {
        res.destroy();
        body.destroy(new ResponseTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    body.on("error", reject);
    body.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export interface SafeGetOptions {
  headers: Record<string, string>;
  /** Redirects followed before giving up; every hop is re-checked. */
  maxRedirects: number;
  /** Limit on both wire and decoded body bytes. */
  maxBytes: number;
  /** Deadline for the whole exchange, every redirect included. */
  timeoutMs: number;
  policy?: FetchPolicy;
}

export interface SafeResponse {
  /** The URL the body came from, after redirects. */
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function requestOnce(url: URL, opts: SafeGetOptions, policy: FetchPolicy, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, {
      method: "GET",
      headers: opts.headers,
      agent: url.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT,
      lookup: guardedLookup(policy),
      signal,
    });
    req.on("socket", (socket) => guardSocket(socket, policy));
    req.on("response", resolve);
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET a URL under the fetch policy, following redirects by hand. Resolves with
 * the final status and body for any status, so callers keep their own rules
 * about which statuses count as failure.
 */
export async function safeGet(input: string, opts: SafeGetOptions): Promise<SafeResponse> {
  const policy = opts.policy ?? PUBLIC_ONLY;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = new URL(input);

  for (let hop = 0; ; hop++) {
    assertAllowedUrl(url, policy);
    const res = await requestOnce(url, opts, policy, signal);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (REDIRECT_STATUSES.has(status) && location) {
      res.resume(); // drain and discard the redirect body
      if (hop >= opts.maxRedirects) throw new Error("Too many redirects");
      url = new URL(location, url);
      continue;
    }
    const body = await readBounded(res, opts.maxBytes);
    return { url: url.toString(), status, headers: res.headers, body };
  }
}
