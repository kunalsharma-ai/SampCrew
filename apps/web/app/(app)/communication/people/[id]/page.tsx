import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, buttonClass } from '@crew/ui';
import { ArrowLeft, Mail } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { RECIPIENT_LABEL, RECIPIENT_TONE, type EmployeeRecord } from '../../types';
import { HrChatButton } from './hr-chat-button';

export const metadata: Metadata = { title: 'Communication record' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export default async function EmployeeCommunicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await load<EmployeeRecord>(`/communication/employees/${id}`);
  return (
    <>
      <Link href={`/employees/${id}`} className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" /> {r.name}</Link>
      <PageHeader
        title={`Communication with ${r.name}`}
        description="Emails HR sent, the conversation with the HR team and help requests, in one place."
        actions={r.membershipId ? <><Link href={`/communication/emails/new?to=${r.membershipId}`} className={buttonClass('secondary', 'sm')}><Mail className="size-3.5" /> Email</Link><HrChatButton membershipId={r.membershipId} /></> : undefined}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Emails" />
          <CardBody className="p-0">
            {r.emails.length ? (
              <ul className="divide-y divide-border" data-testid="record-emails">
                {r.emails.map((e) => (
                  <li key={e.emailId}><Link href={`/communication/emails/${e.emailId}`} className="flex items-start justify-between gap-2 px-5 py-2.5 hover:bg-bg-subtle">
                    <span className="min-w-0"><span className="block truncate text-[0.8125rem] font-semibold">{e.subject}</span><span className="block truncate text-xs text-fg-muted">{e.address} · {when(e.sentAt)}{e.error ? ` · ${e.error}` : ''}</span></span>
                    <Badge tone={RECIPIENT_TONE[e.status]}>{RECIPIENT_LABEL[e.status]}</Badge>
                  </Link></li>
                ))}
              </ul>
            ) : <EmptyState icon={<Mail className="size-5" />} title="No emails yet" />}
          </CardBody>
        </Card>
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader title="Conversation with HR" />
            <CardBody>
              {r.hrConversation ? (
                <Link href={`/communication/chat/${r.hrConversation.id}`} className="block rounded-lg border border-border px-3 py-2 text-[0.8125rem] hover:bg-bg-subtle">{r.hrConversation.lastMessage ?? 'No messages yet'}<span className="block text-xs text-fg-subtle">{when(r.hrConversation.at)}</span></Link>
              ) : <p className="text-[0.8125rem] text-fg-muted">No messages with HR yet.</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Help requests" />
            <CardBody>
              {r.cases.length ? (
                <ul className="grid gap-1.5">{r.cases.map((c) => <li key={c.id}><Link href={`/helpdesk/${c.id}`} className="flex items-center justify-between gap-2 text-[0.8125rem] hover:underline"><span className="truncate">{c.subject}</span><Badge>{c.status.replace(/_/g, ' ')}</Badge></Link></li>)}</ul>
              ) : <p className="text-[0.8125rem] text-fg-muted">No help requests.</p>}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
