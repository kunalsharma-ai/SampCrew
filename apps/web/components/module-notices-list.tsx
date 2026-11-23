'use client';
import type { NotificationView } from '@crew/contracts';
import { cn } from '@crew/ui';
import { BellRing, Check, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { markCategoryReadAction } from '@/app/(app)/notifications/actions';
import { markNotificationReadAction } from '@/app/(app)/shell-actions';
import { useOptionalLive } from './live';
import { ActionBadge, when } from './notification-bell';

const BAR: Record<string, string> = { low: 'bg-fg-subtle', normal: 'bg-accent', high: 'bg-warning', urgent: 'bg-danger' };

/**
 * The notices strip at the top of a module page. New notices of its categories appear here live; reading one (or all)
 * here marks them read in the bell, on Home and on the phone too.
 */
export function ModuleNoticesList({ categories, category, label, items: initial, exceptKinds = [] }: { categories?: string[]; category?: string; label: string; items: NotificationView[]; exceptKinds?: string[] }) {
  const cats = categories ?? (category ? [category] : []);
  const key = cats.join(',');
  const except = exceptKinds.join(',');
  const live = useOptionalLive();
  const [items, setItems] = useState(initial);
  const [fresh, setFresh] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => setItems(initial), [initial]);
  // A new notice about this module appears here at once.
  useEffect(() => live?.on('notification', (d: { notification: NotificationView; self?: boolean }) => {
    if (!key.split(',').includes(d.notification.category) || d.self || except.split(',').includes(d.notification.kind)) return;
    setFresh(d.notification.id);
    setItems((cur) => [d.notification, ...cur.filter((x) => x.id !== d.notification.id)].slice(0, 5));
  }), [live, key, except]);
  // Read somewhere else (the bell, another tab, the phone): drop it here too.
  useEffect(() => live?.on('notifications.read', (d?: { ids?: string[] }) => {
    // The server says which notices it closed (a request was decided), else the bell's own list knows.
    const readIds = new Set([...(d?.ids ?? []), ...(live?.items ?? []).filter((n) => n.readAt).map((n) => n.id)]);
    setItems((cur) => cur.filter((x) => !readIds.has(x.id)));
  }), [live]);
  if (!items.length) return null;
  const read = (n: NotificationView) => {
    setItems((cur) => cur.filter((x) => x.id !== n.id));
    live?.markRead(n.id);
    void markNotificationReadAction(n.id);
  };
  const readAll = () => start(async () => {
    for (const c of key.split(',')) await markCategoryReadAction(c);
    for (const n of items) live?.markRead(n.id);
    setItems([]);
  });
  const action = items.filter((n) => n.actionRequired).length;
  return (
    <section aria-label={`${label} notices`} data-testid={`module-notices-${cats[0]}`} className="crew-module-notices mb-4 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="flex items-center gap-2 text-[0.8125rem] font-semibold">
          <BellRing className="size-4 text-accent" aria-hidden />
          {items.length} new {label.toLowerCase()} notice{items.length === 1 ? '' : 's'}
          {action > 0 && <span className="rounded-full bg-ember-subtle px-1.5 py-px text-[0.625rem] font-semibold text-ember">{action} need{action === 1 ? 's' : ''} you</span>}
        </span>
        <button type="button" disabled={pending} onClick={readAll} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline disabled:opacity-60"><Check className="size-3.5" aria-hidden />Mark all read</button>
      </div>
      <ul className="divide-y divide-border">
        {items.map((n) => (
          <li key={n.id} className={cn('flex items-stretch gap-3 px-4 py-2 text-[0.8125rem]', fresh === n.id && 'crew-notice-enter')} data-testid="module-notice">
            <span aria-hidden className={cn('w-1 shrink-0 rounded-full', BAR[n.priority])} />
            <div className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                {n.link ? <Link href={n.link} onClick={() => read(n)} className="font-medium hover:underline">{n.title}</Link> : <span className="font-medium">{n.title}</span>}
                {n.actionRequired && <ActionBadge />}
              </span>
              {n.body && <p className="line-clamp-1 text-xs text-fg-muted">{n.body}</p>}
              <p className="text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{when(n.updatedAt)}{n.actorName ? ` · from ${n.actorName}` : ''}</p>
            </div>
            <button type="button" aria-label={`Mark "${n.title}" read`} onClick={() => read(n)} className="self-center rounded p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg"><X className="size-3.5" aria-hidden /></button>
          </li>
        ))}
      </ul>
    </section>
  );
}
