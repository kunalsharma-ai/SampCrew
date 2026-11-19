import { describe, expect, it } from 'vitest';
import { Api, ApiError, base64, fromBase64, multipart, type Tokens, type TokenStore } from './api';

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

  it('sends a photo upload as multipart bytes with its own content type, and downloads a protected image as a data address', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const api = new Api('http://api', store({ accessToken: 'a1', refreshToken: 'r1' }), () => {}, async (url, init) => {
      seen.push({ url, init: init! });
      if (init!.method === 'GET') return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } });
      return json(200, { photoUpdatedAt: '2026-11-06T00:00:00Z' });
    });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(await api.uploadFile('PUT', '/employees/e1/photo', { field: 'file', fileName: 'me.png', type: 'image/png', bytes: png })).toEqual({ photoUpdatedAt: '2026-11-06T00:00:00Z' });
    const init = seen[0]!.init;
    // Not a FormData: phones' fetch (expo/fetch) cannot send React Native { uri } form entries.
    expect(init.body).toBeInstanceOf(Uint8Array);
    const type = (init.headers as Record<string, string>)['content-type']!;
    expect(type).toMatch(/^multipart\/form-data; boundary=/);
    expect(init.headers).toMatchObject({ authorization: 'Bearer a1' });
    // A real multipart parser reads the file back unchanged.
    const parsed = await new Response(init.body as unknown as BodyInit, { headers: { 'content-type': type } }).formData();
    const file = (parsed as unknown as { get(name: string): unknown }).get('file') as File;
    expect(file.name).toBe('me.png');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
    expect(await api.imageDataUrl('/employees/e1/photo')).toBe('data:image/png;base64,iVBORw==');
  });

  it('decodes base64 the way it encodes it, and keeps file names from breaking the form', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) % 256);
      expect(fromBase64(base64(bytes))).toEqual(bytes);
    }
    const body = new TextDecoder().decode(multipart({ field: 'file', fileName: 'a"b\r\n.png', type: 'image/png', bytes: new Uint8Array([1]) }, 'B').bytes);
    expect(body).toContain('filename="a_b__.png"');
    // Text fields (such as remarks on a task upload) go before the file.
    const withFields = new TextDecoder().decode(multipart({ field: 'file', fileName: 'scan.jpg', type: 'image/jpeg', bytes: new Uint8Array([1]), fields: { remarks: 'Both sides' } }, 'B').bytes);
    expect(withFields.indexOf('name="remarks"\r\n\r\nBoth sides\r\n')).toBeGreaterThan(0);
    expect(withFields.indexOf('name="remarks"')).toBeLessThan(withFields.indexOf('name="file"'));
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
