import 'server-only';
import { secureCookieProblem } from '@crew/contracts';
import { cookies, headers } from 'next/headers';

export const ACCESS_COOKIE = 'crew_at';
export const REFRESH_COOKIE = 'crew_rt';
/** Why the last single sign-on attempt failed, set by /sso/callback for one minute. */
export const SSO_ERROR_COOKIE = 'crew_sso_error';

const secure = process.env.SESSION_COOKIE_SECURE !== 'false';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** Stores tokens in httpOnly cookies. The browser's JavaScript never sees them. */
export async function setSession(tokens: TokenPair) {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, tokens.accessToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: tokens.expiresIn });
  jar.set(REFRESH_COOKIE, tokens.refreshToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

export async function accessToken() {
  return (await cookies()).get(ACCESS_COOKIE)?.value;
}

/** The reason the last single sign-on attempt failed, if it was in the last minute. */
export async function ssoError() {
  return (await cookies()).get(SSO_ERROR_COOKIE)?.value ?? null;
}

/**
 * Why sign-in cannot work on the address this request came to, or null. Call before setSession(): on a plain http
 * address the browser drops the Secure cookies, and the person would land back on sign-in with no explanation.
 */
export async function sessionCookieProblem(): Promise<string | null> {
  const h = await headers();
  return secureCookieProblem({ secure, origin: h.get('origin'), forwardedProto: h.get('x-forwarded-proto'), host: h.get('x-forwarded-host') ?? h.get('host') });
}
