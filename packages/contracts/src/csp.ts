/**
 * The Content Security Policy for the Web Portal and the Super Admin Console, built per request by their middleware.
 *
 * Scripts run only with this request's nonce. 'strict-dynamic' lets a nonced script load the chunks it needs (Next.js
 * adds the nonce to its own scripts when it sees it in the request's CSP header). No inline event handlers, no
 * `javascript:` URLs, no scripts from any other site. Styles still allow 'unsafe-inline' (React style attributes and
 * the saved theme's stylesheet); CSS cannot run code. Development adds 'unsafe-eval' for hot reload.
 */
export function contentSecurityPolicy(opts: { nonce: string; dev?: boolean; frameAncestors: "'self'" | "'none'" }): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(opts.nonce)) throw new Error('CSP nonce must be at least 16 base64 characters');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${opts.nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    `frame-ancestors ${opts.frameAncestors}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}

/** A fresh nonce: 16 random bytes, base64. Works in the Edge runtime (Web Crypto) and in Node. */
export function cspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
