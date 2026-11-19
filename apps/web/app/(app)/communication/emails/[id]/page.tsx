import { Alert, Badge, Card, CardBody, CardHeader, PageHeader } from '@crew/ui';
import { ArrowLeft, Paperclip } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { RichTextView } from '@/components/rich-text';
import { loadAudienceOptions } from '../../audience-options';
import { CommTabs } from '../../comm-tabs';
import { EMAIL_STATUS_LABEL, EMAIL_STATUS_TONE, RECIPIENT_LABEL, RECIPIENT_TONE, type EmailDetail } from '../../types';
import { AutoRefresh } from '../auto-refresh';
import { Compose } from '../compose';

export const metadata: Metadata = { title: 'Email' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export default async function EmailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string }> }) {
  const { id } = await params;
  const { sent } = await searchParams;
  const e = await load<EmailDetail>(`/communication/emails/${id}`);
  if (e.status === 'draft') {
    const { options, knownNames } = await loadAudienceOptions();
    return (
      <>
        <PageHeader title="Draft email" description="Each person gets their own copy, so nobody sees the others' addresses." />
        <CommTabs active="emails" isHr />
        <Compose id={e.id} initial={{ subject: e.subject, html: e.html, audience: e.audience, cc: e.cc, bcc: e.bcc }} files={e.files} options={options} knownNames={knownNames} />
      </>
    );
  }
  const queued = e.recipients.filter((r) => r.status === 'queued').length;
  const skipped = e.recipients.filter((r) => r.status === 'skipped').length;
  return (
    <>
      <AutoRefresh active={e.status === 'sending'} />
      <Link href="/communication/emails" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Emails</Link>
      <PageHeader title={e.subject} description={`To ${e.audienceLabel}${e.cc.length ? `, Cc ${e.cc.join(', ')}` : ''} · sent by ${e.sentByName ?? 'HR'} ${when(e.sentAt)}`} actions={<Badge tone={EMAIL_STATUS_TONE[e.status]}>{EMAIL_STATUS_LABEL[e.status]}</Badge>} />
      {sent && <div className="mb-4"><Alert tone="success">Sent to {sent} {sent === '1' ? 'address' : 'addresses'}. Delivery status updates below as your email provider sends each copy.</Alert></div>}
      {skipped > 0 && <div className="mb-4"><Alert tone="warning">{skipped} {skipped === 1 ? 'copy was' : 'copies were'} not sent because email delivery is not set up for SampCrew yet. They can still read it under Communication, Emails.</Alert></div>}
      <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
        <Card>
          <CardHeader title="Message" />
          <CardBody>
            <RichTextView html={e.html} />
            {e.files.length > 0 && <ul className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">{e.files.map((f) => <li key={f.id}><a href={f.href} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-bg-subtle"><Paperclip className="size-3" /> {f.name}</a></li>)}</ul>}
          </CardBody>
        </Card>
        <Card className="content-start">
          <CardHeader title="Delivery" description={`${e.sentCount} of ${e.recipientCount} delivered${queued ? `, ${queued} on the way` : ''}${e.failedCount ? `, ${e.failedCount} not delivered` : ''}.`} />
          <CardBody className="p-0">
            <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto" data-testid="email-recipients">
              {e.recipients.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-2 px-5 py-2 text-[0.8125rem]">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.employeeId ? <Link href={`/communication/people/${r.employeeId}`} className="hover:underline">{r.name ?? r.address}</Link> : r.name ?? r.address}{r.kind !== 'to' && <span className="ml-1 text-xs uppercase text-fg-subtle">{r.kind}</span>}</span>
                    <span className="block truncate text-xs text-fg-muted">{r.address}{r.error ? ` · ${r.error}` : ''}</span>
                  </span>
                  <Badge tone={RECIPIENT_TONE[r.status]}>{RECIPIENT_LABEL[r.status]}</Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
