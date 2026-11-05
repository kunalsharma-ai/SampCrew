import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import { SecurityView } from './security-view';

export const metadata: Metadata = { title: 'Security' };

export default async function SecurityPage() {
  const [me, sessions] = await Promise.all([
    load<Me>('/me'),
    load<{ id: string; client: string; ip: string | null; userAgent: string | null; createdAt: string; current: boolean }[]>('/me/sessions'),
  ]);
  return (
    <>
      <PageHeader title="Security" description="Protect your account with two-step verification and keep an eye on where you are signed in." />
      <SecurityView mfaEnabled={me.user.mfaEnabled} sessionMfa={me.session.mfa} sessions={sessions} />
    </>
  );
}
