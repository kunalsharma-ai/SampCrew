import { Badge, Card, CardBody, EmptyState, PageHeader, buttonClass } from '@crew/ui';
import { Megaphone } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { dateTime } from '../helpdesk/labels';
import type { Announcement } from '../helpdesk/types';

export const metadata: Metadata = { title: 'Announcements' };

export default async function AnnouncementsPage() {
  const me = await load<Me>('/me');
  const feed = await load<Announcement[]>('/announcements');
  return (
    <>
      <PageHeader
        title="Announcements"
        description="News and notices from HR addressed to you."
        actions={can(me, 'announcements:manage') ? <Link className={buttonClass('secondary', 'sm')} href="/announcements/manage">Manage announcements</Link> : undefined}
      />
      <div className="grid max-w-3xl gap-4">
        {feed.length === 0 && <Card><CardBody><EmptyState icon={<Megaphone className="size-5" />} title="No announcements" description="Nothing has been announced to you yet." /></CardBody></Card>}
        {feed.map((a) => (
          <Card key={a.id}>
            <CardBody>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/announcements/${a.id}`} className="text-[15px] font-semibold text-fg hover:text-accent hover:underline">{a.title}</Link>
                {a.pinned && <Badge>Pinned</Badge>}
                {!a.readAt && <Badge tone="info">New</Badge>}
                {a.requiresAck && !a.acknowledgedAt && <Badge tone="warning">Please acknowledge</Badge>}
                {a.requiresAck && a.acknowledgedAt && <Badge tone="success">Acknowledged</Badge>}
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[13px] text-fg-muted">{a.body}</p>
              <p className="mt-2 text-xs text-fg-subtle">{a.publishedAt && dateTime(a.publishedAt)}{a.publishedByName ? ` · ${a.publishedByName}` : ''}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
