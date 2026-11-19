import { Alert, Badge, Card, CardBody, CardHeader, PageHeader, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { RichTextView } from '@/components/rich-text';
import { load } from '@/lib/api';
import { ANN_PRIORITY_LABEL, ANN_PRIORITY_TONE, ANN_STATUS_LABEL, ANN_STATUS_TONE, dateTime } from '../../../helpdesk/labels';
import type { Announcement } from '../../../helpdesk/types';
import { AnnouncementFiles } from '../../announcement-files';
import { ReceiptActions } from './receipt-actions';

export const metadata: Metadata = { title: 'Read receipts' };

interface Detail extends Announcement {
  people: { employeeId: string | null; membershipId: string; name: string; departmentName: string | null; readAt: string | null; acknowledgedAt: string | null; acknowledgedEarlierAt: string | null }[];
  remindedAt: string | null;
  canRemind: boolean;
}

/** One announcement for HR: who it reaches, who has read and acknowledged it, and what can be done next. */
export default async function ReceiptsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { id } = await params;
  const { saved } = await searchParams;
  const a = await load<Detail>(`/announcements/manage/${id}`);
  const read = a.people.filter((p) => p.readAt).length;
  const acked = a.people.filter((p) => p.acknowledgedAt).length;
  const when = a.status === 'scheduled' && a.publishAt ? `goes out ${dateTime(a.publishAt)}` : a.publishedAt ? `published ${dateTime(a.publishedAt)}` : ANN_STATUS_LABEL[a.status].toLowerCase();
  return (
    <>
      <PageHeader eyebrow="Announcement" title={a.title} description={`${a.audienceLabel} · ${when}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/announcements/manage">All announcements</Link>} />
      <div className="grid gap-6">
        {saved && <Alert tone={saved.startsWith('The draft is saved but not published') ? 'danger' : 'success'}>{saved}</Alert>}
        {a.deletedAt && <Alert tone="warning">Deleted {dateTime(a.deletedAt)}. It is off every feed; the read receipts below are kept.</Alert>}
        <ReceiptActions a={a} />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Audience" value={a.people.length} hint="People it is addressed to now" />
          <Stat label="Read" value={read} />
          {a.requiresAck && <Stat label="Acknowledged" value={acked} hint={`${a.people.length - acked} still to acknowledge`} />}
          <Stat label="Version" value={a.version} hint={a.editedAt ? `Edited ${dateTime(a.editedAt)}${a.editedByName ? ` by ${a.editedByName}` : ''}` : 'Not edited'} />
        </div>
        <Card>
          <CardHeader title="Message" action={<div className="flex flex-wrap gap-1.5"><Badge tone={ANN_STATUS_TONE[a.status]}>{ANN_STATUS_LABEL[a.status]}</Badge><Badge>{a.categoryLabel}</Badge>{a.priority !== 'normal' && <Badge tone={ANN_PRIORITY_TONE[a.priority]}>{ANN_PRIORITY_LABEL[a.priority]}</Badge>}</div>} />
          <CardBody className="grid gap-3">
            {a.html ? <RichTextView html={a.html} /> : <div className="whitespace-pre-wrap text-[0.8125rem]">{a.body}</div>}
            <AnnouncementFiles files={a.files} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="People" />
          <Table>
            <THead><tr><TH>Name</TH><TH>Department</TH><TH>Read</TH>{a.requiresAck && <TH>Acknowledged</TH>}</tr></THead>
            <TBody>
              {a.people.map((p) => (
                <TR key={p.membershipId}>
                  <TD>{p.name}</TD>
                  <TD className="text-fg-muted">{p.departmentName ?? '–'}</TD>
                  <TD>{p.readAt ? dateTime(p.readAt) : <Badge>Not yet</Badge>}</TD>
                  {a.requiresAck && <TD>{p.acknowledgedAt ? dateTime(p.acknowledgedAt) : p.acknowledgedEarlierAt ? <Badge tone="warning">Earlier version only</Badge> : <Badge tone="warning">Not yet</Badge>}</TD>}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
