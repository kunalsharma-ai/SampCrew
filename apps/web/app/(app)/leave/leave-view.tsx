'use client';
import { useCreateParam } from '@/lib/use-create-param';
import { Alert, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, StatusPill, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { CalendarPlus, ChevronDown, ChevronUp, Paperclip, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { LeaveBalance, LeaveRequest } from '@/lib/types';
import { RequestsTable } from '../employees/[id]/tabs';
import { cancelLeaveAction, leaveFormAction, type LeaveRoute, modifyLeaveAction, type Preview, previewLeaveAction, previewModifyLeaveAction, requestLeaveAction, uploadLeaveDocumentAction } from './actions';
import { FieldInput, RecordFieldsButton } from '@/components/custom-fields-card';
import { checkFieldValue, type FormView } from '@crew/contracts';

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
  route: (r.approvalRoute ?? '') as LeaveRoute | '',
});

/** Applying for leave, or changing a request (change set): same fields, live preview, the server's rules. */
export function LeaveDialog({ balances, open, onClose, date, change, forEmployee }: { balances: LeaveBalance[]; open: boolean; onClose: () => void; date?: string; change?: LeaveRequest; forEmployee?: { id: string; name: string } }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState(change ? formOf(change) : { leaveTypeId: balances[0]?.leaveTypeId ?? '', startDate: today, endDate: today, startHalf: 'full', endHalf: 'full', reason: '', route: '' as LeaveRoute | '' });
  // A day chosen on the leave calendar starts the request on that day.
  useEffect(() => {
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) setForm((f) => ({ ...f, startDate: date, endDate: date }));
  }, [date]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [docs, setDocs] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  // The form as the Super Workspace set it up (Form management, issue #91): the reason's rule and custom fields.
  const [formView, setFormView] = useState<FormView | null>(null);
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const [extraErrors, setExtraErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open || formView) return;
    let live = true;
    void leaveFormAction().then((r) => { if (live && r.ok && r.data) setFormView(r.data); });
    return () => { live = false; };
  }, [open, formView]);
  const reasonRule = formView?.resolved.find((f) => f.key === 'reason');
  const showReason = reasonRule?.visible ?? true;
  // Files are attached from the request's Details after it is sent; every other type is asked here.
  const extraFields = (formView?.customFields ?? []).filter((f) => f.enabled && !f.archivedAt && f.type !== 'file');
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
    if (form.route) b.approvalRoute = form.route;
    if (docs.length) b.documentIds = docs.map((d) => d.id);
    if (extraFields.length) b.customFields = Object.fromEntries(Object.entries(extra).filter(([, x]) => x !== undefined && x !== null && x !== ''));
    // HR applying for one of their people (the API checks they approve leave for them).
    if (forEmployee && !change) b.employeeId = forEmployee.id;
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
  }, [open, form.leaveTypeId, form.startDate, form.endDate, form.startHalf, form.endHalf, form.route, docs.length]);

  const formId = change ? `leave-change-${change.id}` : 'leave-form';
  return (
    <Dialog
        open={open}
        onClose={onClose}
        title={change ? 'Change leave request' : forEmployee ? `Apply for leave for ${forEmployee.name}` : 'Apply for leave'}
        footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form={formId} loading={pending} disabled={!!previewError || uploading}>{change ? 'Send change' : 'Submit request'}</Button></>}
      >
        <form
          id={formId}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            // The same checks the API makes, so a missing reason or field shows next to it at once.
            const local: Record<string, string> = {};
            if (showReason && reasonRule?.required && !form.reason.trim()) local.reason = `${reasonRule.label} is required`;
            for (const f of extraFields) { const c = checkFieldValue(f, extra[f.key] ?? null); if (!c.ok) local[f.key] = c.error; }
            setExtraErrors(local);
            if (Object.keys(local).length) { setError('Some fields need attention'); return; }
            start(async () => {
              const r = change ? await modifyLeaveAction(change.id, body()) : await requestLeaveAction(body());
              if (r.ok && forEmployee) {
                onClose();
                router.refresh();
              } else if (r.ok) {
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
          {forEmployee && !balances.length && <Alert tone="warning" className="sm:col-span-2">No leave type is available to {forEmployee.name} yet. Create one in Leave management, or check who it is visible to.</Alert>}
          <Field label="Leave type" className="sm:col-span-2">
            {(p) => (
              <Select {...p} name="leaveTypeId" value={form.leaveTypeId} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value, route: '' })}>
                {balances.map((b) => <option key={b.leaveTypeId} value={b.leaveTypeId}>{b.name}{b.tracked ? ` (${b.available} available)` : b.notAssigned ? ' (Not Assigned)' : ''}</option>)}
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
          {preview?.employeeChooses && preview.routes && preview.routes.length > 1 && (
            <fieldset className="grid gap-2 sm:col-span-2" data-testid="leave-route-choice">
              <legend className="mb-1 text-[0.8125rem] font-medium">Send it to</legend>
              {preview.routes.map((r) => (
                <label key={r.route} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-[0.8125rem]">
                  <input type="radio" name="approvalRoute" className="mt-0.5" value={r.route} checked={(form.route || preview.route) === r.route} onChange={() => setForm({ ...form, route: r.route })} />
                  <span><span className="font-medium">{r.label}</span>{r.reviewers.join(' and ') !== r.label && <span className="block text-xs text-fg-subtle">{r.reviewers.join(' and ')}</span>}</span>
                </label>
              ))}
            </fieldset>
          )}
          {preview?.documents && preview.documents.mode !== 'none' && (
            <div className="grid gap-2 sm:col-span-2">
              <span className="text-[0.8125rem] font-medium">Supporting document{preview.documents.required ? ' (required)' : ' (optional)'}</span>
              {preview.documents.note && <span className="text-xs text-fg-subtle">{preview.documents.note}</span>}
              {docs.map((d) => (
                <span key={d.id} className="flex items-center gap-2 text-xs"><Paperclip className="size-3.5" />{d.name}
                  <button type="button" aria-label={`Remove ${d.name}`} className="text-fg-subtle hover:text-danger" onClick={() => setDocs(docs.filter((x) => x.id !== d.id))}><X className="size-3.5" /></button>
                </span>
              ))}
              {docs.length < 5 && (
                <Input type="file" aria-label="Attach a document" data-testid="leave-document" disabled={uploading} accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.txt" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  setUploading(true);
                  const fd = new FormData();
                  fd.append('file', f);
                  const r = await uploadLeaveDocumentAction(fd);
                  setUploading(false);
                  if (r.ok) setDocs((d) => [...d, { id: r.data!.id, name: r.data!.name }]); else setError(r.message);
                }} />
              )}
            </div>
          )}
          {showReason && <Field label={reasonRule?.label ?? 'Reason'} required={reasonRule?.required} hint={reasonRule?.hint ?? undefined} error={extraErrors.reason} className="sm:col-span-2">{(p) => <Textarea {...p} name="reason" maxLength={1000} placeholder={reasonRule?.placeholder ?? undefined} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}</Field>}
          {!change && extraFields.map((f) => (
            <FieldInput key={f.id} r={{ field: f, value: extra[f.key] ?? null, text: '', editable: true, fits: true }} value={extra[f.key] ?? null} onChange={(x) => setExtra((cur) => ({ ...cur, [f.key]: x }))} error={extraErrors[f.key]} entity="leave_request" recordId="" />
          ))}
          <div className="sm:col-span-2" aria-live="polite">
            {previewError ? <Alert tone="warning">{previewError}</Alert> : preview && (
              <div className="rounded-lg border border-border bg-bg-subtle/60 px-4 py-3 text-[0.8125rem]">
                <strong className="tabular-nums">{preview.days} working day{preview.days === '1.00' ? '' : 's'}</strong>
                {preview.tracked && <> · balance after approval <strong className="tabular-nums">{preview.balanceAfter}</strong></>}
                {preview.reviewers && preview.reviewers.length > 0 && <span className="block text-xs text-fg-muted" data-testid="leave-reviewers">Goes to {preview.reviewers.join(preview.order === 'sequential' ? ', then ' : ' and ')}{preview.managerFirst ? ', after your reporting manager' : ''}</span>}
                {preview.holidaysInRange.length > 0 && <span className="block text-xs text-fg-subtle">Holidays in range are not counted: {preview.holidaysInRange.join(', ')}</span>}
                {preview.warnings.map((w) => <span key={w} className="block text-xs text-warning">{w}</span>)}
              </div>
            )}
          </div>
        </form>
      </Dialog>
  );
}

/** How many requests "My requests" shows before "Show all" (issue #91 point 2: long lists stay manageable). */
export const MY_REQUESTS_PREVIEW = 5;

/**
 * "My requests" as a card that collapses and expands. Open by default with the latest few; "Show all" lists the rest.
 * Requests still waiting are always among those shown, so nothing that needs the person is hidden.
 */
export function MyRequestsCard({ requests, balances, hasFields }: { requests: LeaveRequest[]; balances: LeaveBalance[]; hasFields?: boolean }) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const waiting = requests.filter((r) => r.status === 'pending');
  const shown = all ? requests : [...waiting, ...requests.filter((r) => r.status !== 'pending')].slice(0, Math.max(MY_REQUESTS_PREVIEW, waiting.length));
  const hidden = requests.length - shown.length;
  return (
    <Card data-testid="my-requests">
      <CardHeader
        title="My requests"
        description="A request waiting for approval can be changed or cancelled. Approved leave that has not started can be changed too: the change goes for approval and replaces it once approved."
        action={
          <div className="flex items-center gap-2">
          {requests.length > 0 && <span className="text-xs text-fg-muted tabular-nums" data-testid="my-requests-count">{requests.length} {requests.length === 1 ? 'request' : 'requests'}</span>}
          <Button size="sm" variant="ghost" aria-expanded={open} data-testid="my-requests-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? <><ChevronUp className="size-4" /> Collapse</> : <><ChevronDown className="size-4" /> Expand</>}
          </Button>
          </div>
        }
      />
      {open && (
        <>
          <MyRequests requests={shown} allRequests={requests} balances={balances} hasFields={hasFields} />
          {(hidden > 0 || all) && requests.length > MY_REQUESTS_PREVIEW && (
            <div className="flex justify-center border-t border-border px-5 py-3">
              <Button size="sm" variant="secondary" data-testid="my-requests-more" onClick={() => setAll((a) => !a)}>
                {all ? 'Show fewer' : `Show all ${requests.length} requests`}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function MyRequests({ requests, allRequests, balances, hasFields }: { requests: LeaveRequest[]; allRequests?: LeaveRequest[]; balances: LeaveBalance[]; hasFields?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState<LeaveRequest | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  // Approved leave with a change waiting cannot be changed again until that change is decided.
  const every = allRequests ?? requests;
  const changeWaiting = new Set(every.filter((r) => r.status === 'pending' && r.replacesRequestId).map((r) => r.replacesRequestId!));
  const byId = new Map(every.map((r) => [r.id, r]));
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
                <Button size="sm" variant="ghost" data-feature="leave.cancel" disabled={pending} onClick={() => {
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
