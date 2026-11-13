import { type NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/session';
import { SIGNED_OUT_REASONS } from '@/lib/signed-out';

/**
 * Ends a session that can no longer open any page (the workspace is suspended, SAMPLEDGE switched the Web Portal off,
 * or the session was revoked) and goes to sign-in with the reason. The signed-in layout sends the browser here instead
 * of to "no access", which sits in the same layout and would redirect again, forever.
 */
export function GET(req: NextRequest) {
  const asked = req.nextUrl.searchParams.get('reason') ?? '';
  const reason = asked in SIGNED_OUT_REASONS ? asked : 'blocked';
  const out = NextResponse.redirect(new URL(reason === 'expired' ? '/login?expired=1' : `/login?reason=${reason}`, req.url));
  out.cookies.delete(ACCESS_COOKIE);
  out.cookies.delete(REFRESH_COOKIE);
  return out;
}
