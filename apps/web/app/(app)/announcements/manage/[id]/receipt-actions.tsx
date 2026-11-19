'use client';
import { Alert, Button, buttonClass } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRunner } from '../../../recruitment/use-runner';
import { archiveAnnouncementAction, deleteAnnouncementAction, publishAnnouncementAction, remindAnnouncementAction, unscheduleAnnouncementAction } from '../../../helpdesk/actions';
import type { Announcement } from '../../../helpdesk/types';

/** What HR can do with one announcement, depending on its state. */
export function ReceiptActions({ a }: { a: Announcement & { canRemind: boolean; remindedAt: string | null } }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  if (a.deletedAt) return null;
  return (
    <div className="grid gap-3">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <div className="flex flex-wrap gap-2">
        {a.status !== 'archived' && <Link className={buttonClass('secondary', 'sm')} href={`/announcements/manage/${a.id}/edit`}>Edit</Link>}
        {a.status === 'published' && <Link className={buttonClass('ghost', 'sm')} href={`/announcements/${a.id}`}>See it as employees do</Link>}
        {a.status === 'draft' && <Button size="sm" loading={pending} onClick={() => confirm(`Publish "${a.title}" now and notify ${a.audienceLabel}?`) && run(() => publishAnnouncementAction(a.id))}>Publish now</Button>}
        {a.status === 'scheduled' && <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => unscheduleAnnouncementAction(a.id))}>Unschedule</Button>}
        {a.status === 'published' && a.requiresAck && (
          <Button size="sm" variant="secondary" loading={pending} disabled={!a.canRemind} title={a.canRemind ? undefined : 'You can remind people once an hour'} onClick={() => run(() => remindAnnouncementAction(a.id))}>Remind those who have not acknowledged</Button>
        )}
        {a.status === 'published' && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Take it off the feed? Read receipts are kept.') && run(() => archiveAnnouncementAction(a.id))}>Archive</Button>}
        <Button size="sm" variant="ghost" loading={pending} onClick={() => {
          if (!confirm(a.status === 'draft' || a.status === 'scheduled' ? 'Delete this announcement for good?' : 'Delete it? It leaves everyone\'s feed; its read receipts and acknowledgements are kept.')) return;
          run(async () => {
            const r = await deleteAnnouncementAction(a.id);
            if (r.ok) router.push('/announcements/manage');
            return r;
          });
        }}>Delete</Button>
      </div>
    </div>
  );
}
