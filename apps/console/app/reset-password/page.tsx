import { Alert } from '@crew/ui';
import type { Metadata } from 'next';
import { api } from '@/lib/api';
import { AuthFrame } from '../auth-frame';
import { ResetView } from './reset-view';

export const metadata: Metadata = { title: 'Choose a new password' };

export default async function ConsoleResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const check = token ? await api<{ valid: boolean; email?: string }>('/platform/auth/password-reset/check', { method: 'POST', body: { token }, auth: false }).catch(() => ({ valid: false as const })) : { valid: false as const };
  return (
    <AuthFrame>
      {!token || !check.valid ? (
        <div className="flex flex-col gap-4" data-testid="reset-invalid">
          <h1 className="text-lg font-semibold">This link no longer works</h1>
          <Alert tone="warning">Reset links work once, for 30 minutes, and only the newest one you asked for.</Alert>
          <p className="text-sm text-fg-muted"><a className="font-medium text-accent hover:underline" href="/forgot-password">Ask for a new link</a> or <a className="text-accent hover:underline" href="/login">sign in</a>.</p>
        </div>
      ) : (
        <ResetView token={token} maskedEmail={'email' in check ? check.email : undefined} />
      )}
    </AuthFrame>
  );
}
