import { Badge, Card, CardHeader, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Download } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { ProfileUpdateDetail } from '@/lib/types';
import { STATUS } from '../status';
import { DecidePanel } from './decide-panel';

export const metadata: Metadata = { title: 'Profile update' };

const ACTION: Record<string, string> = { submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected', info_requested: 'Asked for more information', cancelled: 'Withdrawn', superseded: 'Replaced by a newer update' };
const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

export default async function ProfileUpdatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await load<ProfileUpdateDetail>(`/profile/updates/${id}`);
  const [statusLabel, tone] = STATUS[u.status] ?? [u.status, 'neutral'];
  return (
    <>
      <PageHeader
        eyebrow={u.mine ? <Link href="/profile" className="hover:underline">My profile</Link> : <Link href="/profile/updates" className="hover:underline">Profile updates</Link>}
        title={`${u.sectionLabel}: ${u.employee.name}`}
        description={`${[u.employee.code, u.employee.department].filter(Boolean).join(' · ')} · submitted ${when(u.createdAt)}`}
        actions={<Badge tone={tone} dot>{statusLabel}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader title="Old and new values" description="Bank and identity numbers show their last characters only." />
            <Table aria-label="Old and new values">
              <THead><tr><TH>Field</TH><TH>On record now</TH><TH>Submitted</TH></tr></THead>
              <TBody>
                {u.changes.map((c) => (
                  <TR key={c.field}>
                    <TD className="font-medium">{c.label}</TD>
                    <TD className="text-fg-muted">{c.old ?? '—'}</TD>
                    <TD className="font-medium text-accent">{c.new ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {u.note && <p className="px-5 py-4 text-sm"><b>Note from {u.employee.name.split(' ')[0]}:</b> {u.note}</p>}
          </Card>
          {u.documents.length > 0 && (
            <Card>
              <CardHeader title="Supporting documents" />
              <ul className="grid gap-2 px-5 pb-5">
                {u.documents.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                    <span><b>{d.title}</b> <span className="text-fg-subtle">{d.fileName}</span></span>
                    <a className="inline-flex items-center gap-1 font-medium text-accent hover:underline" href={`/files/${d.id}`}><Download className="size-4" aria-hidden />Open</a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {u.canDecide && <DecidePanel id={u.id} />}
          {u.remarks && !u.canDecide && <Card><CardHeader title="HR remarks" /><p className="px-5 pb-5 text-sm">{u.remarks}</p></Card>}
        </div>
        <Card className="content-start">
          <CardHeader title="History" />
          <ol className="grid gap-3 px-5 pb-5 text-sm" aria-label="Update history">
            {u.history.map((h, i) => (
              <li key={i} className="border-l-2 border-border pl-3">
                <div className="font-medium">{ACTION[h.action] ?? h.action}</div>
                <div className="text-xs text-fg-subtle">{when(h.at)}{h.by ? ` · ${h.by}` : ''}</div>
                {h.remarks && <p className="mt-1 text-xs text-fg-muted">{h.remarks}</p>}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
