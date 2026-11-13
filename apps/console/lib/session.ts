import 'server-only';
import { secureCookieProblem } from '@crew/contracts';
import { cookies, headers } from 'next/headers';

/** Console cookies are separate from the Web Portal's, and the console is served from its own origin. */
export const ACCESS_COOKIE = 'crew_console_at';
export const REFRESH_COOKIE = 'crew_console_rt';

const secure = process.env.SESSION_COOKIE_SECURE !== 'false';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function setSession(tokens: TokenPair) {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, tokens.accessToken, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: tokens.expiresIn });
  // Console sessions last at most 12 hours on the server; the cookie matches.
  jar.set(REFRESH_COOKIE, tokens.refreshToken, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: 60 * 60 * 12 });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

export async function accessToken() {
  return (await cookies()).get(ACCESS_COOKIE)?.value;
}

/**
 * Why sign-in cannot work on the address this request came to, or null. Call before setSession(): on a plain http
 * address the browser drops the Secure cookies, and the admin would land back on sign-in with no explanation.
 */
export async function sessionCookieProblem(): Promise<string | null> {
  const h = await headers();
  return secureCookieProblem({ secure, origin: h.get('origin'), forwardedProto: h.get('x-forwarded-proto'), host: h.get('x-forwarded-host') ?? h.get('host') });
}
