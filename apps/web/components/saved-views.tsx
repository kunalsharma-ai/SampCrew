'use client';
import type { SavedView, ViewPage, ViewState } from '@crew/contracts';
import { Button, Input, cn } from '@crew/ui';
import { Bookmark, Check, ChevronDown, Star, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { createViewAction, deleteViewAction, updateViewAction } from '@/app/(app)/experience-actions';

/** Two states are the same view when filters, sort, columns and density match (empty filters ignored). */
export function sameState(a: ViewState, b: ViewState) {
  const clean = (s: ViewState) => JSON.stringify({
    f: Object.fromEntries(Object.entries(s.filters ?? {}).filter(([, v]) => v).sort(([x], [y]) => x.localeCompare(y))),
    s: s.sort ?? null, d: s.dir ?? null, c: s.columns ?? null, n: s.density ?? null,
  });
  return clean(a) === clean(b);
}

/**
 * The saved-views menu for a list: switch views, save the current filters, sort, columns and density under a
 * name, update the active view, choose a default (opened automatically) or delete. Views are stored per person.
 */
export function SavedViews({ page, allLabel, views, activeId, current, onApply }: {
  page: ViewPage;
  allLabel: string;
  views: SavedView[];
  activeId: string | null;
  current: ViewState;
  onApply: (view: SavedView | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState(views);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setList(views), [views]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const active = list.find((v) => v.id === activeId) ?? null;
  const modified = active ? !sameState(active.state, current) : false;

  const save = () => start(async () => {
    setError(null);
    const r = await createViewAction(page, name.trim(), current, makeDefault);
    if (!r.ok) { setError(r.message); return; }
    const v = r.data!;
    setList((l) => [...l.map((x) => (v.isDefault ? { ...x, isDefault: false } : x)), v]);
    setNaming(false);
    setName('');
    setMakeDefault(false);
    setOpen(false);
    onApply(v);
  });
  const update = () => start(async () => {
    if (!active) return;
    const r = await updateViewAction(active.id, { state: current });
    if (r.ok) setList((l) => l.map((x) => (x.id === active.id ? r.data! : x)));
    else setError(r.message);
  });
  const toggleDefault = (v: SavedView) => start(async () => {
    const r = await updateViewAction(v.id, { isDefault: !v.isDefault });
    if (r.ok) setList((l) => l.map((x) => (x.id === v.id ? r.data! : r.data!.isDefault ? { ...x, isDefault: false } : x)));
    else setError(r.message);
  });
  const remove = (v: SavedView) => start(async () => {
    const r = await deleteViewAction(v.id);
    if (!r.ok) { setError(r.message); return; }
    setList((l) => l.filter((x) => x.id !== v.id));
    if (v.id === activeId) onApply(null);
  });

  return (
    <div className="relative flex items-center gap-2" ref={ref}>
      {active && modified && (
        <Button size="sm" variant="secondary" onClick={update} loading={pending}>Update “{active.name}”</Button>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Saved views, showing ${active ? active.name : allLabel}${modified ? ' (changed)' : ''}`}
        className="inline-flex h-8 max-w-56 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[0.8125rem] text-fg hover:bg-bg-subtle"
      >
        <Bookmark className="size-3.5 shrink-0 text-fg-subtle" />
        <span className="truncate">{active ? active.name : allLabel}{modified ? ' *' : ''}</span>
        <ChevronDown className="size-3 shrink-0" />
      </button>
      {open && (
        <div role="menu" aria-label="Saved views" className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-surface-raised p-1.5 shadow-pop">
          <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.8125rem] hover:bg-bg-subtle" onClick={() => { setOpen(false); onApply(null); }}>
            <Check className={cn('size-3.5', active ? 'opacity-0' : 'text-accent')} /> {allLabel}
          </button>
          {list.map((v) => (
            <div key={v.id} className="group flex items-center gap-1 rounded-md hover:bg-bg-subtle">
              <button type="button" role="menuitem" className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[0.8125rem]" onClick={() => { setOpen(false); onApply(v); }}>
                <Check className={cn('size-3.5 shrink-0', v.id === activeId ? 'text-accent' : 'opacity-0')} />
                <span className="truncate">{v.name}</span>
                {v.isDefault && <span className="text-[0.6875rem] text-fg-subtle">default</span>}
              </button>
              <button type="button" className={cn('rounded p-1 hover:text-fg', v.isDefault ? 'text-warning' : 'text-fg-subtle')} onClick={() => toggleDefault(v)} aria-label={v.isDefault ? `Stop opening ${v.name} by default` : `Open ${v.name} by default`}>
                <Star className={cn('size-3.5', v.isDefault && 'fill-current')} />
              </button>
              <button type="button" className="rounded p-1 text-fg-subtle hover:text-danger" onClick={() => remove(v)} aria-label={`Delete view ${v.name}`}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          <div className="mt-1 border-t border-border pt-1.5">
            {naming ? (
              <form className="space-y-2 px-1" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save(); }}>
                <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="View name" aria-label="View name" />
                <label className="flex items-center gap-2 text-[0.8125rem] text-fg-muted">
                  <input type="checkbox" className="size-3.5" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} /> Open this view by default
                </label>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" type="button" onClick={() => setNaming(false)}>Cancel</Button>
                  <Button size="sm" type="submit" loading={pending} disabled={!name.trim()}>Save view</Button>
                </div>
              </form>
            ) : (
              <button type="button" role="menuitem" className="w-full rounded-md px-2 py-1.5 text-left text-[0.8125rem] font-medium text-accent hover:bg-bg-subtle" onClick={() => setNaming(true)}>
                Save current view…
              </button>
            )}
            {error && <p className="px-2 pt-1 text-xs text-danger" role="alert">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
