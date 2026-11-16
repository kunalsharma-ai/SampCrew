import { safeNextPath } from '@crew/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { sessionCookieProblem } from '@/lib/session';
import { AuthFrame } from '../auth-frame';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string }> }) {
  // A new installation has no admin yet: create the first one instead (first-run setup).
  const setup = await api<{ needsFirstAdmin: boolean }>('/platform/setup', { auth: false }).catch(() => ({ needsFirstAdmin: false }));
  if (setup.needsFirstAdmin) redirect('/setup');
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  return (
    <AuthFrame>
      <LoginForm next={next} expired={sp.expired === '1'} addressProblem={await sessionCookieProblem()} />
    </AuthFrame>
  );
}
