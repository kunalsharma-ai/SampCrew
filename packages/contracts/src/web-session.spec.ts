import { describe, expect, it, vi } from 'vitest';
import { refreshCoalescer, secureCookieProblem } from './web-session';

describe('secureCookieProblem', () => {
  it('explains why sign-in cannot stick on a plain http address', () => {
    const m = secureCookieProblem({ secure: true, origin: 'http://203.0.113.7:3000' });
    expect(m).toContain('http://203.0.113.7:3000');
    expect(m).toContain('SESSION_COOKIE_SECURE=false');
    expect(secureCookieProblem({ secure: true, origin: 'http://crew.example.com' })).not.toBeNull();
    // No Origin header: the proxy's protocol header decides.
    expect(secureCookieProblem({ secure: true, forwardedProto: 'http', host: 'crew.example.com' })).not.toBeNull();
    expect(secureCookieProblem({ secure: true, forwardedProto: 'HTTP, https', host: 'crew.example.com' })).not.toBeNull();
  });

  it('allows https, localhost and insecure-cookie test setups', () => {
    expect(secureCookieProblem({ secure: true, origin: 'https://crew.example.com' })).toBeNull();
    expect(secureCookieProblem({ secure: true, forwardedProto: 'https', host: 'crew.example.com' })).toBeNull();
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3001', 'http://[::1]:3000']) expect(secureCookieProblem({ secure: true, origin }), origin).toBeNull();
    expect(secureCookieProblem({ secure: false, origin: 'http://203.0.113.7:3000' })).toBeNull();
  });

  it('does not guess when it cannot tell', () => {
    expect(secureCookieProblem({ secure: true })).toBeNull();
    expect(secureCookieProblem({ secure: true, origin: 'null' })).toBeNull();
    expect(secureCookieProblem({ secure: true, origin: 'not a url' })).toBeNull();
    // An https Origin wins over a stale proxy header.
    expect(secureCookieProblem({ secure: true, origin: 'https://crew.example.com', forwardedProto: 'http' })).toBeNull();
  });
});

describe('refreshCoalescer', () => {
  const tokens = (n: number) => ({ accessToken: `at${n}`, refreshToken: `rt${n}`, expiresIn: 900 });

  it('makes one refresh for requests that arrive together with the same token', async () => {
    let n = 0;
    const refresh = vi.fn(async () => tokens(++n));
    const once = refreshCoalescer(refresh);
    const results = await Promise.all([once('rt0'), once('rt0'), once('rt0'), once('rt0')]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r?.refreshToken))).toEqual(new Set(['rt1']));
    // A request a moment later that still carries the old cookie gets the same answer.
    expect(await once('rt0')).toEqual(tokens(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    // The new token refreshes on its own.
    expect(await once('rt1')).toEqual(tokens(2));
  });

  it('forgets an answer after the keep time', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const refresh = vi.fn(async () => tokens(++n));
      const once = refreshCoalescer(refresh, 1000);
      await once('rt0');
      vi.advanceTimersByTime(1500);
      await once('rt0');
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not remember a failed refresh, so the next request tries again', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(tokens(1));
    const once = refreshCoalescer(refresh);
    expect(await once('rt0')).toBeNull();
    await Promise.resolve();
    expect(await once('rt0')).toEqual(tokens(1));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
