'use client';
import { Alert, Badge, Button, Card, CardHeader, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import Link from 'next/link';
import { useRunner } from '../../recruitment/use-runner';
import { archiveAnnouncementAction, deleteAnnouncementAction, publishAnnouncementAction, unscheduleAnnouncementAction } from '../../helpdesk/actions';
import { ANN_PRIORITY_LABEL, ANN_PRIORITY_TONE, ANN_STATUS_LABEL, ANN_STATUS_TONE, dateTime } from '../../helpdesk/labels';
import type { Announcement } from '../../helpdesk/types';

/** HR's list: state (with the scheduled time), audience, reads and acknowledgements, and what can be done next. */
export function ManageAnnouncements({ items, deleted }: { items: Announcement[]; deleted: boolean }) {
  const { pending, notice, run } = useRunner();
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader
          title={deleted ? 'Deleted announcements' : 'Announcements'}
          description={deleted ? 'Off every feed; kept with their read receipts and acknowledgements.' : undefined}
          action={<div className="flex gap-2">
            <Link className={buttonClass('ghost', 'sm')} href={deleted ? '/announcements/manage' : '/announcements/manage?deleted=true'}>{deleted ? 'Back to current' : 'Deleted'}</Link>
            {!deleted && <Link className={buttonClass('primary', 'sm')} href="/announcements/manage/new">New announcement</Link>}
          </div>}
        />
        <Table>
          <THead><tr><TH>Title</TH><TH>Audience</TH><TH>State</TH><TH>Read</TH><TH>Acknowledged</TH><TH /></tr></THead>
          <TBody>
            {items.length === 0 && <TR><TD colSpan={6} className="text-fg-muted">Nothing yet.</TD></TR>}
            {items.map((a) => (
              <TR key={a.id} data-testid="announcement-row">
                <TD>
                  <Link className="font-medium text-accent hover:underline" href={`/announcements/manage/${a.id}`}>{a.title}</Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <Badge>{a.categoryLabel}</Badge>
                    {a.priority !== 'normal' && <Badge tone={ANN_PRIORITY_TONE[a.priority]}>{ANN_PRIORITY_LABEL[a.priority]}</Badge>}
                    {a.pinned && <Badge>Pinned</Badge>}
                    {a.files.length > 0 && <span className="text-xs text-fg-subtle">{a.files.length} {a.files.length === 1 ? 'file' : 'files'}</span>}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {a.publishedAt ? `Published ${dateTime(a.publishedAt)}` : `Created ${dateTime(a.createdAt)}`}
                    {a.version > 1 ? ` · version ${a.version}` : ''}{a.expiresOn ? ` · until ${a.expiresOn}` : ''}
                  </div>
                </TD>
                <TD className="max-w-56 text-fg-muted">{a.audienceLabel}</TD>
                <TD>
                  <Badge tone={ANN_STATUS_TONE[a.status]}>{a.deletedAt ? 'Deleted' : ANN_STATUS_LABEL[a.status]}</Badge>
                  {a.status === 'scheduled' && a.publishAt && <div className="mt-0.5 text-xs text-fg-muted" suppressHydrationWarning>{dateTime(a.publishAt)}</div>}
                </TD>
                <TD className="tabular-nums">{a.status === 'draft' || a.status === 'scheduled' ? '–' : `${a.readCount} of ${a.audienceSize}`}</TD>
                <TD className="tabular-nums">{a.requiresAck ? (a.status === 'draft' || a.status === 'scheduled' ? 'Asked' : `${a.ackCount} of ${a.audienceSize}`) : 'Not asked'}</TD>
                <TD className="whitespace-nowrap text-right">
                  {!deleted && a.status !== 'archived' && <Link className={buttonClass('ghost', 'sm')} href={`/announcements/manage/${a.id}/edit`}>Edit</Link>}
                  {a.status === 'draft' && <Button data-feature="announcements.publish" size="sm" variant="ghost" loading={pending} onClick={() => confirm(`Publish "${a.title}" now and notify ${a.audienceLabel}?`) && run(() => publishAnnouncementAction(a.id))}>Publish</Button>}
                  {a.status === 'scheduled' && <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => unscheduleAnnouncementAction(a.id))}>Unschedule</Button>}
                  {a.status === 'published' && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Take it off the feed? Read receipts are kept.') && run(() => archiveAnnouncementAction(a.id))}>Archive</Button>}
                  {!deleted && (
                    <Button size="sm" variant="ghost" loading={pending}
                      onClick={() => confirm(a.status === 'draft' || a.status === 'scheduled' ? 'Delete this announcement for good?' : 'Delete it? It leaves everyone\'s feed; its read receipts and acknowledgements are kept.') && run(() => deleteAnnouncementAction(a.id))}>Delete</Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
