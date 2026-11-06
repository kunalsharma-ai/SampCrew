import type { NextRequest } from 'next/server';
import { finishSso, isSignedIn, ssoFailed } from '@/lib/sso-finish';

/**
 * OpenID Connect: the identity provider sends the browser here with a code and the state SampCrew issued. The API checks
 * both and verifies the ID token; see finishSso for where the browser goes next.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');
  if (providerError) return ssoFailed(url.origin, `The identity provider did not sign you in (${providerError.replace(/[^\w.-]/g, '').slice(0, 60)}).`, await isSignedIn());
  if (!code || !state) return ssoFailed(url.origin, 'The identity provider did not send a sign-in code back. Start again.', await isSignedIn());
  return finishSso(url.origin, '/auth/sso/callback', { code, state });
}
