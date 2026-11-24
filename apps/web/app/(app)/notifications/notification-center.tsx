'use client';
import { NOTIFICATION_CATEGORIES, type NotificationView } from '@crew/contracts';
import { Badge, Button, Card, EmptyState, Input, Select, cn } from '@crew/ui';
import { Bell, CheckCheck, Mail, MailOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { useLive, useRefreshOn } from '@/components/live';
import { ActionBadge, CATEGORY_LABEL, NotificationIcon, originOf, when } from '@/components/notification-bell';
import { ICONS } from '@/lib/icons';
import { markNotificationReadAction } from '../shell-actions';
import { loadMoreNotificationsAction, markCategoryReadAction, markUnreadAction } from './actions';
import type { NotificationSummary } from './page';

const PRIORITY_BADGE: Record<string, { tone: 'neutral' | 'info' | 'warning' | 'danger'; label: string } | null> = {
  low: null,
  normal: null,
  high: { tone: 'warning', label: 'Important' },
  urgent: { tone: 'danger', label: 'Urgent' },
};

export function NotificationCenter({ list, summary, query, filter, category, search, priority }: {
  list: { unread: number; items: NotificationView[]; nextBefore: string | null };
  summary: NotificationSummary;
  query: string;
  filter: 'all' | 'unread' | 'read' | 'action';
  category: string | null;
  search: string;
  priority: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const live = useLive();
  const [items, setItems] = useState(list.items);
  const [next, setNext] = useState(list.nextBefore);
  const [q, setQ] = useState(search);
  const [pending, start] = useTransition();
  useEffect(() => {
    setItems(list.items);
    setNext(list.nextBefore);
  }, [list]);
  // New notices and reads made elsewhere (another tab, the bell) show here at once.
  useRefreshOn(['notification', 'notifications.read']);

  const nav = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) (v ? sp.set(k, v) : sp.delete(k));
    router.push(`${pathname}${sp.size ? `?${sp}` : ''}`);
  };
  const byCat = new Map(summary.categories.map((c) => [c.category, c]));

  const open = (n: NotificationView) => start(async () => {
    if (!n.readAt) {
      live.markRead(n.id);
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      await markNotificationReadAction(n.id);
    }
    if (n.link) router.push(n.link);
  });
  const toggle = (n: NotificationView) => start(async () => {
    if (n.readAt) await markUnreadAction(n.id);
    else await markNotificationReadAction(n.id);
    setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, readAt: n.readAt ? null : new Date().toISOString() } : x)));
    router.refresh();
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <nav aria-label="Notification categories" className="grid content-start gap-1">
        <CategoryButton active={!category} label="All notifications" icon="bell" unread={summary.unread} onClick={() => nav({ category: null })} />
        {NOTIFICATION_CATEGORIES.filter((c) => (byCat.get(c.key)?.total ?? 0) > 0 || c.key === category).map((c) => (
          <CategoryButton key={c.key} active={category === c.key} label={c.label} icon={c.icon} unread={byCat.get(c.key)?.unread ?? 0} onClick={() => nav({ category: c.key })} />
        ))}
      </nav>
      <div className="grid content-start gap-3">
        {summary.important.length > 0 && !category && filter !== 'read' && (
          <Card className="border-warning/40 p-4" data-testid="important-notifications">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-warning">Important and unread</div>
            <ul className="grid gap-1">
              {summary.important.map((n) => (
                <li key={n.id}><button className="text-left text-[0.8125rem] font-medium hover:underline" onClick={() => open(n)}>{n.title}</button></li>
              ))}
            </ul>
          </Card>
        )}
        <Card className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-bg-subtle p-1" role="radiogroup" aria-label="Show">
              {(['all', 'unread', 'action', 'read'] as const).map((f) => (
                <button key={f} role="radio" aria-checked={filter === f} data-testid={`filter-${f}`} onClick={() => nav({ filter: f === 'all' ? null : f })} className={cn('rounded-md px-3 py-1 text-xs font-medium', filter === f ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg')}>
                  {f === 'action' ? 'Action needed' : f[0]!.toUpperCase() + f.slice(1)}
                  {f === 'action' && (summary.actionNeeded ?? 0) > 0 && <span className="ml-1 rounded-full bg-ember px-1.5 text-[0.625rem] font-semibold text-white">{summary.actionNeeded}</span>}
                </button>
              ))}
            </div>
            <Select aria-label="Priority" className="h-8 w-36" value={priority} onChange={(e) => nav({ priority: e.target.value || null })}>
              <option value="">Any priority</option>
              <option value="urgent">Urgent</option>
              <option value="high">Important</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </Select>
            <form className="flex min-w-40 flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); nav({ q: q.trim() || null }); }}>
              <Input aria-label="Search notifications" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="h-8" />
            </form>
            <Button size="sm" variant="secondary" loading={pending} disabled={!(category ? byCat.get(category as never)?.unread : summary.unread)} onClick={() => start(async () => {
              await markCategoryReadAction(category ?? undefined);
              if (!category) live.markAllRead();
              setItems((cur) => cur.map((x) => (x.readAt ? x : { ...x, readAt: new Date().toISOString() })));
              router.refresh();
            })}>
              <CheckCheck className="size-4" /> {category ? `Mark ${CATEGORY_LABEL[category]?.toLowerCase()} read` : 'Mark all read'}
            </Button>
          </div>
        </Card>
        {items.length === 0 ? (
          <Card><EmptyState icon={<Bell className="size-5" />} title={filter === 'unread' ? 'No unread notifications' : filter === 'action' ? 'Nothing waiting for you' : 'No notifications here'} description="When something needs you, it shows here, on Home and on the bell." /></Card>
        ) : (
          <Card className="divide-y divide-border p-0" data-testid="notification-list">
            {items.map((n) => (
              <div key={n.id} className={cn('flex gap-3 px-4 py-3', !n.readAt && 'bg-accent-subtle/30')} data-testid="notification-item">
                <NotificationIcon n={n} />
                <button className="min-w-0 flex-1 text-left" onClick={() => open(n)}>
                  <span className="flex flex-wrap items-center gap-2">
                    {!n.readAt && <span className="size-2 rounded-full bg-accent" aria-label="Unread" />}
                    <span className="text-[0.8125rem] font-semibold text-fg">{n.title}</span>
                    {PRIORITY_BADGE[n.priority] && <Badge tone={PRIORITY_BADGE[n.priority]!.tone}>{PRIORITY_BADGE[n.priority]!.label}</Badge>}
                    {n.actionRequired && !n.readAt && <ActionBadge />}
                    {n.count > 1 && <Badge>{n.count} updates</Badge>}
                  </span>
                  {n.body && <span className="mt-0.5 block whitespace-pre-line text-xs text-fg-muted">{n.body}</span>}
                  <span className="mt-1 block text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>
                    {originOf(n)}{n.actorName ? ` · from ${n.actorName}` : ''} · {when(n.updatedAt)}
                  </span>
                </button>
                <button className="self-start rounded-md p-1.5 text-fg-subtle hover:bg-bg-subtle hover:text-fg" aria-label={n.readAt ? 'Mark unread' : 'Mark read'} title={n.readAt ? 'Mark unread' : 'Mark read'} onClick={() => toggle(n)}>
                  {n.readAt ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
                </button>
              </div>
            ))}
          </Card>
        )}
        {next && (
          <Button variant="secondary" loading={pending} onClick={() => start(async () => {
            const sp = new URLSearchParams(query);
            sp.set('before', next);
            const r = await loadMoreNotificationsAction(sp.toString());
            if (r.ok) {
              setItems((cur) => [...cur, ...r.data!.items.filter((x) => !cur.some((c) => c.id === x.id))]);
              setNext(r.data!.nextBefore);
            }
          })}>Show older notifications</Button>
        )}
        <p className="text-xs text-fg-subtle">Choose what you are told about, by email too, on <Link href="/settings/notifications" className="underline">Notification settings</Link>.</p>
      </div>
    </div>
  );
}

function CategoryButton({ active, label, icon, unread, onClick }: { active: boolean; label: string; icon: string; unread: number; onClick: () => void }) {
  const Icon = ICONS[icon] ?? Bell;
  return (
    <button onClick={onClick} aria-current={active ? 'page' : undefined} className={cn('flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[0.8125rem]', active ? 'bg-accent-subtle font-semibold text-fg' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
      <Icon className="size-4 shrink-0 text-accent" />
      <span className="flex-1 truncate">{label}</span>
      {unread > 0 && <span className="rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold leading-4 text-accent-fg">{unread}</span>}
    </button>
  );
}
