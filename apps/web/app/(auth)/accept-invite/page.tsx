import { Alert } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { AcceptForm } from './accept-form';

export const metadata: Metadata = { title: 'Join your team' };

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  let invite: { email: string; tenantName: string; fullName: string; existingAccount: boolean } | null = null;
  let error: string | null = null;
  if (!token) error = 'This link is missing its invitation code.';
  else {
    try {
      invite = await api(`/auth/invitations/${encodeURIComponent(token)}`, { auth: false });
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'We could not load this invitation.';
    }
  }
  if (!invite) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-semibold tracking-tight">Invitation unavailable</h2>
        <Alert tone="warning">{error}</Alert>
        <p className="text-sm text-fg-muted">Ask your administrator to send a new invitation, or <Link className="text-accent hover:underline" href="/login">sign in</Link> if you already joined.</p>
      </div>
    );
  }
  return <AcceptForm token={token!} invite={invite} />;
}
