import { Alert, Badge, Card, CardBody, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { RichTextView } from '@/components/rich-text';
import { load } from '@/lib/api';
import { ANN_PRIORITY_LABEL, ANN_PRIORITY_TONE, dateTime } from '../../helpdesk/labels';
import type { Announcement } from '../../helpdesk/types';
import { AnnouncementFiles } from '../announcement-files';
import { LiveRefresh } from '../live-refresh';
import { AcknowledgeButton } from './acknowledge-button';

export const metadata: Metadata = { title: 'Announcement' };

/** Opening an announcement records that you have read it. */
export default async function AnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await load<Announcement & { inAudience: boolean; canManage: boolean }>(`/announcements/${id}`);
  return (
    <>
      <LiveRefresh />
      <PageHeader
        eyebrow={a.categoryLabel}
        title={a.title}
        description={`${a.publishedAt ? dateTime(a.publishedAt) : 'Not published'}${a.publishedByName ? ` · ${a.publishedByName}` : ''}${a.editedAt ? ` · edited ${dateTime(a.editedAt)}` : ''}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href={a.canManage ? `/announcements/manage/${a.id}` : '/announcements'}>{a.canManage ? 'Read receipts' : 'All announcements'}</Link>}
      />
      <div className="grid max-w-3xl gap-4">
        {a.status !== 'published' && <Alert tone="warning">{a.status === 'draft' ? 'Draft: only people who manage announcements can see it.' : a.status === 'scheduled' ? 'Scheduled: people see it once it is published.' : 'Archived: no longer on the feed.'}</Alert>}
        {a.priority === 'urgent' && <Alert tone="danger" title="Urgent">Please read this now.</Alert>}
        <Card>
          <CardBody className="grid gap-3">
            {(a.pinned || a.priority === 'important') && <div className="flex gap-1.5">{a.pinned && <Badge>Pinned</Badge>}{a.priority === 'important' && <Badge tone={ANN_PRIORITY_TONE.important}>{ANN_PRIORITY_LABEL.important}</Badge>}</div>}
            {a.html ? <RichTextView html={a.html} className="text-[0.875rem]" /> : <div className="whitespace-pre-wrap text-[0.875rem] leading-relaxed">{a.body}</div>}
            <AnnouncementFiles files={a.files} />
          </CardBody>
        </Card>
        {a.requiresAck && a.inAudience && (
          a.acknowledgedAt
            ? <Alert tone="success">You acknowledged this on {dateTime(a.acknowledgedAt)}.</Alert>
            : (
              <Card>
                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[0.8125rem]">{a.acknowledgedEarlierAt ? `HR changed this after you acknowledged it on ${dateTime(a.acknowledgedEarlierAt)}. Please read it again and confirm.` : 'HR has asked everyone to confirm they have read this.'}</span>
                  <AcknowledgeButton id={a.id} />
                </CardBody>
              </Card>
            )
        )}
      </div>
    </>
  );
}
