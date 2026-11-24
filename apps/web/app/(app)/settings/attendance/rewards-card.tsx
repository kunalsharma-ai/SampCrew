'use client';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/api';
import type { LeaveBalance, RewardRule } from '@/lib/types';
import { addDefaultRewardsAction, deleteRewardRuleAction, saveRewardRuleAction } from './rewards-actions';

type LeaveType = Pick<LeaveBalance, 'leaveTypeId' | 'name'>;
const KIND = { perfect_attendance: 'Perfect attendance', punctuality: 'Punctuality' } as const;
const BLANK: Omit<RewardRule, 'id'> = { name: '', kind: 'perfect_attendance', description: null, icon: 'trophy', active: true, maxLateDays: 0, excusedLeaveTypeIds: [], allowHalfDays: false, minWorkingDays: 10, payoutType: 'none', payoutAmount: null, payoutLeaveTypeId: null, payoutDays: null };

/** HR's attendance reward rules: what employees see as rewards on Home each month. */
export function RewardsCard({ rules, leaveTypes, currency }: { rules: RewardRule[]; leaveTypes: LeaveType[]; currency: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [edit, setEdit] = useState<(Omit<RewardRule, 'id'> & { id?: string }) | null>(null);
  const [errors, setErrors] = useState<{ message: string; fields: Record<string, string> } | null>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, done?: () => void) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message });
    setErrors(r.ok ? null : { message: r.message, fields: r.fieldErrors ?? {} });
    if (r.ok) { done?.(); router.refresh(); }
  });
  const name = (id: string) => leaveTypes.find((t) => t.leaveTypeId === id)?.name ?? 'Leave type';
  const days = (d: string | null) => `${Number(d ?? 0)} ${Number(d) === 1 ? 'day' : 'days'}`;
  const pays = (r: Omit<RewardRule, 'id'>) =>
    r.payoutType === 'bonus' ? `Bonus ${currency} ${Number(r.payoutAmount ?? 0).toLocaleString('en-IN')} in payroll` : r.payoutType === 'leave_credit' ? `${days(r.payoutDays)} of ${name(r.payoutLeaveTypeId ?? '')}` : null;
  return (
    <Card>
      <CardHeader
        title="Attendance rewards"
        description="Monthly rewards employees see on Home. Only working days count: holidays and weekly offs never do, and excused leave types never break a reward."
        action={<div className="flex gap-2">{!rules.length && <Button size="sm" variant="secondary" loading={pending} onClick={() => run(addDefaultRewardsAction)}>Add the standard rules</Button>}<Button size="sm" onClick={() => { setErrors(null); setEdit({ ...BLANK }); }}>New reward</Button></div>}
      />
      <div className="grid gap-3 px-5 pb-5">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {rules.length ? (
          <ul className="grid gap-2">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><b>{r.name}</b><Badge tone="neutral">{KIND[r.kind]}</Badge>{pays(r) ? <Badge tone="success">{pays(r)}</Badge> : <Badge tone="neutral">Recognition only</Badge>}{!r.active && <Badge tone="warning">Off</Badge>}</div>
                  <div className="text-xs text-fg-muted">
                    {r.maxLateDays ? `Up to ${r.maxLateDays} late days allowed` : 'No late days allowed'} · at least {r.minWorkingDays} working days
                    {r.excusedLeaveTypeIds.length ? ` · excused: ${r.excusedLeaveTypeIds.map(name).join(', ')}` : ''}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => { setErrors(null); setEdit({ ...r }); }}>Edit</Button>
                  <Button data-delete-area="settings" data-delete="reward rule" size="sm" variant="ghost" loading={pending} onClick={() => run(() => deleteRewardRuleAction(r.id))}>Remove</Button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-fg-muted">No rewards yet. Employees see them on Home once you add one.</p>}
      </div>
      <Dialog
        open={!!edit}
        onClose={() => { setEdit(null); setErrors(null); }}
        title={edit?.id ? 'Edit reward' : 'New reward'}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button loading={pending} disabled={!edit?.name.trim()} onClick={() => edit && run(() => saveRewardRuleAction(edit.id ?? null, { ...edit, id: undefined }), () => setEdit(null))}>Save</Button></>}
      >
        {edit && (
          <div className="grid gap-4">
            {errors && <Alert tone="danger">{errors.message}</Alert>}
            <Field label="Name" required>{(p) => <Input {...p} value={edit.name} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Kind">{(p) => <Select {...p} value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as RewardRule['kind'] })}><option value="perfect_attendance">Perfect attendance</option><option value="punctuality">Punctuality</option></Select>}</Field>
              <Field label="Badge">{(p) => <Select {...p} value={edit.icon} onChange={(e) => setEdit({ ...edit, icon: e.target.value as RewardRule['icon'] })}><option value="trophy">Trophy</option><option value="medal">Medal</option><option value="star">Star</option><option value="clock">Clock</option></Select>}</Field>
              <Field label="Late days allowed in the month">{(p) => <Input {...p} type="number" min={0} max={31} value={edit.maxLateDays} onChange={(e) => setEdit({ ...edit, maxLateDays: Number(e.target.value) })} />}</Field>
              <Field label="Working days needed in the month">{(p) => <Input {...p} type="number" min={1} max={31} value={edit.minWorkingDays} onChange={(e) => setEdit({ ...edit, minWorkingDays: Number(e.target.value) })} />}</Field>
            </div>
            <Field label="Description shown to employees">{(p) => <Textarea {...p} rows={2} maxLength={300} value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value || null })} />}</Field>
            {leaveTypes.length > 0 && (
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Leave that does not break the reward</legend>
                {leaveTypes.map((t) => <Checkbox key={t.leaveTypeId} label={t.name} checked={edit.excusedLeaveTypeIds.includes(t.leaveTypeId)} onChange={(e) => setEdit({ ...edit, excusedLeaveTypeIds: e.target.checked ? [...edit.excusedLeaveTypeIds, t.leaveTypeId] : edit.excusedLeaveTypeIds.filter((x) => x !== t.leaveTypeId) })} />)}
              </fieldset>
            )}
            <fieldset className="grid gap-3 rounded-lg border border-border p-3" data-testid="reward-payout">
              <legend className="px-1 text-sm font-medium">What winners get</legend>
              <Field label="Payout" hint="HR grants it to each month’s winners from Reward winners below. A bonus is paid with the next payroll run; leave is credited at once.">
                {(p) => (
                  <Select {...p} value={edit.payoutType} onChange={(e) => setEdit({ ...edit, payoutType: e.target.value as RewardRule['payoutType'] })}>
                    <option value="none">Recognition only</option>
                    <option value="bonus">Bonus in payroll</option>
                    <option value="leave_credit">Extra leave</option>
                  </Select>
                )}
              </Field>
              {edit.payoutType === 'bonus' && (
                <Field label={`Bonus amount (${currency})`} required error={errors?.fields.payoutAmount}>{(p) => <Input {...p} inputMode="decimal" value={edit.payoutAmount ?? ''} placeholder="500" onChange={(e) => setEdit({ ...edit, payoutAmount: e.target.value.trim() || null })} />}</Field>
              )}
              {edit.payoutType === 'leave_credit' && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Leave type to credit" required error={errors?.fields.payoutLeaveTypeId}>
                    {(p) => (
                      <Select {...p} value={edit.payoutLeaveTypeId ?? ''} onChange={(e) => setEdit({ ...edit, payoutLeaveTypeId: e.target.value || null })}>
                        <option value="">Choose…</option>
                        {leaveTypes.map((t) => <option key={t.leaveTypeId} value={t.leaveTypeId}>{t.name}</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label="Days" required error={errors?.fields.payoutDays}>{(p) => <Input {...p} inputMode="decimal" value={edit.payoutDays ?? ''} placeholder="1" onChange={(e) => setEdit({ ...edit, payoutDays: e.target.value.trim() || null })} />}</Field>
                </div>
              )}
            </fieldset>
            <Checkbox label="Half days still count" checked={edit.allowHalfDays} onChange={(e) => setEdit({ ...edit, allowHalfDays: e.target.checked })} />
            <Checkbox label="Active" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />
          </div>
        )}
      </Dialog>
    </Card>
  );
}
