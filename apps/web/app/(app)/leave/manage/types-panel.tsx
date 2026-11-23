'use client';
import { LEAVE_VISIBILITIES, LEAVE_VISIBILITY_LABELS, leaveCodeFrom, type LeaveVisibility } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, Textarea, TH, THead, TR } from '@crew/ui';
import { History, Plus, SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { LeaveType } from '@/lib/types';
import { createLeaveTypeAction, deleteLeaveTypeAction, leaveTypeAction, setLeaveTypeStatusAction, setLeaveVisibilityAction, updateLeaveTypeAction } from './actions';
import { type LeaveOptions } from './pickers';
import { byLine } from './policy-text';
import { LeaveTypeEditor } from './type-editor';

type Run = (fn: () => Promise<{ ok: boolean; message?: string; data?: unknown }>, text?: (d: unknown) => string) => void;
const VIS_TONE: Record<LeaveVisibility, 'info' | 'accent' | 'neutral'> = { hr: 'info', employee: 'accent', both: 'neutral' };

/**
 * Leave types, the simple way: a name, a description, an optional code, who sees it (HR Workspace, Employee
 * Workspace or both) and whether it is active. Nothing is allocated or calculated; quantities are typed on the
 * Quantities tab. The Super Workspace manages every type; an HR Workspace manages only its own, and only when the
 * Super Workspace allowed it in Workspace Permissions (the API checks every action again).
 */
export function TypesPanel({ types, options, isSuper, canCreate, canVisibility }: { types: LeaveType[]; options: LeaveOptions; isSuper: boolean; canCreate: boolean; canVisibility: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [form, setForm] = useState<LeaveType | 'new' | null>(null);
  const [rules, setRules] = useState<LeaveType | null>(null);
  const [status, setStatus] = useState<LeaveType | null>(null);
  const [history, setHistory] = useState<LeaveType | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const shown = types.filter((t) => showInactive || t.active);
  const run: Run = (fn, text) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: text ? text(r.data) : r.message ?? 'Saved' } : { tone: 'danger', text: r.message ?? 'Something went wrong' });
    if (r.ok) router.refresh();
  });
  const owner = (t: LeaveType) => t.owner.level === 'super' ? 'Super Workspace' : `HR Workspace${t.owner.hrWorkspaceName ? `: ${t.owner.hrWorkspaceName}` : ''}`;
  return (
    <div className="grid gap-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {!isSuper && !canCreate && <Alert tone="info">You can review applications for these leave types. Creating your own types is switched on by the Super Workspace in Settings, Workspace Permissions.</Alert>}
      <Card>
        <CardHeader title="Leave types"
          description="A new type shows up at once wherever it is visible. Turning a type off or changing who sees it stops new applications there; every past application and quantity stays."
          action={canCreate && <Button size="sm" onClick={() => setForm('new')} data-testid="new-leave-type"><Plus className="size-3.5" /> Create New Leave Type</Button>} />
        <div className="flex justify-end px-5 pb-2"><Checkbox label="Show inactive types" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /></div>
        {shown.length ? (
          <Table aria-label="Leave types">
            <THead><tr><TH>Leave type</TH><TH>Visible to</TH><TH>Status</TH><TH>Created by</TH><TH /></tr></THead>
            <TBody>
              {shown.map((t) => (
                <TR key={t.id} data-testid={`leave-type-${t.code}`}>
                  <TD className="min-w-56">
                    <div className="flex items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden />
                      <span className="font-medium">{t.name}</span> <Badge>{t.code}</Badge>
                    </div>
                    {t.description && <div className="mt-0.5 max-w-md text-xs text-fg-muted">{t.description}</div>}
                    <div className="mt-0.5 text-xs text-fg-subtle">Managed by {owner(t)}</div>
                  </TD>
                  <TD>
                    {t.canManage && (isSuper || canVisibility) ? (
                      <Select aria-label={`Who sees ${t.name}`} value={t.visibility} disabled={pending} className="h-8 w-52 text-xs" data-testid={`visibility-${t.code}`}
                        onChange={(e) => run(() => setLeaveVisibilityAction(t.id, e.target.value as LeaveVisibility), () => `${t.name} is now visible to ${LEAVE_VISIBILITY_LABELS[e.target.value as LeaveVisibility]}`)}>
                        {LEAVE_VISIBILITIES.map((v) => <option key={v} value={v}>{LEAVE_VISIBILITY_LABELS[v]}</option>)}
                      </Select>
                    ) : <Badge tone={VIS_TONE[t.visibility]}>{t.visibilityLabel}</Badge>}
                  </TD>
                  <TD>{t.active ? <Badge tone="success" dot>Active</Badge> : <Badge tone="warning" dot>Inactive</Badge>}{t.deactivatedReason && !t.active && <div className="mt-0.5 text-xs text-fg-subtle">{t.deactivatedReason}</div>}</TD>
                  <TD className="min-w-44 text-xs text-fg-muted" data-testid="leave-type-created-by">{byLine(t.createdBy)}</TD>
                  <TD>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => start(async () => { const r = await leaveTypeAction(t.id); if (r.ok) setHistory(r.data!); })}><History className="size-3.5" /> History</Button>
                      {t.canManage && <Button size="sm" variant="ghost" onClick={() => setForm(t)}>Edit</Button>}
                      {isSuper && <Button size="sm" variant="ghost" onClick={() => setRules(t)}><SlidersHorizontal className="size-3.5" /> Rules</Button>}
                      {t.canManage && <Button size="sm" variant="ghost" onClick={() => setStatus(t)}>{t.active ? 'Turn off' : 'Turn on'}</Button>}
                      {isSuper && !t.used && (
                        <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Remove ${t.name}? Nobody has applied for it yet.`)) run(() => deleteLeaveTypeAction(t.id), () => `${t.name} removed`); }}>Remove</Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No leave types yet" description={canCreate ? 'Create the first one: give it a name and choose who sees it.' : 'No leave type is visible to you yet.'} />}
      </Card>
      {form && <TypeForm key={form === 'new' ? 'new' : form.id} type={form === 'new' ? undefined : form} isSuper={isSuper} canVisibility={isSuper || canVisibility} hrWorkspaces={isSuper ? [] : options.hrWorkspaces} onClose={() => setForm(null)} run={run} />}
      {rules && <LeaveTypeEditor key={rules.id} open onClose={() => setRules(null)} type={rules} options={options} />}
      {status && <StatusDialog type={status} onClose={() => setStatus(null)} run={run} />}
      {history && <HistoryDialog type={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** + Create New Leave Type (and Edit): the five fields the spec asks for, nothing more. */
function TypeForm({ type, isSuper, canVisibility, hrWorkspaces, onClose, run }: { type?: LeaveType; isSuper: boolean; canVisibility: boolean; hrWorkspaces: { id: string; name: string }[]; onClose: () => void; run: Run }) {
  const [f, setF] = useState({
    name: type?.name ?? '', description: type?.description ?? '', code: type?.code ?? '', visibility: (type?.visibility ?? 'both') as LeaveVisibility,
    status: type ? (type.active ? 'active' : 'inactive') : 'active', hrWorkspaceId: hrWorkspaces[0]?.id ?? '',
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const valid = f.name.trim().length > 0;
  const save = () => {
    if (type) {
      const body: Record<string, unknown> = { name: f.name.trim(), description: f.description.trim(), version: type.version };
      if (f.code.trim() && f.code.trim().toUpperCase() !== type.code) body.code = f.code.trim();
      if (canVisibility && f.visibility !== type.visibility) body.visibility = f.visibility;
      run(() => updateLeaveTypeAction(type.id, body), () => `${f.name.trim()} saved`);
    } else {
      const body: Record<string, unknown> = { name: f.name.trim(), description: f.description.trim() || undefined, code: f.code.trim(), visibility: f.visibility, status: f.status };
      if (!isSuper && hrWorkspaces.length > 1) body.hrWorkspaceId = f.hrWorkspaceId;
      run(() => createLeaveTypeAction(body), () => `${f.name.trim()} created and visible to ${LEAVE_VISIBILITY_LABELS[f.visibility]}`);
    }
    onClose();
  };
  return (
    <Dialog open onClose={onClose} title={type ? `Edit ${type.name}` : 'Create New Leave Type'}
      description={type ? 'Applications already made keep the name they were made under in their history.' : 'It appears at once in every workspace it is visible to. Quantities are not given automatically: assign them on the Quantities tab, or leave them Not Assigned.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!valid} onClick={save} data-testid="save-leave-type">{type ? 'Save' : 'Create leave type'}</Button></>}>
      <div className="grid gap-3">
        <Field label="Leave type name" required>{(p) => <Input {...p} value={f.name} maxLength={80} placeholder="Casual Leave" onChange={(e) => set('name', e.target.value)} data-testid="leave-type-name" />}</Field>
        <Field label="Description">{(p) => <Textarea {...p} value={f.description} maxLength={500} rows={2} onChange={(e) => set('description', e.target.value)} />}</Field>
        <Field label="Leave code" hint={`Optional. Left empty: ${f.name.trim() ? leaveCodeFrom(f.name) : 'made from the name'}`}>{(p) => <Input {...p} value={f.code} maxLength={10} className="uppercase" onChange={(e) => set('code', e.target.value)} />}</Field>
        <Field label="Visibility" hint={canVisibility ? undefined : 'The Super Workspace has not allowed you to change visibility'}>{(p) => (
          <Select {...p} value={f.visibility} disabled={!canVisibility && Boolean(type)} onChange={(e) => set('visibility', e.target.value as LeaveVisibility)} data-testid="leave-type-visibility">
            {LEAVE_VISIBILITIES.map((v) => <option key={v} value={v}>{LEAVE_VISIBILITY_LABELS[v]}</option>)}
          </Select>
        )}</Field>
        {!type && (
          <Field label="Status">{(p) => (
            <Select {...p} value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="active">Active</option><option value="inactive">Inactive</option>
            </Select>
          )}</Field>
        )}
        {!type && hrWorkspaces.length > 1 && (
          <Field label="For HR Workspace" required>{(p) => (
            <Select {...p} value={f.hrWorkspaceId} onChange={(e) => set('hrWorkspaceId', e.target.value)}>
              {hrWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          )}</Field>
        )}
      </div>
    </Dialog>
  );
}

function StatusDialog({ type, onClose, run }: { type: LeaveType; onClose: () => void; run: Run }) {
  const [reason, setReason] = useState('');
  const next = !type.active;
  return (
    <Dialog open onClose={onClose} title={`${next ? 'Turn on' : 'Turn off'} ${type.name}`}
      description={next ? 'People it is visible to can apply for it again.' : 'Nobody can make a new application for it. Past applications, quantities and history stay, and you can turn it on again.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={next ? 'primary' : 'danger'} disabled={reason.trim().length < 3} onClick={() => { run(() => setLeaveTypeStatusAction(type.id, next, reason.trim())); onClose(); }}>{next ? 'Turn on' : 'Turn off'}</Button></>}>
      <Field label="Reason" required hint="Kept in the history">{(p) => <Input {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Dialog>
  );
}

const KIND: Record<string, string> = {
  type_created: 'Created', type_updated: 'Changed', type_deactivated: 'Turned off', type_activated: 'Turned on', visibility_changed: 'Visibility changed',
  allocated: 'Allocated (before 23 Nov 2026)', made_available: 'Made available (before 23 Nov 2026)', allocation_revoked: 'Allocation withdrawn (before 23 Nov 2026)',
};

function HistoryDialog({ type, onClose }: { type: LeaveType; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} size="lg" title={`${type.name}: history`} description={`Created by ${byLine(type.createdBy)}. Last changed by ${byLine(type.updatedBy)}.`}>
      <Table aria-label="History">
        <THead><tr><TH>When</TH><TH>What</TH><TH>By</TH><TH>Details</TH></tr></THead>
        <TBody>
          {(type.history ?? []).map((h) => (
            <TR key={h.id}>
              <TD className="whitespace-nowrap text-xs">{new Date(h.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</TD>
              <TD>{KIND[h.kind] ?? h.kind}{h.version ? ` (v${h.version})` : ''}</TD>
              <TD className="text-xs">{h.byName ?? '—'}{h.byLevel === 'super' ? ', Super Workspace' : h.byLevel === 'hr' ? ', HR Workspace' : ''}</TD>
              <TD className="text-xs text-fg-muted">{[h.changes.length ? `Changed: ${h.changes.join(', ')}` : null, h.note].filter(Boolean).join(' · ')}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Dialog>
  );
}
