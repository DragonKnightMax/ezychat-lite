// Ported from Enterprise ent-connectors (packages/ent-connectors/src/net.ts), unchanged in behaviour.
//
// Outgoing requests to connector servers (MCP and OAuth): https only, no address on this computer
// or a private network (checked on the IP the request actually connects to, so a DNS answer that
// changes between check and connect cannot slip through), redirects only to the same origin and
// re-checked, a per-request time limit and a response size cap.
//
// TEST ONLY: `allowLoopback` lets tests and Dev Build scripts reach the local connector testkit
// (127.0.0.1 / ::1). It is never set from the UI; see testAllowance() in service.ts.
import { lookup as dnsLookup } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/**
 * Longest a file download may take (`longTransfer`): a file as large as WhatsApp takes (2 GB on a
 * linked phone) at about 1 MB/s. The upload store also stops one that sends nothing for 60 s.
 */
export const LONG_TRANSFER_TIMEOUT_MS = 60 * 60_000;
const MAX_REDIRECTS = 3;

export type UrlProblem = 'url_invalid' | 'url_not_https' | 'url_private';

export interface ResolvedAddress {
  address: string;
  family: number;
}
export type ResolveFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface NetPolicy {
  /** TEST ONLY: allow loopback addresses (the local testkit). Off in every real run. */
  allowLoopback: boolean;
  /** TEST ONLY: extra trusted CA (PEM) for the testkit's self-signed certificate. */
  ca?: string;
  /** DNS resolver (tests replace it to simulate rebinding). Default: the system resolver. */
  resolve?: ResolveFn;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * A file download (MCP send links): `timeoutMs` may go up to LONG_TRANSFER_TIMEOUT_MS instead of
   * REQUEST_TIMEOUT_MS. Connector calls never set it.
   */
  longTransfer?: boolean;
}

/** What the last request of one client saw; used to tell "needs sign-in" from "can't reach". */
export class NetProbe {
  lastStatus: number | null = null;
  wwwAuthenticate: string | null = null;
  blocked = false;
  networkError = false;
  tooLarge = false;
  timedOut = false;
}

export class BlockedAddressError extends Error {
  readonly code = 'url_private';
  constructor() {
    super('address not allowed');
    this.name = 'BlockedAddressError';
  }
}
export class ResponseTooLargeError extends Error {
  constructor() {
    super('response too large');
    this.name = 'ResponseTooLargeError';
  }
}

// --- address rules ----------------------------------------------------------------------------

const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedV4.addSubnet(net, prefix, 'ipv4');

const loopbackV4 = new BlockList();
loopbackV4.addSubnet('127.0.0.0', 8, 'ipv4');

/** Eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(raw: string): number[] | null {
  let s = raw.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  // An embedded dotted quad (::ffff:1.2.3.4) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = dotted[1]!.split('.').map(Number);
    s =
      s.slice(0, -dotted[1]!.length) +
      (((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16));
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Is this IP address one a connector may never reach? (`allowLoopback` is test-only.) */
export function isBlockedIp(address: string, allowLoopback = false): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    if (allowLoopback && loopbackV4.check(address, 'ipv4')) return false;
    return blockedV4.check(address, 'ipv4');
  }
  const g = ipv6Groups(address);
  if (!g) return true;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true; // ::
  if (zeros(7) && g[7] === 1) return !allowLoopback; // ::1
  if (zeros(5) && g[5] === 0xffff) return isBlockedIp(v4FromGroups(g[6]!, g[7]!), allowLoopback);
  if (zeros(6)) return true; // IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return isBlockedIp(v4FromGroups(g[6]!, g[7]!), false); // NAT64
  if (g[0] === 0x2002) return isBlockedIp(v4FromGroups(g[1]!, g[2]!), false); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Host names that only work in an office network or on this computer. */
function privateName(host: string, allowLoopback: boolean): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return !allowLoopback;
  return (
    !host.includes('.') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host.endsWith('.home') ||
    host.endsWith('.home.arpa') ||
    host.endsWith('.corp') ||
    host.endsWith('.intranet')
  );
}

function bareHost(url: URL): string {
  const h = url.hostname.toLowerCase().replace(/\.+$/, '');
  return h.startsWith('[') ? h.slice(1, -1) : h;
}

/** Why a connector link may not be used (before any network access), or null. */
export function connectorUrlProblem(raw: string, allowLoopback = false): UrlProblem | null {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 2000) return 'url_invalid';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'url_invalid';
  }
  if (url.protocol === 'http:') return 'url_not_https';
  if (url.protocol !== 'https:') return 'url_invalid';
  if (url.username || url.password) return 'url_invalid';
  const host = bareHost(url);
  if (!host) return 'url_invalid';
  if (isIP(host)) return isBlockedIp(host, allowLoopback) ? 'url_private' : null;
  return privateName(host, allowLoopback) ? 'url_private' : null;
}

// --- guarded fetch ----------------------------------------------------------------------------

const systemResolve: ResolveFn = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    ),
  );

/**
 * net.connect lookup: resolves, refuses the whole name if any answer is blocked, and hands the
 * checked address to the socket (the socket never resolves again).
 */
function guardedLookup(policy: NetPolicy, probe: NetProbe): LookupFunction {
  const resolve = policy.resolve ?? systemResolve;
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((answers) => {
        if (answers.length === 0)
          throw Object.assign(new Error('no address'), { code: 'ENOTFOUND' });
        if (answers.some((a) => isBlockedIp(a.address, policy.allowLoopback))) {
          probe.blocked = true;
          throw new BlockedAddressError();
        }
        const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
        const usable = answers.filter((a) => !wanted || a.family === wanted);
        if (usable.length === 0)
          throw Object.assign(new Error('no address'), { code: 'ENOTFOUND' });
        if (options.all) callback(null, usable);
        else callback(null, usable[0]!.address, usable[0]!.family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, '', 0));
  };
}

function bodyBuffer(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  throw new TypeError('unsupported request body');
}

function toHeaders(res: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
    else if (v !== undefined) h.set(k, v);
  }
  return h;
}

/**
 * A fetch for connector traffic. Never uses a proxy or the global fetch; every hop is checked.
 * `probe` records what happened (status, blocked, network error), never headers or bodies.
 */
export function guardedFetch(policy: NetPolicy, probe = new NetProbe()): typeof fetch {
  const cap = policy.longTransfer ? LONG_TRANSFER_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const timeoutMs = Math.min(policy.timeoutMs ?? REQUEST_TIMEOUT_MS, cap);
  const maxBytes = policy.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  const once = (url: URL, init: RequestInit, hops: number): Promise<Response> => {
    const problem = connectorUrlProblem(url.href, policy.allowLoopback);
    if (problem) {
      if (problem === 'url_private') probe.blocked = true;
      return Promise.reject(
        problem === 'url_private' ? new BlockedAddressError() : new TypeError(problem),
      );
    }
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = bodyBuffer(init.body);
    if (body && !headers.has('content-type') && init.body instanceof URLSearchParams)
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    headers.delete('accept-encoding');
    if (body) headers.set('content-length', String(body.length));
    const host = bareHost(url);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

    return new Promise<Response>((resolve, reject) => {
      if (signal.aborted) {
        if (timeout.aborted) probe.timedOut = true;
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      const req = httpsRequest({
        protocol: 'https:',
        hostname: host,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: Object.fromEntries(headers),
        lookup: guardedLookup(policy, probe),
        servername: isIP(host) ? undefined : host,
        agent: false,
        ...(policy.ca ? { ca: policy.ca } : {}),
      });
      let settled = false;
      const onAbort = () => {
        if (timeout.aborted) probe.timedOut = true;
        req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => signal.removeEventListener('abort', onAbort);

      req.on('error', (err) => {
        if (!(err instanceof BlockedAddressError)) probe.networkError = true;
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });
      req.on('response', (res) => {
        settled = true;
        const status = res.statusCode ?? 502;
        probe.lastStatus = status;
        probe.wwwAuthenticate = status === 401 ? (res.headers['www-authenticate'] ?? null) : null;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          cleanup();
          const mode = init.redirect ?? 'follow';
          if (mode === 'manual') {
            resolve(new Response(null, { status, headers: toHeaders(res) }));
            return;
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            reject(new TypeError('redirect refused'));
            return;
          }
          if (mode === 'error' || next.origin !== url.origin || hops >= MAX_REDIRECTS) {
            reject(new TypeError('redirect refused'));
            return;
          }
          const asGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
          const nextInit: RequestInit = asGet ? { ...init, method: 'GET', body: undefined } : init;
          resolve(once(next, nextInit, hops + 1));
          return;
        }
        const noBody = status === 204 || status === 304 || method === 'HEAD';
        if (noBody) {
          res.resume();
          cleanup();
          resolve(new Response(null, { status, headers: toHeaders(res) }));
          return;
        }
        let total = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => {
              total += chunk.length;
              if (total > maxBytes) {
                probe.tooLarge = true;
                controller.error(new ResponseTooLargeError());
                res.destroy();
                cleanup();
                return;
              }
              controller.enqueue(new Uint8Array(chunk));
            });
            res.on('end', () => {
              cleanup();
              try {
                controller.close();
              } catch {
                // already errored
              }
            });
            res.on('error', (err) => {
              cleanup();
              probe.networkError = true;
              try {
                controller.error(err);
              } catch {
                // already closed
              }
            });
          },
          cancel() {
            cleanup();
            res.destroy();
          },
        });
        resolve(new Response(stream, { status, headers: toHeaders(res) }));
      });
      req.end(body);
    });
  };

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return once(new URL(href), init ?? {}, 0);
  }) as typeof fetch;
}
