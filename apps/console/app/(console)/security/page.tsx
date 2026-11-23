import type { SecurityOverview } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { SecurityView } from './security-view';

export const metadata: Metadata = { title: 'Security' };

/** Console security: open admin sessions, sign-in history, suspicious activity and MFA coverage. */
export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const data = await load<SecurityOverview>('/platform/security');
  const tab = sp.tab === 'logins' ? 'logins' : sp.tab === 'sessions' ? 'sessions' : 'overview';
  return (
    <>
      <PageHeader title="Security" description="Who is signed in to the Console, recent sign-ins and anything that looks wrong. Every Console session needs two-step verification." />
      <SecurityView data={data} tab={tab} />
    </>
  );
}
