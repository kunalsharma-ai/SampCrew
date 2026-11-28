'use client';
import { REQUEST_WORKFLOWS, type RequestCategory, type RequestSettings, type RequestWorkflow } from '@crew/contracts';
import { Alert, Button, Field, Input, Select, Switch, cn } from '@crew/ui';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveRequestSettingsAction } from '../../requests/actions';
import { KindTile } from '../../requests/kind-visual';

const LEVELS = [{ key: 'employee', label: 'Employee Workspace' }, { key: 'hr', label: 'HR Workspace' }, { key: 'super', label: 'Super Workspace' }] as const;

export function RequestSettingsEditor({ initial, canManage, workflows }: { initial: RequestSettings; canManage: boolean; workflows: Record<RequestWorkflow, string> }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [newLabel, setNewLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const setCat = (key: string, patch: Partial<RequestCategory>) => setS((cur) => ({ ...cur, categories: cur.categories.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));
  const add = () => {
    const label = newLabel.trim();
    if (label.length < 2) return;
    const key = `custom_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'request'}`;
    if (s.categories.some((c) => c.key === key)) { setError('A category with this name already exists'); return; }
    setS((cur) => ({ ...cur, categories: [...cur.categories, { key, kind: 'other', label, description: '', enabled: true, workflow: 'all', attachments: 'optional', levels: ['super', 'hr', 'employee'], custom: true, icon: 'message-square-plus', color: '#475569', timing: 'days' }] }));
    setNewLabel('');
  };
  const save = () => start(async () => {
    setError(null);
    const r = await saveRequestSettingsAction({
      approvedLeaveCancellation: s.approvedLeaveCancellation, reminderDaysBefore: s.reminderDaysBefore, defaultPrimary: s.defaultPrimary, hrAsApprover: s.hrAsApprover,
      categories: s.categories.map(({ key, label, description, enabled, workflow, attachments, levels, custom }) => ({ key, label, description, enabled, workflow, attachments, levels, custom })),
    });
    if (!r.ok) { setError(r.message); return; }
    setS(r.data!.settings);
    router.refresh();
  });
  return (
    <div className="grid gap-6">
      {!canManage && <Alert tone="info">Only the Super Workspace changes these settings. You can see how requests are handled.</Alert>}
      <section aria-labelledby="cats" className="rounded-2xl border border-border bg-surface shadow-card">
        <div className="border-b border-border p-4"><h2 id="cats" className="text-[0.9375rem] font-semibold">Request categories</h2><p className="text-xs text-fg-muted">Switch a category off to hide it from the forms. Existing requests keep their history.</p></div>
        <ul className="divide-y divide-border" data-testid="request-categories">
          {s.categories.map((c) => (
            <li key={c.key} className={cn('grid gap-3 p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_auto] lg:items-center', !c.enabled && 'opacity-60')} data-testid={`category-${c.key}`}>
              <div className="flex min-w-0 items-center gap-3">
                <KindTile kind={c.kind} size="sm" />
                <div className="min-w-0 flex-1">
                  <Input aria-label={`Name of ${c.label}`} value={c.label} disabled={!canManage} onChange={(e) => setCat(c.key, { label: e.target.value })} className="h-8" />
                  <div className="mt-0.5 truncate text-[0.6875rem] text-fg-subtle">{c.custom ? 'Your own category' : 'Built in'}</div>
                </div>
              </div>
              <Select aria-label={`How ${c.label} is approved`} value={c.workflow} disabled={!canManage} onChange={(e) => setCat(c.key, { workflow: e.target.value as RequestWorkflow })} data-testid={`workflow-${c.key}`}>
                {REQUEST_WORKFLOWS.map((w) => <option key={w} value={w}>{workflows[w]}</option>)}
              </Select>
              <Select aria-label={`Documents for ${c.label}`} value={c.attachments} disabled={!canManage} onChange={(e) => setCat(c.key, { attachments: e.target.value as RequestCategory['attachments'] })}>
                <option value="none">No documents</option><option value="optional">Documents optional</option><option value="required">Document required</option>
              </Select>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Who may raise ${c.label}`}>
                {LEVELS.map((l) => {
                  const on = c.levels.includes(l.key);
                  return <button key={l.key} type="button" disabled={!canManage} aria-pressed={on} onClick={() => setCat(c.key, { levels: on ? c.levels.filter((x) => x !== l.key) : [...c.levels, l.key] })}
                    className={cn('rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ring-1', on ? 'bg-accent-subtle text-accent ring-accent/30' : 'text-fg-muted ring-border')}>{l.label}</button>;
                })}
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={c.enabled} disabled={!canManage} onChange={(v) => setCat(c.key, { enabled: v })} label={`${c.label} switched on`} testId={`enabled-${c.key}`} />
                {c.custom && canManage && <button type="button" onClick={() => setS((cur) => ({ ...cur, categories: cur.categories.filter((x) => x.key !== c.key) }))} className="rounded p-1 text-fg-subtle hover:bg-bg-subtle hover:text-danger" aria-label={`Remove ${c.label}`}><Trash2 className="size-4" /></button>}
              </div>
            </li>
          ))}
        </ul>
        {canManage && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border p-4">
            <Field label="Add a category" className="min-w-64 flex-1" help={false}>{(a) => <Input {...a} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={60} placeholder="For example: Training request" />}</Field>
            <Button variant="secondary" onClick={add} disabled={newLabel.trim().length < 2}><Plus className="size-4" /> Add</Button>
          </div>
        )}
      </section>

      <section aria-labelledby="rules" className="grid gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card sm:grid-cols-2">
        <h2 id="rules" className="text-[0.9375rem] font-semibold sm:col-span-2">Approvers and rules</h2>
        <Field label="Primary approver suggested on a new request" help={false}>
          {(a) => <Select {...a} value={s.defaultPrimary} disabled={!canManage} onChange={(e) => setS({ ...s, defaultPrimary: e.target.value as 'manager' | 'hr' })}><option value="manager">The reporting manager</option><option value="hr">The HR manager</option></Select>}
        </Field>
        <Field label="Add the HR manager as an approver to start with" help={false}>
          {(a) => <Select {...a} value={s.hrAsApprover ? 'yes' : 'no'} disabled={!canManage} onChange={(e) => setS({ ...s, hrAsApprover: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No</option></Select>}
        </Field>
        <Field label="Cancelling approved leave" help={false}>
          {(a) => <Select {...a} value={s.approvedLeaveCancellation} disabled={!canManage} onChange={(e) => setS({ ...s, approvedLeaveCancellation: e.target.value as 'approval' | 'before_start' })} data-testid="leave-cancellation-policy"><option value="approval">Always through the approvers</option><option value="before_start">Straight away before it starts, through the approvers after</option></Select>}
        </Field>
        <Field label="Remind approvers before a pending request starts (days)" help={false}>
          {(a) => <Input {...a} type="number" min={0} max={14} value={s.reminderDaysBefore} disabled={!canManage} onChange={(e) => setS({ ...s, reminderDaysBefore: Math.max(0, Math.min(14, Number(e.target.value) || 0)) })} />}
        </Field>
      </section>

      {canManage && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} loading={pending} data-testid="save-request-settings"><Save className="size-4" /> Save settings</Button>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </div>
  );
}
