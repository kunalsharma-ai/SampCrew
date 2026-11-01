/**
 * HTTP client for the CREW API. Sends the bearer access token, marks requests as coming from the mobile app,
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
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'x-crew-client': 'mobile',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(access ? { authorization: `Bearer ${access}` } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch {
      throw new ApiError(0, 'offline', 'No connection to CREW. Check your network and try again.');
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
