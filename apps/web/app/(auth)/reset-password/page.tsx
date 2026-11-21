import { Alert } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ResetView } from './reset-view';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const check = token ? await api<{ valid: boolean; email?: string }>('/auth/password-reset/check', { method: 'POST', body: { token }, auth: false }).catch(() => ({ valid: false })) : { valid: false };
  if (!token || !check.valid) {
    return (
      <div className="flex flex-col gap-4" data-testid="reset-invalid">
        <h2 className="text-2xl font-semibold tracking-tight">This link no longer works</h2>
        <Alert tone="warning">Reset links work once, for 30 minutes, and only the newest one you asked for.</Alert>
        <p className="text-sm text-fg-muted">
          <Link className="font-medium text-accent hover:underline" href="/forgot-password">Ask for a new link</Link> or <Link className="text-accent hover:underline" href="/login">sign in</Link>.
        </p>
      </div>
    );
  }
  return <ResetView token={token} maskedEmail={(check as { email?: string }).email} />;
}
