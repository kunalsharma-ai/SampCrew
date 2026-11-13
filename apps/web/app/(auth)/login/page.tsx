import { safeNextPath } from '@crew/contracts';
import type { Metadata } from 'next';
import { sessionCookieProblem, ssoError } from '@/lib/session';
import { SIGNED_OUT_REASONS } from '@/lib/signed-out';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string; workspace?: string; sso_error?: string; reason?: string }> }) {
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  const failure = sp.sso_error ? ((await ssoError()) ?? 'Single sign-on did not complete. Start again.') : null;
  // Why the portal signed this person out itself (suspended workspace, Web Portal switched off).
  const notice = sp.reason && sp.reason !== 'expired' ? (SIGNED_OUT_REASONS[sp.reason] ?? null) : null;
  return <LoginForm next={next} expired={sp.expired === '1'} workspace={sp.workspace} ssoFailure={failure} notice={notice} addressProblem={await sessionCookieProblem()} />;
}
