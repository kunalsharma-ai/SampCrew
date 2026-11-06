import type { NextRequest } from 'next/server';
import { finishSso, ssoFailed } from '@/lib/sso-finish';

/**
 * SAML 2.0 Assertion Consumer Service (HTTP-POST binding). The identity provider's page posts SAMLResponse and
 * RelayState here; the API checks the signature against the owner's certificate, the audience, recipient, time
 * limits and that it answers the request SampCrew sent. See finishSso for where the browser goes next.
 */
export async function POST(req: NextRequest) {
  const origin = req.nextUrl.origin;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return ssoFailed(origin, 'The identity provider did not send a SAML response. Start again.', false);
  }
  const samlResponse = form.get('SAMLResponse');
  const relayState = form.get('RelayState');
  if (typeof samlResponse !== 'string' || typeof relayState !== 'string' || !samlResponse || !relayState) {
    return ssoFailed(origin, 'The identity provider did not send a SAML response with the sign-in state. Start again.', false);
  }
  return finishSso(origin, '/auth/sso/saml/callback', { samlResponse, relayState });
}
