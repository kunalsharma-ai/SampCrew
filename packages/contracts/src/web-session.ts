/**
 * Session helpers shared by the Web Portal and the Super Admin Console. Both keep the API's tokens in httpOnly
 * cookies and refresh them in Next.js middleware; nothing here uses Node APIs, so it runs in the middleware runtime.
 */

/** Addresses browsers treat as secure even over plain http, so a Secure cookie still sticks there. */
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/**
 * Why the browser will throw the sign-in cookies away, or null when they will stick. A Secure cookie set on a plain
 * http address (anything other than localhost) is silently dropped, so the next page has no session and goes back to
 * sign-in: the sign-in page appears to reload itself after every attempt. `origin` is the browser's Origin header (sent
 * with every server action); `forwardedProto` is the X-Forwarded-Proto of the proxy in front, used when there is no
 * Origin.
 */
export function secureCookieProblem(input: { secure: boolean; origin?: string | null; forwardedProto?: string | null; host?: string | null }): string | null {
  if (!input.secure) return null;
  let protocol: string | undefined;
  let host = input.host ?? undefined;
  if (input.origin && input.origin !== 'null') {
    try {
      const u = new URL(input.origin);
      protocol = u.protocol.replace(':', '');
      host = u.host;
    } catch {
      // A malformed Origin says nothing about the address; fall back to the proxy header.
    }
  }
  protocol ??= input.forwardedProto?.split(',')[0]?.trim().toLowerCase();
  if (protocol !== 'http') return null;
  if (host && LOOPBACK.test(host)) return null;
  return `Sign-in needs a secure address. This page was opened over http://${host ?? ''}, and browsers refuse the sign-in cookie there, so you would land back on this page. Open the https:// address instead. On a test server without https, set SESSION_COOKIE_SECURE=false for the web and console apps.`;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Shares one refresh between requests that carry the same refresh token. The API rotates the refresh token on every
 * use and treats a second use of an old one as theft, ending the whole session. A browser sends several requests at
 * once (a page and its link prefetches), and each reaches the middleware with the same old cookie; refreshing each on
 * its own signed the person out. Requests that arrive a little later, before the browser has stored the new cookies,
 * get the same answer for `keepMs`.
 */
export function refreshCoalescer(refresh: (refreshToken: string) => Promise<RefreshedTokens | null>, keepMs = 20_000) {
  const recent = new Map<string, { at: number; result: Promise<RefreshedTokens | null> }>();
  return (refreshToken: string): Promise<RefreshedTokens | null> => {
    const now = Date.now();
    for (const [k, v] of recent) if (now - v.at > keepMs) recent.delete(k);
    const hit = recent.get(refreshToken);
    if (hit) return hit.result;
    const result = refresh(refreshToken).catch(() => null);
    recent.set(refreshToken, { at: now, result });
    // A failed refresh (the API was briefly unreachable) is not remembered, so the next request tries again.
    void result.then((r) => {
      if (!r && recent.get(refreshToken)?.result === result) recent.delete(refreshToken);
    });
    return result;
  };
}
