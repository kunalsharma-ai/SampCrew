import { ModuleNotices } from '@/components/module-notices';
import { ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_CATEGORY_LABELS } from '@crew/contracts';
import { Badge, Card, CardBody, EmptyState, Input, PageHeader, buttonClass, cn } from '@crew/ui';
import { Megaphone, Paperclip } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { ANN_PRIORITY_LABEL, ANN_PRIORITY_TONE, dateTime } from '../helpdesk/labels';
import type { Announcement } from '../helpdesk/types';
import { LiveRefresh } from './live-refresh';

export const metadata: Metadata = { title: 'Announcements' };

type Query = { category?: string; unread?: string; q?: string };

export default async function AnnouncementsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const sp = await searchParams;
  const category = (ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(sp.category ?? '') ? sp.category : undefined;
  const unread = sp.unread === 'true';
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const qs = (over: Query) => {
    const p = new URLSearchParams(Object.entries({ category, unread: unread ? 'true' : undefined, q, ...over }).filter((e): e is [string, string] => !!e[1]));
    return p.size ? `/announcements?${p}` : '/announcements';
  };
  const me = await load<Me>('/me');
  const feed = await load<Announcement[]>(`/announcements${qs({}).replace('/announcements', '')}`);
  const filtered = !!(category || unread || q);
  const chip = (active: boolean) => cn('rounded-full border px-2.5 py-1 text-xs', active ? 'border-accent bg-accent text-accent-fg' : 'border-border text-fg-muted hover:text-fg');
  return (
    <>
      <LiveRefresh />
      <PageHeader
        title="Announcements"
        description="News and notices from HR addressed to you."
        actions={can(me, 'announcements:manage') ? (
          <div className="flex flex-wrap gap-2">
            <Link className={buttonClass('primary', 'sm')} href="/announcements/manage/new" data-testid="new-announcement">New announcement or news</Link>
            <Link className={buttonClass('secondary', 'sm')} href="/announcements/manage">Manage announcements</Link>
          </div>
        ) : undefined}
      />
      <ModuleNotices category="announcements" label="Announcement" />
      <div className="grid max-w-3xl gap-4">
        <div className="grid gap-2">
          <form action="/announcements" className="flex gap-2">
            {category && <input type="hidden" name="category" value={category} />}
            {unread && <input type="hidden" name="unread" value="true" />}
            <Input name="q" defaultValue={q} placeholder="Search announcements" aria-label="Search announcements" className="max-w-xs" />
          </form>
          <nav className="flex flex-wrap gap-1.5" aria-label="Filter announcements">
            <Link className={chip(unread)} href={qs({ unread: unread ? undefined : 'true' })} aria-pressed={unread}>Unread or to acknowledge</Link>
            <Link className={chip(!category)} href={qs({ category: undefined })}>All categories</Link>
            {ANNOUNCEMENT_CATEGORIES.map((c) => <Link key={c} className={chip(category === c)} href={qs({ category: c })}>{ANNOUNCEMENT_CATEGORY_LABELS[c]}</Link>)}
          </nav>
        </div>
        {feed.length === 0 && (
          <Card><CardBody><EmptyState icon={<Megaphone className="size-5" />} title={filtered ? 'Nothing matches' : 'No announcements'} description={filtered ? 'Try another filter.' : 'Nothing has been announced to you yet.'} /></CardBody></Card>
        )}
        {feed.map((a) => (
          <Card key={a.id} className={cn(a.priority === 'urgent' && 'border-danger/40', !a.readAt && 'border-l-4 border-l-accent')} data-testid="announcement-card">
            <CardBody>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/announcements/${a.id}`} className="text-[0.9375rem] font-semibold text-fg hover:text-accent hover:underline">{a.title}</Link>
                {a.priority !== 'normal' && <Badge tone={ANN_PRIORITY_TONE[a.priority]}>{ANN_PRIORITY_LABEL[a.priority]}</Badge>}
                <Badge>{a.categoryLabel}</Badge>
                {a.pinned && <Badge>Pinned</Badge>}
                {!a.readAt && <Badge tone="info">New</Badge>}
                {a.needsAck && <Badge tone="warning">{a.acknowledgedEarlierAt ? 'Changed: please acknowledge again' : 'Please acknowledge'}</Badge>}
                {a.requiresAck && !a.needsAck && <Badge tone="success">Acknowledged</Badge>}
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[0.8125rem] text-fg-muted">{a.body}</p>
              <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                <span suppressHydrationWarning>{a.publishedAt && dateTime(a.publishedAt)}{a.publishedByName ? ` · ${a.publishedByName}` : ''}{a.editedAt ? ' · edited' : ''}</span>
                {a.files.length > 0 && <span className="inline-flex items-center gap-1"><Paperclip className="size-3" aria-hidden />{a.files.length}</span>}
              </p>
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
