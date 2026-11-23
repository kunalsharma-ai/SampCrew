'use client';
import { SEARCH_TYPE_LABEL, type SearchHit, type SearchResults } from '@crew/contracts';
import { cn, Kbd } from '@crew/ui';
import { ArrowRight, CornerDownLeft, Loader2, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { searchAction } from '@/app/(console)/console-actions';

export interface SearchPage { href: string; label: string; group: string }

/**
 * Global search (Ctrl+K or /): pages of the Console first, then companies, workspaces, users, billing, plans,
 * support, audit and admins from the API, only what the admin's role can open. Arrow keys move, Enter opens.
 */
export function CommandSearch({ pages, compact = false, hotkey = true }: { pages: SearchPage[]; compact?: boolean; hotkey?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hotkey) return;
    const key = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [hotkey]);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 10); else { setQ(''); setRes(null); setActive(0); } }, [open]);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    setLoading(true);
    const t = setTimeout(() => { void searchAction(q).then((r) => { setRes(r); setLoading(false); setActive(0); }); }, 220);
    return () => clearTimeout(t);
  }, [q]);

  const pageHits = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? pages.filter((p) => p.label.toLowerCase().includes(s) || p.group.toLowerCase().includes(s)) : pages).slice(0, s ? 5 : 8);
  }, [pages, q]);
  const items: (SearchHit | (SearchPage & { type: 'page'; id: string; title: string; subtitle: string }))[] = [
    ...pageHits.map((p) => ({ ...p, type: 'page' as const, id: p.href, title: p.label, subtitle: p.group })),
    ...(res?.hits ?? []),
  ];
  const go = (href: string) => { setOpen(false); router.push(href); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    if (e.key === 'Enter' && items[active]) { e.preventDefault(); go(items[active]!.href); }
    if (e.key === 'Escape') setOpen(false);
  };

  let lastGroup = '';
  return (
    <>
      {compact ? <button type="button" onClick={() => setOpen(true)} aria-label="Find anything (Ctrl+K)" className="rounded-lg p-2 text-fg-muted hover:bg-bg-subtle hover:text-fg"><Search className="size-[18px]" aria-hidden /></button> : <button type="button" onClick={() => setOpen(true)} data-testid="console-search" className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-bg-subtle/60 px-3 text-left text-[13px] text-fg-subtle hover:border-border-strong hover:text-fg-muted">
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate">Find companies, workspaces, users, invoices…</span>
        <span className="hidden gap-0.5 sm:flex"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
      </button>}
      {open && createPortal(
        <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 px-4 pt-[10vh]" onMouseDown={() => setOpen(false)}>
          <div role="dialog" aria-label="Search the Console" className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface-raised shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-border px-3">
              {loading ? <Loader2 className="size-4 animate-spin text-fg-subtle" aria-hidden /> : <Search className="size-4 text-fg-subtle" aria-hidden />}
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Type at least 2 letters, a full email, an invoice number…" aria-label="Search" data-testid="console-search-input"
                className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-subtle" role="combobox" aria-expanded aria-controls="console-search-results" aria-activedescendant={items[active] ? `sr-${active}` : undefined} />
              <Kbd>Esc</Kbd>
            </div>
            <ul id="console-search-results" role="listbox" className="max-h-[60vh] overflow-y-auto py-1">
              {items.map((it, i) => {
                const group = it.type === 'page' ? 'Pages' : SEARCH_TYPE_LABEL[it.type];
                const head = group !== lastGroup ? group : null;
                lastGroup = group;
                return (
                  <li key={`${it.type}:${it.id}`} role="presentation">
                    {head && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{head}</div>}
                    <button id={`sr-${i}`} role="option" aria-selected={i === active} type="button" onMouseEnter={() => setActive(i)} onClick={() => go(it.href)} data-testid="console-search-hit"
                      className={cn('flex w-full items-center gap-3 px-3 py-2 text-left', i === active ? 'bg-accent-subtle' : 'hover:bg-bg-subtle')}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{it.title}</span>
                        {it.subtitle && <span className="block truncate text-[11.5px] text-fg-muted">{it.subtitle}</span>}
                      </span>
                      {i === active ? <CornerDownLeft className="size-3.5 text-fg-subtle" aria-hidden /> : <ArrowRight className="size-3.5 text-fg-subtle opacity-0" aria-hidden />}
                    </button>
                  </li>
                );
              })}
              {q.trim().length >= 2 && !loading && res && !res.hits.length && !pageHits.length && <li className="px-3 py-6 text-center text-[13px] text-fg-muted">Nothing found for “{q.trim()}”.</li>}
            </ul>
            {res?.skipped.length ? <p className="border-t border-border px-3 py-2 text-[11.5px] text-fg-subtle">Not searched (your role cannot open them): {res.skipped.map((t) => SEARCH_TYPE_LABEL[t]).join(', ')}.</p> : null}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
