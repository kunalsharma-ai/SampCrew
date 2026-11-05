import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/**
 * Outgoing HTTP for webhooks and connectors. It refuses addresses inside private networks (unless the
 * installation allows them, for local development and tests), checks the address actually connected to rather
 * than only the name (so DNS rebinding cannot slip past), never follows redirects, times out, and keeps only the
 * first 2 KB of the response.
 */

export class UnsafeUrlError extends Error {}

const v4ToInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const inV4 = (ip: string, cidr: string) => {
  const [base, bits] = cidr.split('/') as [string, string];
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
};
const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'];

/** True for loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((c) => inV4(ip, c));
  const a = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb') || a.startsWith('ff');
}

export interface SafeHttpOptions { allowPrivate: boolean; timeoutMs?: number; /** Response bytes kept (default 2000). */ maxBytes?: number }
export interface SafeHttpResult { status: number; body: string; durationMs: number }

/** Checks a URL's form before it is saved: http(s), no credentials in it, https unless private addresses are allowed. */
export function checkUrlShape(raw: string, allowPrivate: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'Not a valid address';
  }
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) return 'Use an https:// address';
  if (u.username || u.password) return 'Do not put a user name or password in the address';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isPrivateAddress(host)))) return 'Private and local network addresses are not allowed';
  return null;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A DNS lookup for http(s).request that refuses names resolving to private addresses (checked at connect time). */
export function safeLookup(allowPrivate: boolean) {
  return (hostname: string, options: object, cb: LookupCb) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '', 4);
      const list = addresses as LookupAddress[];
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return cb(Object.assign(new UnsafeUrlError(`${hostname} points to a private network address`), { code: 'EUNSAFE' }), '', 4);
      }
      // Node asks for all addresses when autoSelectFamily is on; otherwise it expects one.
      if ((options as { all?: boolean }).all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

export function postJson(url: string, body: string, headers: Record<string, string>, opts: SafeHttpOptions): Promise<SafeHttpResult> {
  return safeRequest('POST', url, body, { 'content-type': 'application/json', ...headers }, opts);
}

/** Any method; `body` undefined sends none. Same protections as postJson. */
export function safeRequest(method: 'GET' | 'POST', url: string, body: string | undefined, headers: Record<string, string>, opts: SafeHttpOptions): Promise<SafeHttpResult> {
  const u = new URL(url);
  const shape = checkUrlShape(url, opts.allowPrivate);
  if (shape) return Promise.reject(new UnsafeUrlError(shape));
  const client = u.protocol === 'https:' ? https : http;
  const started = Date.now();
  const lookup = safeLookup(opts.allowPrivate);
  const max = opts.maxBytes ?? 2000;
  return new Promise((resolve, reject) => {
    const req = client.request(
      u,
      { method, headers: { ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body).toString() }), ...headers }, lookup: lookup as never, timeout: opts.timeoutMs ?? 10_000 },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (out.length < max) out += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out.slice(0, max), durationMs: Date.now() - started }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`No response within ${Math.round((opts.timeoutMs ?? 10_000) / 1000)} seconds`)));
    req.on('error', (err) => reject(err));
    req.end(body ?? undefined);
  });
}
