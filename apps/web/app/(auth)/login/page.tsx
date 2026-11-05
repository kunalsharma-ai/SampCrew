import type { Metadata } from 'next';
import { ssoError } from '@/lib/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string; workspace?: string; sso_error?: string }> }) {
  const sp = await searchParams;
  const next = sp.next?.startsWith('/') && !sp.next.startsWith('//') ? sp.next : '/';
  const failure = sp.sso_error ? ((await ssoError()) ?? 'Single sign-on did not complete. Start again.') : null;
  return <LoginForm next={next} expired={sp.expired === '1'} workspace={sp.workspace} ssoFailure={failure} />;
}
