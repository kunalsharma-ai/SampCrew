import 'server-only';
import { redirect } from 'next/navigation';
import { accessToken } from './session';

const API_URL = process.env.CREW_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public sessionRequest = false,
  ) {
    super(message);
  }
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries((this.details as { path: string; message: string }[]).map((d) => [d.path, d.message]));
  }
}

/** Server-side call to the CREW platform API with the signed-in admin's console token. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-crew-client': 'console' };
  let sessionRequest = false;
  if (init.auth !== false) {
    const token = await accessToken();
    if (token) headers.authorization = `Bearer ${token}`;
    sessionRequest = Boolean(token);
  }
  const res = await fetch(`${API_URL}/api/v1${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: 'no-store' });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (json as { error?: { code: string; message: string; details?: unknown } }).error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details, sessionRequest);
  }
  return json as T;
}

/** For server components: an ended session goes to sign-in, a missing MFA step to enrolment, a missing capability to "no access". */
export async function load<T>(path: string): Promise<T> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect('/login?expired=1');
    if (e instanceof ApiError && e.code === 'mfa_required') redirect('/enrol');
    if (e instanceof ApiError && e.status === 403) redirect('/no-access');
    throw e;
  }
}

export type ActionResult<T = unknown> = { ok: true; data?: T; message?: string } | { ok: false; message: string; code?: string; fieldErrors?: Record<string, string> };

export async function act<T>(fn: () => Promise<T>, success?: string): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data, message: success };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401 && e.sessionRequest) redirect('/login?expired=1');
      return { ok: false, message: e.message, code: e.code, fieldErrors: e.fieldErrors };
    }
    throw e;
  }
}
