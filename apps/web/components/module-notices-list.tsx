'use client';
import type { NotificationView } from '@crew/contracts';
import { cn } from '@crew/ui';
import { BellRing, Check, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { markCategoryReadAction } from '@/app/(app)/notifications/actions';
import { markNotificationReadAction } from '@/app/(app)/shell-actions';
import { useOptionalLive } from './live';

const BAR: Record<string, string> = { low: 'bg-fg-subtle', normal: 'bg-accent', high: 'bg-warning', urgent: 'bg-danger' };

export function ModuleNoticesList({ category, label, items: initial }: { category: string; label: string; items: NotificationView[] }) {
  const live = useOptionalLive();
  const [items, setItems] = useState(initial);
  const [pending, start] = useTransition();
  useEffect(() => setItems(initial), [initial]);
  // A new notice about this module appears here at once.
  useEffect(() => live?.on('notification', (d: { notification: NotificationView; self?: boolean }) => {
    if (d.notification.category !== category || d.self) return;
    setItems((cur) => [d.notification, ...cur.filter((x) => x.id !== d.notification.id)].slice(0, 4));
  }), [live, category]);
  if (!items.length) return null;
  const read = (n: NotificationView) => {
    setItems((cur) => cur.filter((x) => x.id !== n.id));
    live?.markRead(n.id);
    void markNotificationReadAction(n.id);
  };
  const readAll = () => start(async () => {
    await markCategoryReadAction(category);
    for (const n of items) live?.markRead(n.id);
    setItems([]);
  });
  return (
    <section aria-label={`${label} notices`} data-testid={`module-notices-${category}`} className="mb-4 rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="flex items-center gap-2 text-[0.8125rem] font-semibold"><BellRing className="size-4 text-accent" aria-hidden />{items.length} new {label.toLowerCase()} notice{items.length === 1 ? '' : 's'}</span>
        <button type="button" disabled={pending} onClick={readAll} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline disabled:opacity-60"><Check className="size-3.5" aria-hidden />Mark all read</button>
      </div>
      <ul className="divide-y divide-border">
        {items.map((n) => (
          <li key={n.id} className="flex items-stretch gap-3 px-4 py-2 text-[0.8125rem]">
            <span aria-hidden className={cn('w-1 shrink-0 rounded-full', BAR[n.priority])} />
            <div className="min-w-0 flex-1">
              {n.link ? <Link href={n.link} onClick={() => read(n)} className="font-medium hover:underline">{n.title}</Link> : <span className="font-medium">{n.title}</span>}
              {n.body && <p className="line-clamp-1 text-xs text-fg-muted">{n.body}</p>}
            </div>
            <button type="button" aria-label={`Mark "${n.title}" read`} onClick={() => read(n)} className="self-center rounded p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg"><X className="size-3.5" aria-hidden /></button>
          </li>
        ))}
      </ul>
    </section>
  );
}
