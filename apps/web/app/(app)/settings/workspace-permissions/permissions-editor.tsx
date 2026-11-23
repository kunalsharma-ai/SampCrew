'use client';
import { WORKSPACE_PERMISSION_LEVEL_LABEL, type WorkspacePermissionsView } from '@crew/contracts';
import { Alert, Badge, Button, Card, Input, Select, Switch } from '@crew/ui';
import { ChevronDown, ChevronRight, Lock, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { saveTemplateAction, saveWorkspacePermissionsAction } from './actions';

type Category = WorkspacePermissionsView['categories'][number];
type Item = Category['items'][number];

/**
 * The switches of one level for one group, by category: Select All / Deselect All for everything, for a category or
 * one by one; Expand / Collapse; Save Changes and Reset to Default; templates. Locked items (what a workspace cannot
 * work without) stay on. Nothing is saved until Save Changes.
 */
export function PermissionsEditor({ view, canEdit }: { view: WorkspacePermissionsView; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  const initial = useMemo(() => Object.fromEntries(view.categories.flatMap((c) => c.items.map((i) => [i.key, i.on]))), [view]);
  const [on, setOn] = useState<Record<string, boolean>>(initial);
  const [template, setTemplate] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<Set<string>>(() => new Set(view.categories.slice(0, 2).map((c) => c.key)));
  const [q, setQ] = useState('');
  const editable = (i: Item) => canEdit && !i.locked;
  const all = view.categories.flatMap((c) => c.items);
  const dirty = all.some((i) => on[i.key] !== initial[i.key]);
  const match = (c: Category, i: Item) => !q || `${c.label} ${i.label} ${i.description}`.toLowerCase().includes(q.toLowerCase());
  const shown = view.categories.map((c) => ({ ...c, items: c.items.filter((i) => match(c, i)) })).filter((c) => c.items.length);
  const setMany = (items: Item[], v: boolean) => { setOn((x) => ({ ...x, ...Object.fromEntries(items.filter(editable).map((i) => [i.key, v])) })); setTemplate('custom'); };
  const switches = () => Object.fromEntries(all.filter((i) => !i.locked).map((i) => [i.key, Boolean(on[i.key])]));
  const defaultKey = view.level === 'hr' ? 'hr_default' : 'employee_default';
  const applyTemplate = (key: string) => {
    const t = view.templates.find((x) => x.key === key);
    if (!t) return;
    if (key === 'custom' || !t.permissions) { setTemplate('custom'); return; }
    setOn((x) => ({ ...x, ...t.permissions! }));
    setTemplate(key);
    setNotice({ tone: 'info', text: `${t.label} applied on screen. Press Save Changes to keep it.` });
  };
  const save = () => start(async () => {
    const r = await saveWorkspacePermissionsAction({ level: view.level, groupId: view.groupId, permissions: switches(), template });
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved' } : { tone: 'danger', text: r.message ?? 'Could not save' });
    if (r.ok) router.refresh();
  });
  const saveTemplate = (reset: boolean) => start(async () => {
    const r = await saveTemplateAction(defaultKey, reset ? null : switches());
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved' } : { tone: 'danger', text: r.message ?? 'Could not save' });
    if (r.ok) router.refresh();
  });
  const groupHref = (level: string, groupId?: string) => `/settings/workspace-permissions?${new URLSearchParams({ level, ...(groupId ? { groupId } : {}) })}`;
  const onCount = all.filter((i) => on[i.key]).length;

  return (
    <div className="grid gap-4 pb-20">
      <nav aria-label="Level" className="flex flex-wrap items-center gap-2">
        {(canEdit ? (['hr', 'employee'] as const) : (['hr'] as const)).map((l) => (
          <Link key={l} href={groupHref(l)} aria-current={view.level === l ? 'page' : undefined} data-testid={`perm-level-${l}`}
            className={view.level === l ? 'rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg' : 'rounded-md border border-border px-3 py-1.5 text-sm text-fg-muted hover:text-fg'}>
            {WORKSPACE_PERMISSION_LEVEL_LABEL[l]}
          </Link>
        ))}
        {view.level === 'hr' && view.groups.length > 1 && (
          <label className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-fg-muted">HR Workspace</span>
            <Select aria-label="HR Workspace" value={view.groupId} className="h-9 w-64" data-testid="perm-group" onChange={(e) => router.push(groupHref('hr', e.target.value))}>
              {view.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </label>
        )}
      </nav>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {!canEdit && <Alert tone="info">Only the Super Workspace changes these switches. This is what your workspace may do today.</Alert>}

      <Card className="grid gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <div className="text-sm font-semibold">{view.groupName}</div>
            <div className="text-xs text-fg-muted">{onCount} of {all.length} permissions on{view.updatedAt ? ` · last saved ${new Date(view.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}${view.updatedBy ? ` by ${view.updatedBy}` : ''}` : ' · never changed, defaults apply'}{view.template ? ` · from ${view.templates.find((t) => t.key === view.template)?.label ?? view.template}` : ''}</div>
          </div>
          {canEdit && (
            <label className="ml-auto flex items-center gap-2 text-sm">
              <span className="text-fg-muted">Template</span>
              <Select aria-label="Apply a template" value={template ?? ''} className="h-9 w-60" data-testid="perm-template" onChange={(e) => applyTemplate(e.target.value)}>
                <option value="" disabled>Choose a template</option>
                {view.templates.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                <option value="custom">Custom permissions</option>
              </Select>
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-subtle" aria-hidden />
            <Input aria-label="Search permissions" placeholder="Search permissions" value={q} onChange={(e) => setQ(e.target.value)} className="h-9 w-64 pl-8" />
          </label>
          {canEdit && <Button size="sm" variant="secondary" onClick={() => setMany(all, true)} data-testid="perm-select-all">Select All</Button>}
          {canEdit && <Button size="sm" variant="secondary" onClick={() => setMany(all, false)} data-testid="perm-deselect-all">Deselect All</Button>}
          <Button size="sm" variant="ghost" onClick={() => setOpen(new Set(view.categories.map((c) => c.key)))}>Expand all</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(new Set())}>Collapse all</Button>
        </div>
      </Card>

      {shown.map((c) => {
        const isOpen = open.has(c.key) || Boolean(q);
        const count = c.items.filter((i) => on[i.key]).length;
        return (
          <Card key={c.key} data-testid={`perm-category-${c.key}`}>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <button type="button" className="flex flex-1 items-center gap-2 text-left" aria-expanded={isOpen}
                onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; })}>
                {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                <span>
                  <span className="text-sm font-semibold">{c.label}</span>
                  <span className="ml-2 text-xs text-fg-muted">{count} of {c.items.length} on</span>
                  <span className="block text-xs text-fg-subtle">{c.description}</span>
                </span>
              </button>
              {c.moduleOff && <Badge tone="warning">Module off above: these have no effect</Badge>}
              {canEdit && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setMany(c.items, true)}>Select all</Button>
                  <Button size="sm" variant="ghost" onClick={() => setMany(c.items, false)}>Deselect all</Button>
                </span>
              )}
            </div>
            {isOpen && (
              <ul className="divide-y divide-border border-t border-border">
                {c.items.map((i) => (
                  <li key={i.key} className="flex items-center gap-3 px-4 py-2.5" data-testid={`perm-item-${i.key}`}>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 text-sm">{i.label}{i.locked && <Lock className="size-3.5 text-fg-subtle" aria-label="Always on" />}{on[i.key] !== initial[i.key] && <Badge tone="accent">Changed</Badge>}</div>
                      <div className="text-xs text-fg-muted">{i.description}</div>
                    </div>
                    <Switch checked={Boolean(on[i.key])} disabled={!editable(i) || pending} label={i.label} testId={`perm-switch-${i.key}`}
                      onChange={(v) => { setOn((x) => ({ ...x, [i.key]: v })); setTemplate('custom'); }} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
      {!shown.length && <p className="text-sm text-fg-muted">No permission matches “{q}”.</p>}

      {canEdit && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
            <span className="text-xs text-fg-muted">{dirty ? 'You have unsaved changes.' : 'No unsaved changes.'}</span>
            <span className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => saveTemplate(false)} data-testid="perm-save-template">Save as {view.level === 'hr' ? 'Default HR' : 'Default Employee'} template</Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => { if (confirm('Reset the default template to the SampCrew defaults? Existing workspaces keep their switches.')) saveTemplate(true); }}>Reset template</Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => { applyTemplate(defaultKey); }} data-testid="perm-reset">Reset to Default</Button>
              <Button size="sm" disabled={!dirty && !template} loading={pending} onClick={save} data-testid="perm-save">Save Changes</Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
