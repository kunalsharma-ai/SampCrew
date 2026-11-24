'use client';
import { Card, EmptyState, Input } from '@crew/ui';
import { ChevronDown, ChevronRight, Circle, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ICONS } from '@/lib/icons';
import type { SettingsCategory } from '@/lib/settings-hub';

export function SettingsHub({ categories }: { categories: SettingsCategory[] }) {
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const needle = q.trim().toLowerCase();
  const shown = categories
    .map((c) => ({ ...c, items: c.items.filter((i) => !needle || `${c.label} ${i.label} ${i.description} ${i.keywords ?? ''}`.toLowerCase().includes(needle)) }))
    .filter((c) => c.items.length);
  return (
    <div className="grid gap-4">
      <label className="relative max-w-xl">
        <Search className="pointer-events-none absolute left-3 top-3 size-4 text-fg-subtle" aria-hidden />
        <Input aria-label="Search settings" placeholder="Search settings, such as leave, holidays or permissions" value={q} onChange={(e) => setQ(e.target.value)} className="h-10 pl-9" data-testid="settings-search" />
      </label>
      {shown.map((c) => {
        const open = Boolean(needle) || !closed.has(c.key);
        return (
          <Card key={c.key} data-testid={`settings-category-${c.key}`}>
            <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 px-5 py-3 text-left"
              onClick={() => setClosed((s) => { const n = new Set(s); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; })}>
              {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              <span><span className="text-sm font-semibold">{c.label}</span><span className="block text-xs text-fg-muted">{c.description}</span></span>
              <span className="ml-auto text-xs text-fg-subtle">{c.items.length}</span>
            </button>
            {open && (
              <ul className="grid gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
                {c.items.map((i) => {
                  const Icon = ICONS[i.icon] ?? Circle;
                  return (
                    <li key={i.href} className="bg-bg">
                      <Link href={i.href} className="flex h-full items-start gap-3 px-5 py-3 hover:bg-bg-subtle">
                        <Icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                        <span><span className="text-sm font-medium">{i.label}</span><span className="block text-xs text-fg-muted">{i.description}</span></span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        );
      })}
      {!shown.length && <EmptyState title="Nothing matches" description={`No setting matches “${q}”.`} />}
    </div>
  );
}
