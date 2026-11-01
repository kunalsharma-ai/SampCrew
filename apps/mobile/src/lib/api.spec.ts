import { describe, expect, it } from 'vitest';
import { Api, ApiError, type Tokens, type TokenStore } from './api';

const store = (initial: Tokens | null): TokenStore & { value: Tokens | null } => {
  const s = { value: initial, get: async () => s.value, set: async (t: Tokens) => void (s.value = t), clear: async () => void (s.value = null) };
  return s;
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('API client', () => {
  it('sends the bearer token and marks requests as mobile', async () => {
    const seen: RequestInit[] = [];
    const api = new Api('http://api', store({ accessToken: 'a1', refreshToken: 'r1' }), () => {}, async (_u, init) => {
      seen.push(init!);
      return json(200, { ok: true });
    });
    expect(await api.get('/me')).toEqual({ ok: true });
    expect(seen[0]!.headers).toMatchObject({ authorization: 'Bearer a1', 'x-crew-client': 'mobile' });
  });

  it('refreshes an expired token once for concurrent requests and retries', async () => {
    const tokens = store({ accessToken: 'old', refreshToken: 'r1' });
    let refreshes = 0;
    const api = new Api('http://api', tokens, () => {}, async (url, init) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++;
        return json(200, { accessToken: 'new', refreshToken: 'r2' });
      }
      const auth = (init!.headers as Record<string, string>).authorization;
      return auth === 'Bearer new' ? json(200, { url }) : json(401, { error: { code: 'unauthorized', message: 'expired' } });
    });
    const [a, b] = await Promise.all([api.get('/a'), api.get('/b')]);
    expect(a).toEqual({ url: 'http://api/api/v1/a' });
    expect(b).toEqual({ url: 'http://api/api/v1/b' });
    expect(refreshes).toBe(1);
    expect(tokens.value).toEqual({ accessToken: 'new', refreshToken: 'r2' });
  });

  it('signs out when the refresh is refused, but not when the network is down', async () => {
    const tokens = store({ accessToken: 'old', refreshToken: 'r1' });
    let signedOut = 0;
    let down = true;
    const api = new Api('http://api', tokens, () => signedOut++, async (url) => {
      if (down) throw new TypeError('Network request failed');
      return url.endsWith('/auth/refresh') ? json(401, { error: { code: 'invalid_refresh', message: 'no' } }) : json(401, { error: { code: 'unauthorized', message: 'expired' } });
    });
    const offline = await api.get('/x').catch((e: ApiError) => e);
    expect(offline).toBeInstanceOf(ApiError);
    expect((offline as ApiError).offline).toBe(true);
    expect(signedOut).toBe(0);
    down = false;
    const e = await api.get('/x').catch((err: ApiError) => err);
    expect((e as ApiError).code).toBe('signed_out');
    expect(signedOut).toBe(1);
    expect(tokens.value).toBeNull();
  });

  it('turns error envelopes into field errors', async () => {
    const api = new Api('http://api', store({ accessToken: 'a', refreshToken: 'r' }), () => {}, async () =>
      json(422, { error: { code: 'validation_failed', message: 'Some fields need attention', details: [{ path: 'endDate', message: 'The end date is before the start date' }] } }));
    const e = (await api.post('/leave/requests', {}).catch((err) => err)) as ApiError;
    expect(e).toMatchObject({ status: 422, code: 'validation_failed', fieldErrors: { endDate: 'The end date is before the start date' } });
  });
});
