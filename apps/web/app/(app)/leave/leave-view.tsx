'use client';
import { useCreateParam } from '@/lib/use-create-param';
import { Alert, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, StatusPill, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { CalendarPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { LeaveBalance, LeaveRequest } from '@/lib/types';
import { RequestsTable } from '../employees/[id]/tabs';
import { addDefaultLeaveTypesAction, cancelLeaveAction, modifyLeaveAction, type Preview, previewLeaveAction, previewModifyLeaveAction, requestLeaveAction } from './actions';
import { RecordFieldsButton } from '@/components/custom-fields-card';

export function ApplyLeave({ balances }: { balances: LeaveBalance[] }) {
  const [open, setOpen, prefill] = useCreateParam('leave', ['date']);
  if (!balances.length) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}><CalendarPlus className="size-4" /> Apply for leave</Button>
      <LeaveDialog balances={balances} open={open} onClose={() => setOpen(false)} date={prefill.date} />
    </>
  );
}

/** The single-day duration a request shows in the form ("first_half" lives in endHalf for one day). */
const formOf = (r: LeaveRequest) => ({
  leaveTypeId: r.leaveTypeId, startDate: r.startDate, endDate: r.endDate,
  startHalf: r.startDate === r.endDate && r.endHalf === 'first_half' ? 'first_half' : r.startHalf, endHalf: r.startDate === r.endDate ? 'full' : r.endHalf, reason: r.reason ?? '',
});

/** Applying for leave, or changing a request (change set): same fields, live preview, the server's rules. */
function LeaveDialog({ balances, open, onClose, date, change }: { balances: LeaveBalance[]; open: boolean; onClose: () => void; date?: string; change?: LeaveRequest }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState(change ? formOf(change) : { leaveTypeId: balances[0]?.leaveTypeId ?? '', startDate: today, endDate: today, startHalf: 'full', endHalf: 'full', reason: '' });
  // A day chosen on the leave calendar starts the request on that day.
  useEffect(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setForm((f) => ({ ...f, startDate: date, endDate: date }));
  }, [date]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const type = balances.find((b) => b.leaveTypeId === form.leaveTypeId);
  const single = form.startDate === form.endDate;
  const body = () => {
    const b: Record<string, unknown> = { leaveTypeId: form.leaveTypeId, startDate: form.startDate, endDate: form.endDate };
    if (single) {
      if (form.startHalf === 'second_half') b.startHalf = 'second_half';
      if (form.startHalf === 'first_half') b.endHalf = 'first_half';
    } else {
      b.startHalf = form.startHalf;
      b.endHalf = form.endHalf;
    }
    if (form.reason.trim()) b.reason = form.reason.trim();
    return b;
  };

  // Live preview of working days and the balance afterwards, using the same rules as the server.
  useEffect(() => {
    if (!open || !form.leaveTypeId || !form.startDate || !form.endDate) return;
    const t = setTimeout(async () => {
      const r = change ? await previewModifyLeaveAction(change.id, body()) : await previewLeaveAction(body());
      if (r.ok) { setPreview(r.data!); setPreviewError(null); } else { setPreview(null); setPreviewError(r.message); }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.leaveTypeId, form.startDate, form.endDate, form.startHalf, form.endHalf]);

  const formId = change ? `leave-change-${change.id}` : 'leave-form';
  return (
    <Dialog
        open={open}
        onClose={onClose}
        title={change ? 'Change leave request' : 'Apply for leave'}
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} loading={pending} disabled={!!previewError}>{change ? 'Send change' : 'Submit request'}</Button></>}
      >
        <form
          id={formId}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const r = change ? await modifyLeaveAction(change.id, body()) : await requestLeaveAction(body());
              if (r.ok) {
                onClose();
                // The page then says who the request went to.
                router.push(`/leave?sent=${(r.data as { id: string }).id}&month=${form.startDate.slice(0, 7)}`, { scroll: false });
                router.refresh();
              } else setError(r.message);
            });
          }}
        >
          {change && (
            <Alert tone="info" className="sm:col-span-2">
              {change.status === 'approved'
                ? 'This leave is approved. Your change goes to your approver; until it is approved, the leave stays as it is.'
                : 'Changing a request that is waiting sends it back for approval from the first step.'}
            </Alert>
          )}
          {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}
          <Field label="Leave type" className="sm:col-span-2">
            {(p) => (
              <Select {...p} name="leaveTypeId" value={form.leaveTypeId} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}>
                {balances.map((b) => <option key={b.leaveTypeId} value={b.leaveTypeId}>{b.name}{b.tracked ? ` (${b.available} available)` : ''}</option>)}
              </Select>
            )}
          </Field>
          <Field label="From" required>{(p) => <Input {...p} type="date" name="startDate" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: e.target.value > form.endDate ? e.target.value : form.endDate })} required />}</Field>
          <Field label="To" required>{(p) => <Input {...p} type="date" name="endDate" min={form.startDate} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />}</Field>
          {type?.allowHalfDay && (single ? (
            <Field label="Duration" className="sm:col-span-2">
              {(p) => <Select {...p} name="half" value={form.startHalf} onChange={(e) => setForm({ ...form, startHalf: e.target.value, endHalf: 'full' })}><option value="full">Full day</option><option value="first_half">First half</option><option value="second_half">Second half</option></Select>}
            </Field>
          ) : (
            <>
              <Field label="First day">{(p) => <Select {...p} name="startHalf" value={form.startHalf} onChange={(e) => setForm({ ...form, startHalf: e.target.value })}><option value="full">Full day</option><option value="second_half">From the second half</option></Select>}</Field>
              <Field label="Last day">{(p) => <Select {...p} name="endHalf" value={form.endHalf} onChange={(e) => setForm({ ...form, endHalf: e.target.value })}><option value="full">Full day</option><option value="first_half">Until the first half</option></Select>}</Field>
            </>
          ))}
          <Field label="Reason" className="sm:col-span-2">{(p) => <Textarea {...p} name="reason" maxLength={1000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}</Field>
          <div className="sm:col-span-2" aria-live="polite">
            {previewError ? <Alert tone="warning">{previewError}</Alert> : preview && (
              <div className="rounded-lg border border-border bg-bg-subtle/60 px-4 py-3 text-[0.8125rem]">
                <strong className="tabular-nums">{preview.days} working day{preview.days === '1.00' ? '' : 's'}</strong>
                {preview.tracked && <> · balance after approval <strong className="tabular-nums">{preview.balanceAfter}</strong></>}
                {preview.holidaysInRange.length > 0 && <span className="block text-xs text-fg-subtle">Holidays in range are not counted: {preview.holidaysInRange.join(', ')}</span>}
                {preview.warnings.map((w) => <span key={w} className="block text-xs text-warning">{w}</span>)}
              </div>
            )}
          </div>
        </form>
      </Dialog>
  );
}

export function MyRequests({ requests, balances, hasFields }: { requests: LeaveRequest[]; balances: LeaveBalance[]; hasFields?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState<LeaveRequest | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  // Approved leave with a change waiting cannot be changed again until that change is decided.
  const changeWaiting = new Set(requests.filter((r) => r.status === 'pending' && r.replacesRequestId).map((r) => r.replacesRequestId!));
  const byId = new Map(requests.map((r) => [r.id, r]));
  return (
    <>
      {error && <div className="px-5"><Alert tone="danger">{error}</Alert></div>}
      <RequestsTable
        requests={requests}
        actions={(r) => {
          const open = r.status === 'pending' || (r.status === 'approved' && r.startDate > today);
          const replaces = r.replacesRequestId ? byId.get(r.replacesRequestId) : undefined;
          return (
            <div className="flex flex-wrap items-center justify-end gap-1">
              {r.replacesRequestId && <span className="text-xs text-fg-muted" data-testid="leave-change-note">Change to {replaces ? `${replaces.leaveTypeName} ${replaces.startDate}` : 'approved leave'}</span>}
              {!!r.modifications?.length && <span className="text-xs text-fg-muted" title={r.modifications.map((m) => `Was ${m.leaveTypeName ?? ''} ${m.startDate} to ${m.endDate} (${m.days})`).join('\n')}>Changed {r.modifications.length}×</span>}
              {changeWaiting.has(r.id) && <span className="text-xs text-warning">Change waiting for approval</span>}
              {hasFields && <RecordFieldsButton entity="leave_request" recordId={r.id} />}
              {open && !changeWaiting.has(r.id) && <Button size="sm" variant="ghost" disabled={pending} onClick={() => setChanging(r)}>Change</Button>}
              {open && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
                  const reason = prompt('Cancel this request? Add a reason (optional):');
                  if (reason === null) return;
                  start(async () => { const res = await cancelLeaveAction(r.id, reason || undefined); if (res.ok) router.refresh(); else setError(res.message); });
                }}>Cancel</Button>
              )}
            </div>
          );
        }}
      />
      {changing && <LeaveDialog key={changing.id} balances={balances} open onClose={() => setChanging(null)} change={changing} />}
    </>
  );
}

export function TeamAway({ rows }: { rows: LeaveRequest[] }) {
  return (
    <Card>
      <CardHeader title="Who is away in the next 30 days" description="People whose leave you can see, including requests still waiting for approval." />
      {rows.length ? (
        <Table>
          <THead><tr><TH>Person</TH><TH>Type</TH><TH>From</TH><TH>To</TH><TH>Days</TH><TH>Status</TH></tr></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id}>
                <TD className="font-medium">{r.employeeName}</TD>
                <TD>{r.leaveTypeName}</TD>
                <TD className="whitespace-nowrap">{r.startDate}</TD>
                <TD className="whitespace-nowrap">{r.endDate}</TD>
                <TD className="tabular-nums">{r.days}</TD>
                <TD><StatusPill status={r.status} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="Nobody is away" />}
    </Card>
  );
}

export function AddDefaultLeaveTypes() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error && <span className="mb-2 block text-danger">{error}</span>}
      <Button size="sm" loading={pending} onClick={() => start(async () => { const r = await addDefaultLeaveTypesAction(); if (r.ok) router.refresh(); else setError(r.message); })}>
        Add standard leave types
      </Button>
    </>
  );
}
