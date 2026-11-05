import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { ApiError, api } from '@/lib/api';
import { ACCESS_COOKIE, REFRESH_COOKIE, SSO_ERROR_COOKIE, setSession, type TokenPair } from '@/lib/session';

type Result = ({ status: 'ok' } & TokenPair) | { status: 'sso_test_passed'; email: string };

const SETTINGS = '/settings/single-sign-on';

/**
 * The identity provider sends the browser here with a code and the state CREW issued. The API checks both, verifies
 * the ID token and returns a session, which is stored in httpOnly cookies. A test sign-in started from Settings
 * returns to Settings instead, with no session created.
 *
 * A failure's reason travels in a short-lived httpOnly cookie, not the URL, so nobody can craft a link that shows
 * their own text on the sign-in page. Someone already signed in was running a test from Settings, so goes back there.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const jar = await cookies();
  const signedIn = Boolean(jar.get(ACCESS_COOKIE)?.value || jar.get(REFRESH_COOKIE)?.value);
  const to = (path: string) => NextResponse.redirect(new URL(path, url.origin), { status: 303 });
  const failed = (message: string) => {
    jar.set(SSO_ERROR_COOKIE, message.slice(0, 300), { httpOnly: true, secure: process.env.SESSION_COOKIE_SECURE !== 'false', sameSite: 'lax', path: '/', maxAge: 60 });
    return to(signedIn ? `${SETTINGS}?failed=1` : '/login?sso_error=1');
  };
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');
  if (providerError) return failed(`The identity provider did not sign you in (${providerError.replace(/[^\w.-]/g, '').slice(0, 60)}).`);
  if (!code || !state) return failed('The identity provider did not send a sign-in code back. Start again.');
  try {
    const r = await api<Result>('/auth/sso/callback', { method: 'POST', body: { code, state }, auth: false });
    if (r.status === 'sso_test_passed') return to(`${SETTINGS}?tested=1`);
    await setSession(r);
    return to('/');
  } catch (e) {
    if (e instanceof ApiError) return failed(e.message);
    throw e;
  }
}
