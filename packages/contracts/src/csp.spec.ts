import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, cspNonce } from './csp';

describe('content security policy', () => {
  it('allows scripts only with the request nonce, never inline or from elsewhere', () => {
    const nonce = cspNonce();
    const csp = contentSecurityPolicy({ nonce, frameAncestors: "'none'" });
    const script = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(script).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(contentSecurityPolicy({ nonce, dev: true, frameAncestors: "'self'" })).toMatch(/'unsafe-eval'/);
  });

  it('makes a new 128-bit nonce each time and refuses a weak one', () => {
    const a = cspNonce();
    expect(atob(a)).toHaveLength(16);
    expect(cspNonce()).not.toBe(a);
    expect(() => contentSecurityPolicy({ nonce: 'abc', frameAncestors: "'self'" })).toThrow();
    expect(() => contentSecurityPolicy({ nonce: "x' 'unsafe-inline", frameAncestors: "'self'" })).toThrow();
  });
});
