import 'server-only';
import { normaliseAppearance, type Appearance } from '@crew/contracts';
import { cookies } from 'next/headers';

/**
 * A copy of the member's appearance in a readable cookie, so the very first paint (including sign-in pages on this
 * browser) already has their theme. The database row is the source of truth; the shell rewrites this cookie
 * whenever the two differ.
 */
export const APPEARANCE_COOKIE = 'crew_appearance';

export async function appearanceFromCookie(): Promise<Appearance> {
  const raw = (await cookies()).get(APPEARANCE_COOKIE)?.value;
  if (!raw) return normaliseAppearance(null);
  try {
    return normaliseAppearance(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    return normaliseAppearance(null);
  }
}

export async function writeAppearanceCookie(a: Appearance) {
  (await cookies()).set(APPEARANCE_COOKIE, Buffer.from(JSON.stringify(a)).toString('base64url'), {
    sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365, secure: process.env.SESSION_COOKIE_SECURE !== 'false',
  });
}
