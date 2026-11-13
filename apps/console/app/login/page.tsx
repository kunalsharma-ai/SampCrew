import { safeNextPath } from '@crew/contracts';
import type { Metadata } from 'next';
import { sessionCookieProblem } from '@/lib/session';
import { AuthFrame } from '../auth-frame';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string }> }) {
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
  return (
    <AuthFrame>
      <LoginForm next={next} expired={sp.expired === '1'} addressProblem={await sessionCookieProblem()} />
    </AuthFrame>
  );
}
