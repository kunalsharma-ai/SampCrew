import 'server-only';
import { headers as requestHeaders } from 'next/headers';
import { redirect } from 'next/navigation';
import { accessToken } from './session';

const API_URL = process.env.CREW_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    /** True when the request carried the user's session token, so a 401 means that session has ended. */
    public sessionRequest = false,
  ) {
    super(message);
  }
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries((this.details as { path: string; message: string }[]).map((d) => [d.path, d.message]));
  }
}

/**
 * The visitor's address, so the API's per-address rate limits apply to each visitor rather than to this web
 * server. Takes the right-most X-Forwarded-For entry, which is the one added by the proxy in front of the web
 * app (entries further left come from the client and can be forged).
 */
async function clientIp(): Promise<Record<string, string>> {
  try {
    const h = await requestHeaders();
    const ip = h.get('x-forwarded-for')?.split(',').pop()?.trim() || h.get('x-real-ip')?.trim();
    return ip && /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? { 'x-forwarded-for': ip } : {};
  } catch {
    return {}; // outside a request (build time)
  }
}

/** Server-side call to the CREW API with the signed-in user's bearer token. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; auth?: boolean; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-crew-client': 'web', ...(await clientIp()) };
  let sessionRequest = false;
  if (init.auth !== false) {
    const token = await accessToken();
    if (token) headers.authorization = `Bearer ${token}`;
    sessionRequest = Boolean(token);
  }
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await fetch(`${API_URL}/api/v1${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: 'no-store' });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (json as { error?: { code: string; message: string; details?: unknown } }).error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details, sessionRequest);
  }
  return json as T;
}

/** Multipart upload (documents). The browser never talks to the API directly; this runs on the server. */
export async function apiForm<T = unknown>(path: string, form: FormData, opts: { auth?: boolean } = {}): Promise<T> {
  const token = opts.auth === false ? undefined : await accessToken();
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method: 'POST',
    headers: { 'x-crew-client': 'web', ...(await clientIp()), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: form,
    cache: 'no-store',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (json as { error?: { code: string; message: string; details?: unknown } }).error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Upload failed (${res.status})`, e?.details, Boolean(token));
  }
  return json as T;
}

/** Fetches an API path without auth and returns the raw response (used to stream signed file downloads). */
export function apiRaw(path: string) {
  return fetch(`${API_URL}${path}`, { cache: 'no-store' });
}

/**
 * For server components: an ended session sends the user to sign in, and a missing permission, plan feature or
 * MFA step shows the "no access" page with the reason instead of an error.
 */
export async function load<T>(path: string): Promise<T> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect('/login?expired=1');
    if (e instanceof ApiError && (e.status === 402 || e.status === 403)) redirect(`/no-access?reason=${encodeURIComponent(e.code)}`);
    throw e;
  }
}

/** Like load(), but returns null instead of throwing when the user lacks permission or the plan lacks the feature. */
export async function loadOptional<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect('/login?expired=1');
    if (e instanceof ApiError && [402, 403, 404].includes(e.status)) return null;
    throw e;
  }
}

export type ActionResult<T = unknown> = { ok: true; data?: T; message?: string } | { ok: false; message: string; code?: string; fieldErrors?: Record<string, string> };

/** Wraps a mutation for server actions, converting API errors into form-friendly results. */
export async function act<T>(fn: () => Promise<T>, success?: string): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data, message: success };
  } catch (e) {
    if (e instanceof ApiError) {
      // A 401 on a public call (wrong password, wrong MFA code) is a form error, not an ended session.
      if (e.status === 401 && e.sessionRequest) redirect('/login?expired=1');
      return { ok: false, message: e.message, code: e.code, fieldErrors: e.fieldErrors };
    }
    throw e;
  }
}
