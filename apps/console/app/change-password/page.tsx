import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import type { Admin } from '@/lib/types';
import { AuthFrame } from '../auth-frame';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Change your password' };

export default async function ChangePasswordPage() {
  const me = await load<Admin>('/platform/auth/me');
  // Two-step verification comes first: the password change needs an MFA-verified session.
  if (!me.session.mfa) redirect('/enrol');
  return (
    <AuthFrame>
      <ChangePasswordForm email={me.email} required={me.mustChangePassword} />
    </AuthFrame>
  );
}
