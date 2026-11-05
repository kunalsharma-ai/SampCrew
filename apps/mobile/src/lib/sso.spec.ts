import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64url, makePkce, readHandoff } from './sso';

describe('mobile single sign-on helpers', () => {
  it('encodes base64url like Node does, for every padding length', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33]) {
      const b = randomBytes(n);
      expect(base64url(new Uint8Array(b))).toBe(b.toString('base64url'));
    }
  });

  it('makes an S256 PKCE pair the API accepts', async () => {
    const p = await makePkce((n) => new Uint8Array(randomBytes(n)), async (t) => new Uint8Array(createHash('sha256').update(t).digest()));
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'));
  });

  it('reads the code only from the address the app expects', () => {
    const code = 'a'.repeat(43);
    expect(readHandoff(`crew://sso?code=${code}`, 'crew://sso')).toEqual({ code });
    expect(readHandoff(`http://localhost:8081/sso?code=${code}`, 'http://localhost:8081/sso')).toEqual({ code });
    expect(readHandoff(`crew://other?code=${code}`, 'crew://sso')).toHaveProperty('error');
    expect(readHandoff(`https://evil.example/sso?code=${code}`, 'http://localhost:8081/sso')).toHaveProperty('error');
    expect(readHandoff('crew://sso?code=short', 'crew://sso')).toHaveProperty('error');
    expect(readHandoff('not a url', 'crew://sso')).toHaveProperty('error');
  });
});
