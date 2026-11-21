'use client';
import { LEAVE_AUTHORITY_LABELS, LEAVE_CATEGORY_LABELS, type LeaveCategory } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { History, ListPlus, Plus, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { LeaveType, StandardLeaveType } from '@/lib/types';
import { addStarterTypesAction, addTemplatesAction, deleteLeaveTypeAction, leaveTypeAction, setLeaveTypeStatusAction } from './actions';
import { type LeaveOptions } from './pickers';
import { byLine, eligibilityText, policyLines } from './policy-text';
import { LeaveTypeEditor } from './type-editor';

const routeText = (t: LeaveType) => t.approval.routes.map((r) => LEAVE_AUTHORITY_LABELS[r]).join(' or ') + (t.approval.employeeChooses ? ' (employee chooses)' : '');

/**
 * Leave types: the Super Workspace creates, edits, deactivates and removes them; an HR Workspace sees the types made
 * available to it, read-only, with the rules the Super Workspace set.
 */
export function TypesPanel({ types, standard, options, canConfigure }: { types: LeaveType[]; standard: StandardLeaveType[]; options: LeaveOptions; canConfigure: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [editing, setEditing] = useState<LeaveType | 'new' | null>(null);
  const [templates, setTemplates] = useState(false);
  const [status, setStatus] = useState<LeaveType | null>(null);
  const [history, setHistory] = useState<LeaveType | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const shown = types.filter((t) => showInactive || t.active);
  const hasStarter = ['PL', 'CL', 'SL'].every((c) => types.some((t) => t.code === c));
  const run = (fn: () => Promise<{ ok: boolean; message?: string; data?: unknown }>, text?: (d: unknown) => string) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: text ? text(r.data) : r.message ?? 'Saved' } : { tone: 'danger', text: r.message ?? 'Something went wrong' });
    if (r.ok) router.refresh();
  });
  return (
    <div className="grid gap-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {!canConfigure && <Alert tone="info">These are the leave types the Super Workspace made available to your HR Workspace. Only the Super Workspace creates or changes them; you allocate them on the Allocation tab.</Alert>}
      <Card>
        <CardHeader title="Leave types" description={canConfigure ? 'Each type carries its own policy, eligibility and approval rules. A change applies to applications made from then on.' : undefined}
          action={canConfigure && (
            <div className="flex flex-wrap gap-2">
              {!hasStarter && <Button size="sm" variant="secondary" loading={pending} data-testid="add-starter-types" onClick={() => run(addStarterTypesAction, (d) => { const x = d as { added: string[] }; return x.added.length ? `Added ${x.added.join(', ')}. Allocate them so people can apply.` : 'They are all there already.'; })}><Sparkles className="size-3.5" /> Add PL, CL and SL</Button>}
              <Button size="sm" variant="secondary" onClick={() => setTemplates(true)}><ListPlus className="size-3.5" /> From templates</Button>
              <Button size="sm" onClick={() => setEditing('new')} data-testid="new-leave-type"><Plus className="size-3.5" /> New leave type</Button>
            </div>
          )} />
        <div className="flex justify-end px-5 pb-2"><Checkbox label="Show inactive types" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /></div>
        {shown.length ? (
          <Table aria-label="Leave types">
            <THead><tr><TH>Leave type</TH><TH>Policy</TH><TH>Eligibility</TH><TH>Approval</TH><TH>Given to</TH><TH>Created</TH><TH /></tr></THead>
            <TBody>
              {shown.map((t) => (
                <TR key={t.id} data-testid={`leave-type-${t.code}`}>
                  <TD className="min-w-48">
                    <div className="flex items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden />
                      <span className="font-medium">{t.name}</span> <Badge>{t.code}</Badge>
                      {!t.active && <Badge tone="warning">Inactive</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-fg-subtle">{LEAVE_CATEGORY_LABELS[t.category as LeaveCategory] ?? t.category} · version {t.version}{t.deactivatedReason ? ` · ${t.deactivatedReason}` : ''}</div>
                  </TD>
                  <TD className="min-w-56 text-xs text-fg-muted">{policyLines(t).slice(0, 4).join(' · ')}</TD>
                  <TD className="min-w-40 text-xs text-fg-muted">{eligibilityText(t, options)}</TD>
                  <TD className="min-w-40 text-xs text-fg-muted">{routeText(t)}{t.approval.managerFirst ? ', manager first' : ''}</TD>
                  <TD className="text-xs text-fg-muted">{t.allocations.employees} allocation{t.allocations.employees === 1 ? '' : 's'}{t.allocations.hrWorkspaces.length ? ` · ${t.allocations.hrWorkspaces.map((w) => w.name).join(', ')}` : ''}</TD>
                  <TD className="min-w-44 text-xs text-fg-muted" data-testid="leave-type-created-by">{t.name} was created by {byLine(t.createdBy)}</TD>
                  <TD>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => start(async () => { const r = await leaveTypeAction(t.id); if (r.ok) setHistory(r.data!); })}><History className="size-3.5" /> History</Button>
                      {canConfigure && <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Edit</Button>}
                      {canConfigure && <Button size="sm" variant="ghost" onClick={() => setStatus(t)}>{t.active ? 'Deactivate' : 'Activate'}</Button>}
                      {canConfigure && !t.used && t.allocations.employees === 0 && t.allocations.hrWorkspaces.length === 0 && (
                        <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Remove ${t.name}? It was never allocated or used.`)) run(() => deleteLeaveTypeAction(t.id), () => `${t.name} removed`); }}>Remove</Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No leave types yet" description={canConfigure ? 'Add Permanent, Casual and Sick Leave to start, or create your own.' : 'The Super Workspace has not made any leave type available to your HR Workspace yet.'} />}
      </Card>
      {editing && <LeaveTypeEditor key={editing === 'new' ? 'new' : editing.id} open onClose={() => setEditing(null)} type={editing === 'new' ? undefined : editing} options={options} />}
      {templates && <TemplatesDialog standard={standard} onClose={() => setTemplates(false)} run={run} />}
      {status && <StatusDialog type={status} onClose={() => setStatus(null)} run={run} />}
      {history && <HistoryDialog type={history} onClose={() => setHistory(null)} options={options} />}
    </div>
  );
}

type Run = (fn: () => Promise<{ ok: boolean; message?: string; data?: unknown }>, text?: (d: unknown) => string) => void;

function TemplatesDialog({ standard, onClose, run }: { standard: StandardLeaveType[]; onClose: () => void; run: Run }) {
  const [codes, setCodes] = useState<string[]>([]);
  return (
    <Dialog open onClose={onClose} title="Add leave types from templates" description="Each starts with common settings you can change. Nothing is allocated until you allocate it."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!codes.length} onClick={() => { run(() => addTemplatesAction(codes), (d) => `Added ${(d as { added: string[] }).added.join(', ') || 'nothing new'}`); onClose(); }}>Add {codes.length || ''}</Button></>}>
      <div className="grid gap-2">
        {standard.map((s) => (
          <Checkbox key={s.code} disabled={s.added} checked={codes.includes(s.code) || s.added} onChange={(e) => setCodes(e.target.checked ? [...codes, s.code] : codes.filter((c) => c !== s.code))}
            label={<span>{s.name} <Badge>{s.code}</Badge>{s.added && <span className="ml-2 text-xs text-fg-subtle">already added</span>}</span>}
            description={`${s.description} ${s.annualEntitlement !== '0' ? `${s.annualEntitlement} days a year.` : ''}`} />
        ))}
      </div>
    </Dialog>
  );
}

function StatusDialog({ type, onClose, run }: { type: LeaveType; onClose: () => void; run: Run }) {
  const [reason, setReason] = useState('');
  const next = !type.active;
  return (
    <Dialog open onClose={onClose} title={`${next ? 'Activate' : 'Deactivate'} ${type.name}`}
      description={next ? 'People it is allocated to can apply for it again.' : 'Nobody can apply for it or be given it. Balances, applications and history stay, and you can activate it again.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={next ? 'primary' : 'danger'} disabled={reason.trim().length < 3} onClick={() => { run(() => setLeaveTypeStatusAction(type.id, next, reason.trim())); onClose(); }}>{next ? 'Activate' : 'Deactivate'}</Button></>}>
      <Field label="Reason" required hint="Kept in the history">{(p) => <Input {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Dialog>
  );
}

const KIND: Record<string, string> = {
  type_created: 'Created', type_updated: 'Changed', type_deactivated: 'Deactivated', type_activated: 'Activated', allocated: 'Allocated', made_available: 'Made available', allocation_revoked: 'Allocation withdrawn',
};

function HistoryDialog({ type, onClose, options }: { type: LeaveType; onClose: () => void; options: LeaveOptions }) {
  return (
    <Dialog open onClose={onClose} size="lg" title={`${type.name}: rules and history`} description={`${type.name} was created by ${byLine(type.createdBy)}. Last changed by ${byLine(type.updatedBy)}.`}>
      <div className="grid gap-4">
        <div className="grid gap-1 text-sm">
          <strong>Policy</strong>
          <ul className="list-disc pl-5 text-fg-muted">{policyLines(type).map((l) => <li key={l}>{l}</li>)}</ul>
          <strong className="mt-2">Eligibility</strong><span className="text-fg-muted">{eligibilityText(type, options)}</span>
          <strong className="mt-2">Approval</strong><span className="text-fg-muted">{routeText(type)}{type.approval.routes.includes('both') || type.approval.routes.length > 1 ? `; with both: ${type.approval.order === 'sequential' ? 'HR Workspace first, then Super Workspace' : 'at the same time'}` : ''}{type.approval.superRequiredOverDays ? `; Super Workspace required above ${type.approval.superRequiredOverDays} days` : ''}{type.approval.escalation.enabled ? `; escalated after ${type.approval.escalation.afterDays} days` : ''}</span>
        </div>
        <Table aria-label="History">
          <THead><tr><TH>When</TH><TH>What</TH><TH>By</TH><TH>Details</TH></tr></THead>
          <TBody>
            {(type.history ?? []).map((h) => (
              <TR key={h.id}>
                <TD className="whitespace-nowrap text-xs">{new Date(h.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</TD>
                <TD>{KIND[h.kind] ?? h.kind}{h.version ? ` (v${h.version})` : ''}</TD>
                <TD className="text-xs">{h.byName ?? '—'}{h.byLevel === 'super' ? ' – Super Workspace' : h.byLevel === 'hr' ? ' – HR Workspace' : ''}</TD>
                <TD className="text-xs text-fg-muted">{[h.changes.length ? `Changed: ${h.changes.join(', ')}` : null, h.note].filter(Boolean).join(' · ')}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </Dialog>
  );
}
