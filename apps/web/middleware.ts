import { type NextRequest, NextResponse } from 'next/server';

const ACCESS = 'crew_at';
const REFRESH = 'crew_rt';
// /sso/callback is where the identity provider sends the browser back; it signs the person in itself.
const PUBLIC = ['/login', '/signup', '/accept-invite', '/kiosk', '/careers', '/proposal', '/sso'];
const API_URL = process.env.CREW_API_URL ?? 'http://localhost:4000';
const secure = process.env.SESSION_COOKIE_SECURE !== 'false';

function expiresSoon(token: string | undefined): boolean {
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now() + 30_000;
  } catch {
    return true;
  }
}

/**
 * Gate authenticated routes and refresh the access token shortly before it expires. Refreshing here (not in
 * server components) is what lets the new httpOnly cookies be written on the response.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();

  const access = req.cookies.get(ACCESS)?.value;
  const refresh = req.cookies.get(REFRESH)?.value;
  if (!refresh && !access) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(pathname)}`, req.url));
  if (!expiresSoon(access) || !refresh) return NextResponse.next();

  const res = await fetch(`${API_URL}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }) }).catch(() => null);
  if (!res?.ok) {
    const out = NextResponse.redirect(new URL('/login?expired=1', req.url));
    out.cookies.delete(ACCESS);
    out.cookies.delete(REFRESH);
    return out;
  }
  const tokens = (await res.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
  // Forward the fresh token to this request's server components, and persist both cookies.
  req.cookies.set(ACCESS, tokens.accessToken);
  const out = NextResponse.next({ request: { headers: req.headers } });
  out.cookies.set(ACCESS, tokens.accessToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: tokens.expiresIn });
  out.cookies.set(REFRESH, tokens.refreshToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
  return out;
}

export const config = { matcher: ['/((?!_next/|favicon|icon|.*\\.(?:svg|png|jpg|ico|webp)$).*)'] };
