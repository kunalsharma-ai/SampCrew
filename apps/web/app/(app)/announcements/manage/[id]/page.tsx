import { Badge, Card, CardBody, CardHeader, PageHeader, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { audienceLabel, dateTime } from '../../../helpdesk/labels';
import type { Announcement } from '../../../helpdesk/types';

export const metadata: Metadata = { title: 'Read receipts' };

interface Detail extends Announcement {
  people: { employeeId: string; name: string; departmentName: string | null; readAt: string | null; acknowledgedAt: string | null }[];
}

export default async function ReceiptsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await load<Detail>(`/announcements/manage/${id}`);
  const read = a.people.filter((p) => p.readAt).length;
  const acked = a.people.filter((p) => p.acknowledgedAt).length;
  return (
    <>
      <PageHeader eyebrow="Announcement" title={a.title} description={`${audienceLabel(a)} · ${a.status === 'draft' ? 'Draft' : a.publishedAt ? `published ${dateTime(a.publishedAt)}` : a.status}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/announcements/manage">All announcements</Link>} />
      <div className="grid gap-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <Stat label="Audience" value={a.people.length} hint="Active employees it is addressed to" />
          <Stat label="Read" value={read} />
          {a.requiresAck && <Stat label="Acknowledged" value={acked} hint={`${a.people.length - acked} still to acknowledge`} />}
        </div>
        <Card>
          <CardHeader title="Message" />
          <CardBody><div className="whitespace-pre-wrap text-[0.8125rem]">{a.body}</div></CardBody>
        </Card>
        <Card>
          <CardHeader title="People" />
          <Table>
            <THead><tr><TH>Name</TH><TH>Department</TH><TH>Read</TH>{a.requiresAck && <TH>Acknowledged</TH>}</tr></THead>
            <TBody>
              {a.people.map((p) => (
                <TR key={p.employeeId}>
                  <TD>{p.name}</TD>
                  <TD className="text-fg-muted">{p.departmentName ?? '–'}</TD>
                  <TD>{p.readAt ? dateTime(p.readAt) : <Badge>Not yet</Badge>}</TD>
                  {a.requiresAck && <TD>{p.acknowledgedAt ? dateTime(p.acknowledgedAt) : <Badge tone="warning">Not yet</Badge>}</TD>}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
