import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import type { Admin } from '@/lib/types';
import { AuthFrame } from '../auth-frame';
import { EnrolForm } from './enrol-form';

export const metadata: Metadata = { title: 'Set up two-step verification' };

export default async function EnrolPage() {
  const me = await load<Admin>('/platform/auth/me');
  if (me.session.mfa) redirect('/');
  return (
    <AuthFrame>
      <EnrolForm email={me.email} enrolled={me.mfaEnabled} />
    </AuthFrame>
  );
}
