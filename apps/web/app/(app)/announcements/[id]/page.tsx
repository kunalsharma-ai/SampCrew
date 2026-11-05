import { Alert, Badge, Card, CardBody, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { dateTime } from '../../helpdesk/labels';
import type { Announcement } from '../../helpdesk/types';
import { AcknowledgeButton } from './acknowledge-button';

export const metadata: Metadata = { title: 'Announcement' };

/** Opening an announcement records that you have read it. */
export default async function AnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await load<Announcement & { inAudience: boolean; canManage: boolean }>(`/announcements/${id}`);
  return (
    <>
      <PageHeader
        eyebrow="Announcement"
        title={a.title}
        description={`${a.publishedAt ? dateTime(a.publishedAt) : 'Not published'}${a.publishedByName ? ` · ${a.publishedByName}` : ''}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href={a.canManage ? `/announcements/manage/${a.id}` : '/announcements'}>{a.canManage ? 'Read receipts' : 'All announcements'}</Link>}
      />
      <div className="grid max-w-3xl gap-4">
        {a.status !== 'published' && <Alert tone="warning">{a.status === 'draft' ? 'Draft: only people who manage announcements can see it.' : 'Archived: no longer on the feed.'}</Alert>}
        <Card>
          <CardBody>
            {a.pinned && <Badge className="mb-2">Pinned</Badge>}
            <div className="whitespace-pre-wrap text-[0.875rem] leading-relaxed">{a.body}</div>
          </CardBody>
        </Card>
        {a.requiresAck && a.inAudience && (
          a.acknowledgedAt
            ? <Alert tone="success">You acknowledged this on {dateTime(a.acknowledgedAt)}.</Alert>
            : <Card><CardBody className="flex flex-wrap items-center justify-between gap-3"><span className="text-[0.8125rem]">HR has asked everyone to confirm they have read this.</span><AcknowledgeButton id={a.id} /></CardBody></Card>
        )}
      </div>
    </>
  );
}
