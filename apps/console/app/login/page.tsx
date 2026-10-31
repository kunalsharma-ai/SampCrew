import type { Metadata } from 'next';
import { AuthFrame } from '../auth-frame';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string }> }) {
  const sp = await searchParams;
  const next = sp.next?.startsWith('/') && !sp.next.startsWith('//') ? sp.next : '/';
  return (
    <AuthFrame>
      <LoginForm next={next} expired={sp.expired === '1'} />
    </AuthFrame>
  );
}
