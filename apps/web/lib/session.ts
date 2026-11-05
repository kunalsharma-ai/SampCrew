import 'server-only';
import { cookies } from 'next/headers';

export const ACCESS_COOKIE = 'crew_at';
export const REFRESH_COOKIE = 'crew_rt';

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
