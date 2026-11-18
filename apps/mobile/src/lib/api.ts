/**
 * HTTP client for the SampCrew API. Sends the bearer access token, marks requests as coming from the mobile app,
 * and refreshes the token once (shared by concurrent requests) when it has expired. If the refresh fails the
 * session is over: tokens are cleared and the app returns to sign-in.
 */

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenStore {
  get(): Promise<Tokens | null>;
  set(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the request never reached the server (no connection, timeout). */
  get offline() {
    return this.status === 0;
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;
/** A photo over a slow mobile connection takes longer than an ordinary request. */
const UPLOAD_TIMEOUT_MS = 90_000;

/** A request body sent as raw bytes with its own content type (a multipart photo upload). */
export interface RawBody {
  bytes: Uint8Array;
  contentType: string;
}
const isRaw = (b: unknown): b is RawBody => typeof b === 'object' && b !== null && (b as RawBody).bytes instanceof Uint8Array && typeof (b as RawBody).contentType === 'string';

export class Api {
  private refreshing: Promise<boolean> | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly tokens: TokenStore,
    private readonly onSignedOut: () => void,
    private readonly fetchImpl: Fetch = (i, init) => fetch(i, init),
  ) {}

  private async raw(method: string, path: string, body: unknown, access: string | null, idempotencyKey?: string): Promise<Response> {
    const ctrl = new AbortController();
    const raw = isRaw(body);
    const timer = setTimeout(() => ctrl.abort(), raw ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
    try {
      return await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'x-crew-client': 'mobile',
          ...(raw ? { 'content-type': body.contentType } : body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(access ? { authorization: `Bearer ${access}` } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: raw ? (body.bytes as unknown as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch {
      throw new ApiError(0, 'offline', 'No connection to SampCrew. Check your network and try again.');
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: { path: string; message: string }[] } } | null;
    if (!res.ok) {
      const e = json?.error;
      const fieldErrors = Object.fromEntries((e?.details ?? []).map((d) => [d.path, d.message]));
      throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, fieldErrors);
    }
    return json as T;
  }

  /** Requests without a session (sign-in steps). */
  async publicRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.parse<T>(await this.raw(method, path, body, null));
  }

  /** With an idempotency key, a retried create (for example after a dropped connection) is recorded once. */
  async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const t = await this.tokens.get();
    if (!t) {
      this.onSignedOut();
      throw new ApiError(401, 'signed_out', 'Please sign in again.');
    }
    let res = await this.raw(method, path, body, t.accessToken, idempotencyKey);
    if (res.status === 401) {
      if (!(await this.refresh())) {
        this.onSignedOut();
        throw new ApiError(401, 'signed_out', 'Your session has ended. Please sign in again.');
      }
      res = await this.raw(method, path, body, (await this.tokens.get())!.accessToken, idempotencyKey);
    }
    return this.parse<T>(res);
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body: unknown = {}, idempotencyKey?: string) {
    return this.request<T>('POST', path, body, idempotencyKey);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, body);
  }
  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
  /**
   * Uploads one file as multipart/form-data. The body is built here as bytes rather than with FormData: on phones
   * the app's fetch (expo/fetch) cannot send React Native's { uri } file entries, so those uploads never left the
   * phone. Bytes work the same with every fetch the app can run on.
   */
  uploadFile<T>(method: 'POST' | 'PUT', path: string, file: { field: string; fileName: string; type: string; bytes: Uint8Array }) {
    return this.request<T>(method, path, multipart(file));
  }

  /** Downloads a protected image as a data: address the Image component can show on phones and on the web. */
  async imageDataUrl(path: string): Promise<string | null> {
    const t = await this.tokens.get();
    if (!t) return null;
    let res = await this.raw('GET', path, undefined, t.accessToken);
    if (res.status === 401 && (await this.refresh())) res = await this.raw('GET', path, undefined, (await this.tokens.get())!.accessToken);
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
    return `data:${type};base64,${base64(new Uint8Array(await res.arrayBuffer()))}`;
  }

  /** Rotates the refresh token. Concurrent callers share one refresh. */
  refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const t = await this.tokens.get();
        if (!t) return false;
        const res = await this.raw('POST', '/auth/refresh', { refreshToken: t.refreshToken }, null);
        if (!res.ok) {
          // A network failure is not a sign-out; only a refusal by the server is.
          if (res.status === 401 || res.status === 400) await this.tokens.clear();
          return false;
        }
        const next = (await res.json()) as Tokens;
        await this.tokens.set({ accessToken: next.accessToken, refreshToken: next.refreshToken });
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Base64 without btoa or FileReader, which not every JavaScript engine the app runs on has. */
export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]! + (b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!) + (c === undefined ? '=' : B64[c & 63]!);
  }
  return out;
}

const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));
/** Decodes base64 (padding and line breaks allowed) without atob, which not every JavaScript engine has. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX.get(clean[i]!)!, b = B64_INDEX.get(clean[i + 1]!) ?? 0, c = B64_INDEX.get(clean[i + 2]!), d = B64_INDEX.get(clean[i + 3]!);
    out[o++] = (a << 2) | (b >> 4);
    if (c !== undefined) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (c !== undefined && d !== undefined) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A multipart/form-data body with one file field. */
export function multipart(file: { field: string; fileName: string; type: string; bytes: Uint8Array }, boundary = `----SampCrew${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`): RawBody {
  const safeName = file.fileName.replace(/["\r\n\\]/g, '_');
  const head = utf8(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safeName}"\r\nContent-Type: ${file.type}\r\n\r\n`);
  const tail = utf8(`\r\n--${boundary}--\r\n`);
  const bytes = new Uint8Array(head.length + file.bytes.length + tail.length);
  bytes.set(head, 0);
  bytes.set(file.bytes, head.length);
  bytes.set(tail, head.length + file.bytes.length);
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}
