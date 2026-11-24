import { ModuleNotices } from '@/components/module-notices';
import { Badge, buttonClass, Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { SubNav } from '@/components/sub-nav';
import { load } from '@/lib/api';
import type { ProfileUpdate } from '@/lib/types';
import { STATUS } from './status';

export const metadata: Metadata = { title: 'Profile updates' };

const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

export default async function ProfileUpdatesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const all = status === 'all';
  const rows = await load<ProfileUpdate[]>(`/profile/updates?status=${all ? 'all' : 'pending'}`);
  return (
    <>
      <PageHeader title="Profile updates" description="Changes employees made to their profiles. Compare old and new values, open any proof, then approve, reject or ask for more information." />
      <ModuleNotices category="profile" label="Profile" />
      <SubNav label="Profile update views" items={[{ href: '/profile/updates', label: 'Waiting', count: all ? undefined : rows.filter((r) => r.status === 'pending').length }, { href: '/profile/updates?status=all', label: 'All updates' }]} current={all ? '/profile/updates?status=all' : '/profile/updates'} />
      <Card>
        <CardHeader title={all ? 'All profile updates' : 'Waiting for review'} />
        {rows.length ? (
          <Table aria-label="Profile updates">
            <THead><tr><TH>Employee</TH><TH>Section</TH><TH>Changes</TH><TH>Submitted</TH><TH>Status</TH><TH><span className="sr-only">Open</span></TH></tr></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD><div className="font-medium">{r.employee.name}</div><div className="text-xs text-fg-subtle">{[r.employee.code, r.employee.department].filter(Boolean).join(' · ')}</div></TD>
                  <TD>{r.sectionLabel}</TD>
                  <TD className="max-w-xs truncate text-sm text-fg-muted">{r.changes.map((c) => c.label).join(', ')}</TD>
                  <TD className="whitespace-nowrap text-sm">{when(r.createdAt)}</TD>
                  <TD><Badge tone={STATUS[r.status]?.[1] ?? 'neutral'} dot>{STATUS[r.status]?.[0] ?? r.status}</Badge></TD>
                  <TD><Link className={buttonClass(r.canDecide ? 'primary' : 'secondary', 'sm')} href={`/profile/updates/${r.id}`}>{r.canDecide ? 'Review' : 'Open'}<span className="sr-only"> {r.employee.name} {r.sectionLabel}</span></Link></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title={all ? 'No profile updates yet' : 'Nothing waiting'} description="When an employee changes their profile, it appears here and in Approvals." />}
      </Card>
    </>
  );
}
