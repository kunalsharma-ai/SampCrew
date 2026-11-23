'use client';
import { cn } from '@crew/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

/** A custom date range for the command center: from and to dates, applied to the address so it can be shared. */
export function CustomRange({ active, from, to }: { active: boolean; from?: string; to?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(active);
  const [f, setF] = useState(from ?? '');
  const [t, setT] = useState(to ?? '');
  const bad = !f || !t || f > t;
  const apply = () => {
    if (bad) return;
    const next = new URLSearchParams(params.toString());
    next.set('range', 'custom'); next.set('from', f); next.set('to', t);
    router.push(`/?${next.toString()}`);
  };
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="rounded-md px-2.5 py-1 text-[12.5px] text-fg-muted hover:bg-bg-subtle" data-testid="range-custom">Custom</button>;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5 rounded-md px-1.5 py-0.5', active && 'bg-accent-subtle')} data-testid="range-custom-form">
      <input type="date" aria-label="From" value={f} max={t || undefined} onChange={(e) => setF(e.target.value)} className="h-7 rounded border border-border bg-surface px-1.5 text-[12px]" />
      <span className="text-[12px] text-fg-subtle">to</span>
      <input type="date" aria-label="To" value={t} min={f || undefined} onChange={(e) => setT(e.target.value)} className="h-7 rounded border border-border bg-surface px-1.5 text-[12px]" />
      <button type="button" disabled={bad} onClick={apply} className="h-7 rounded bg-accent px-2 text-[12px] font-medium text-accent-fg disabled:opacity-50">Apply</button>
    </span>
  );
}
