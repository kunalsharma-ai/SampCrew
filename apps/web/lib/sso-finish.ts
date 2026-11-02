import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ApiError, api } from '@/lib/api';
import { ACCESS_COOKIE, REFRESH_COOKIE, SSO_ERROR_COOKIE, setSession, type TokenPair } from '@/lib/session';

type Result =
  | ({ status: 'ok' } & TokenPair)
  | { status: 'sso_test_passed'; email: string }
  | { status: 'mobile_handoff'; redirectTo: string };

const SETTINGS = '/settings/single-sign-on';

/**
 * Hands the provider's answer to the API and sends the browser on: home with a session, back to Settings after an
 * owner's test, or back to the mobile app with a one-time code (the app then exchanges it with its own PKCE
 * verifier, so the code is useless to anyone else). The API only accepts app addresses on its allow-list.
 *
 * A failure's reason travels in a short-lived httpOnly cookie, not the URL, so nobody can craft a link that shows
 * their own text on the sign-in page. The API says whether the failed attempt was a test, because a SAML response
 * arrives as a cross-site POST, which carries no session cookie to tell.
 */
export async function finishSso(origin: string, path: string, body: Record<string, string>) {
  const jar = await cookies();
  const signedIn = Boolean(jar.get(ACCESS_COOKIE)?.value || jar.get(REFRESH_COOKIE)?.value);
  const to = (p: string) => NextResponse.redirect(new URL(p, origin), { status: 303 });
  try {
    const r = await api<Result>(path, { method: 'POST', body, auth: false });
    if (r.status === 'sso_test_passed') return to(`${SETTINGS}?tested=1`);
    if (r.status === 'mobile_handoff') return NextResponse.redirect(r.redirectTo, { status: 303 });
    await setSession(r);
    return to('/');
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const purpose = (e.details as { purpose?: string } | undefined)?.purpose;
    return ssoFailed(origin, e.message, purpose ? purpose === 'test' : signedIn);
  }
}

export async function ssoFailed(origin: string, message: string, toSettings: boolean) {
  const jar = await cookies();
  jar.set(SSO_ERROR_COOKIE, message.slice(0, 300), { httpOnly: true, secure: process.env.SESSION_COOKIE_SECURE !== 'false', sameSite: 'lax', path: '/', maxAge: 60 });
  return NextResponse.redirect(new URL(toSettings ? `${SETTINGS}?failed=1` : '/login?sso_error=1', origin), { status: 303 });
}

export async function isSignedIn() {
  const jar = await cookies();
  return Boolean(jar.get(ACCESS_COOKIE)?.value || jar.get(REFRESH_COOKIE)?.value);
}
