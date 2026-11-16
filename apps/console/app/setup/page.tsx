import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { sessionCookieProblem } from '@/lib/session';
import { AuthFrame } from '../auth-frame';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up SampCrew' };

/** First-run setup: shown only while the installation has no Console admin. */
export default async function SetupPage() {
  const { needsFirstAdmin } = await api<{ needsFirstAdmin: boolean }>('/platform/setup', { auth: false });
  if (!needsFirstAdmin) redirect('/login');
  return (
    <AuthFrame>
      <SetupForm addressProblem={await sessionCookieProblem()} />
    </AuthFrame>
  );
}
