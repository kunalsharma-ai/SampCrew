'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Select, StatusPill, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { CheckCircle2, Circle, Download, Eye, FileText, Lock, Pencil, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import type { ActionResult } from '@/lib/api';
import type { Department, Designation, Employee, EmployeeDocument, EmployeeProfile, JobRecord, LeaveBalance, LeaveRequest, LegalEntity, LifecycleEvent, Location, OnboardingTask } from '@/lib/types';
import {
  archiveDocumentAction, jobChangeAction, lifecycleAction, saveSensitiveAction, sensitiveAction, taskStatusAction, updateEmployeeAction, uploadDocumentAction,
} from '../actions';

const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg">{children ?? '—'}</dd>
    </div>
  );
}

/** Small dialog form that posts through a server action, shows API errors and refreshes on success. */
function ActionDialog({ open, onClose, title, description, submit, danger, children, run }: {
  open: boolean; onClose: () => void; title: string; description?: string; submit: string; danger?: boolean; children: ReactNode; run: (f: FormData) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  return (
    <Dialog
      open={open}
      onClose={() => { setError(null); setFe({}); onClose(); }}
      title={title}
      description={description}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="action-form" variant={danger ? 'danger' : 'primary'} loading={pending}>{submit}</Button></>}
    >
      <form
        id="action-form"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setError(null);
          start(async () => {
            const r = await run(f);
            if (r.ok) { onClose(); router.refresh(); } else { setError(r.message); setFe(r.fieldErrors ?? {}); }
          });
        }}
      >
        {error && <Alert tone="danger" className="sm:col-span-2">{error}{Object.keys(fe).length > 0 && <ul className="mt-1 list-disc pl-4 text-xs">{Object.entries(fe).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>}</Alert>}
        {children}
      </form>
    </Dialog>
  );
}

const pick = (f: FormData, keys: string[], nullable = false) => {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = String(f.get(k) ?? '').trim();
    if (v) out[k] = v;
    else if (nullable && f.has(k)) out[k] = null;
  }
  return out;
};

// -------------------------------------------------------------------------------------------------------------
// Overview
// -------------------------------------------------------------------------------------------------------------

export function OverviewTab({ e }: { e: EmployeeProfile }) {
  const [edit, setEdit] = useState(false);
  const editable = e.can.update || e.can.updateOwn;
  const fields = e.can.update ? ['firstName', 'lastName', 'preferredName', 'workEmail', 'personalEmail', 'phone', 'dateOfBirth', 'gender'] : ['preferredName', 'personalEmail', 'phone'];
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Personal and contact details" action={editable && <Button size="sm" variant="secondary" onClick={() => setEdit(true)}><Pencil className="size-3.5" /> Edit</Button>} />
        <CardBody>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Detail label="Legal name">{`${e.firstName} ${e.lastName}`.trim()}</Detail>
            <Detail label="Preferred name">{e.preferredName}</Detail>
            <Detail label="Work email">{e.workEmail}</Detail>
            <Detail label="Personal email">{e.personalEmail}</Detail>
            <Detail label="Phone">{e.phone}</Detail>
            <Detail label="Date of birth">{e.dateOfBirth}</Detail>
            <Detail label="Gender">{e.gender ? humanize(e.gender) : null}</Detail>
            <Detail label="SampCrew login">{e.membershipId ? humanize(e.loginStatus ?? 'linked') : 'No login (records only)'}</Detail>
          </dl>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Employment" />
        <CardBody>
          <dl className="grid gap-4">
            <Detail label="Joined">{e.dateOfJoining}</Detail>
            <Detail label="Probation ends">{e.probationEndDate}</Detail>
            <Detail label="Confirmed on">{e.confirmationDate}</Detail>
            <Detail label="Type">{humanize(e.employmentType)}</Detail>
            <Detail label="Reports to">{e.managerEmployeeId ? <Link className="text-accent hover:underline" href={`/employees/${e.managerEmployeeId}`}>{e.managerName}</Link> : null}</Detail>
            {e.lastWorkingDay && <Detail label="Last working day">{e.lastWorkingDay}</Detail>}
          </dl>
        </CardBody>
      </Card>
      {e.can.viewSensitive && <SensitiveCard e={e} />}
      <ActionDialog
        open={edit}
        onClose={() => setEdit(false)}
        title="Edit details"
        description={e.can.update ? undefined : 'You can change your preferred name and contact details. HR maintains the rest.'}
        submit="Save"
        run={(f) => updateEmployeeAction(e.id, pick(f, fields, true))}
      >
        {e.can.update && <>
          <Field label="First name" required>{(p) => <Input {...p} name="firstName" defaultValue={e.firstName} required />}</Field>
          <Field label="Last name">{(p) => <Input {...p} name="lastName" defaultValue={e.lastName} />}</Field>
        </>}
        <Field label="Preferred name">{(p) => <Input {...p} name="preferredName" defaultValue={e.preferredName ?? ''} />}</Field>
        {e.can.update && <Field label="Work email">{(p) => <Input {...p} name="workEmail" type="email" defaultValue={e.workEmail ?? ''} />}</Field>}
        <Field label="Personal email">{(p) => <Input {...p} name="personalEmail" type="email" defaultValue={e.personalEmail ?? ''} />}</Field>
        <Field label="Phone">{(p) => <Input {...p} name="phone" type="tel" defaultValue={e.phone ?? ''} />}</Field>
        {e.can.update && <>
          <Field label="Date of birth">{(p) => <Input {...p} name="dateOfBirth" type="date" defaultValue={e.dateOfBirth ?? ''} />}</Field>
          <Field label="Gender">
            {(p) => (
              <Select {...p} name="gender" defaultValue={e.gender ?? ''}>
                <option value="">Not recorded</option><option value="female">Female</option><option value="male">Male</option><option value="non_binary">Non-binary</option><option value="undisclosed">Prefer not to say</option>
              </Select>
            )}
          </Field>
        </>}
      </ActionDialog>
    </div>
  );
}

function SensitiveCard({ e }: { e: EmployeeProfile }) {
  const [data, setData] = useState<Record<string, string | null> | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [edit, setEdit] = useState(false);
  const [pending, start] = useTransition();
  const reveal = () => start(async () => {
    const r = await sensitiveAction(e.id);
    if (r.ok) { setData(r.data ?? {}); setError(null); } else setError({ message: r.message, code: r.code });
  });
  const canEdit = e.can.update || e.can.updateOwn;
  return (
    <Card className="lg:col-span-3">
      <CardHeader
        title={<span className="flex items-center gap-2"><Lock className="size-4 text-fg-subtle" /> Bank, tax and ID details</span>}
        description="Stored encrypted. Viewing them needs two-step verification and is recorded in the audit trail."
        action={<span className="flex gap-2">
          {!data && <Button size="sm" variant="secondary" loading={pending} onClick={reveal}><Eye className="size-3.5" /> Show</Button>}
          {data && canEdit && <Button size="sm" variant="secondary" onClick={() => setEdit(true)}><Pencil className="size-3.5" /> Edit</Button>}
        </span>}
      />
      <CardBody>
        {error && (
          <Alert tone="warning">
            {error.message}
            {error.code === 'mfa_required' && <> <Link className="font-medium underline" href="/settings/security">Set up or verify two-step verification</Link>, then sign in again.</>}
          </Alert>
        )}
        {data ? (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Detail label="Bank">{data.bankName}</Detail>
            <Detail label="Account number"><span className="font-mono">{data.bankAccount}</span></Detail>
            <Detail label="IFSC / sort code / routing"><span className="font-mono">{data.bankRouting}</span></Detail>
            <Detail label="Tax ID (e.g. PAN)"><span className="font-mono">{data.taxId}</span></Detail>
            <Detail label="National ID"><span className="font-mono">{data.nationalId}</span></Detail>
          </dl>
        ) : !error && <p className="text-sm text-fg-subtle">Hidden. Select Show to view.</p>}
      </CardBody>
      <ActionDialog
        open={edit}
        onClose={() => setEdit(false)}
        title="Edit bank, tax and ID details"
        description="Leave a field empty to clear it. The employee is notified when someone else changes these."
        submit="Save"
        run={async (f) => {
          const r = await saveSensitiveAction(e.id, pick(f, ['bankName', 'bankAccount', 'bankRouting', 'taxId', 'nationalId'], true));
          if (r.ok) reveal();
          return r;
        }}
      >
        <Field label="Bank name">{(p) => <Input {...p} name="bankName" defaultValue={data?.bankName ?? ''} />}</Field>
        <Field label="Account number">{(p) => <Input {...p} name="bankAccount" defaultValue={data?.bankAccount ?? ''} autoComplete="off" />}</Field>
        <Field label="IFSC / sort code / routing">{(p) => <Input {...p} name="bankRouting" defaultValue={data?.bankRouting ?? ''} autoComplete="off" />}</Field>
        <Field label="Tax ID">{(p) => <Input {...p} name="taxId" defaultValue={data?.taxId ?? ''} autoComplete="off" />}</Field>
        <Field label="National ID">{(p) => <Input {...p} name="nationalId" defaultValue={data?.nationalId ?? ''} autoComplete="off" />}</Field>
      </ActionDialog>
    </Card>
  );
}

// -------------------------------------------------------------------------------------------------------------
// Job and history
// -------------------------------------------------------------------------------------------------------------

const EVENT_LABEL: Record<string, string> = {
  hired: 'Hired', confirmed: 'Confirmed', probation_extended: 'Probation extended', transferred: 'Job changed', promoted: 'Promoted', manager_changed: 'Manager changed',
  resigned: 'Resigned', exit_scheduled: 'Exit scheduled', exit_withdrawn: 'Exit withdrawn', exited: 'Left', rehired: 'Rehired', linked_login: 'SampCrew login linked',
};

export function JobTab({ e, history, reports, departments, entities, locations, designations, managers }: {
  e: EmployeeProfile; history: { records: JobRecord[]; events: LifecycleEvent[] }; reports: Employee[];
  departments: Department[]; entities: LegalEntity[]; locations: Location[]; designations: Designation[]; managers: Employee[];
}) {
  const [dialog, setDialog] = useState<null | 'change' | 'confirm' | 'extend' | 'exit'>(null);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [entity, setEntity] = useState(e.legalEntityId ?? '');
  const lc = e.can.lifecycle && e.status !== 'exited';
  return (
    <div className="grid gap-6">
      {error && <Alert tone="danger">{error}</Alert>}
      {lc && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setDialog('change')}>Transfer, promote or change manager</Button>
          {e.status === 'probation' && <Button variant="secondary" onClick={() => setDialog('confirm')}>Confirm</Button>}
          {e.status === 'probation' && <Button variant="secondary" onClick={() => setDialog('extend')}>Extend probation</Button>}
          {e.status !== 'notice' && <Button variant="secondary" onClick={() => setDialog('exit')}>Record exit</Button>}
          {e.status === 'notice' && (
            <Button variant="secondary" loading={pending} onClick={() => start(async () => { const r = await lifecycleAction(e.id, 'withdraw-exit'); if (r.ok) router.refresh(); else setError(r.message); })}>
              Withdraw exit
            </Button>
          )}
        </div>
      )}
      <Card>
        <CardHeader title="Job history" description="Each row is in effect from its start date. Future rows take effect automatically on their date." />
        <Table>
          <THead><tr><TH>From</TH><TH>To</TH><TH>Change</TH><TH>Designation</TH><TH>Department</TH><TH>Location</TH><TH>Manager</TH><TH>Entity</TH></tr></THead>
          <TBody>
            {history.records.map((r) => (
              <TR key={r.id}>
                <TD className="whitespace-nowrap">{r.effectiveFrom}{r.scheduled && <Badge tone="info" className="ml-2">Scheduled</Badge>}</TD>
                <TD className="whitespace-nowrap text-fg-muted">{r.effectiveTo ?? 'Current'}</TD>
                <TD>{humanize(r.reason)}{r.note && <span className="block text-xs text-fg-subtle">{r.note}</span>}</TD>
                <TD className="text-fg-muted">{r.designationName ?? '—'}{r.grade && ` (${r.grade})`}</TD>
                <TD className="text-fg-muted">{r.departmentName ?? '—'}</TD>
                <TD className="text-fg-muted">{r.locationName ?? '—'}</TD>
                <TD className="text-fg-muted">{r.managerName ?? '—'}</TD>
                <TD className="text-fg-muted">{r.legalEntityName}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Timeline" />
          <CardBody>
            <ol className="grid gap-3">
              {history.events.map((ev) => (
                <li key={ev.id} className="flex gap-3 text-sm">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" />
                  <span>
                    <span className="font-medium">{EVENT_LABEL[ev.kind] ?? humanize(ev.kind)}</span> <span className="text-fg-muted">effective {ev.effectiveOn}</span>
                    <span className="block text-xs text-fg-subtle">{ev.by ? `by ${ev.by} · ` : ''}{new Date(ev.createdAt).toLocaleString()}</span>
                  </span>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={`Direct reports (${reports.length})`} />
          <CardBody>
            {reports.length ? (
              <ul className="grid gap-2">{reports.map((r) => <li key={r.id}><Link className="text-sm text-accent hover:underline" href={`/employees/${r.id}`}>{r.displayName}</Link> <span className="text-xs text-fg-subtle">{r.designationName}</span></li>)}</ul>
            ) : <p className="text-sm text-fg-subtle">No one reports to {e.displayName}.</p>}
          </CardBody>
        </Card>
      </div>

      <ActionDialog
        open={dialog === 'change'}
        onClose={() => setDialog(null)}
        title="Change job"
        description="Only the fields you change are updated. History is kept, and a future date is applied automatically."
        submit="Record change"
        run={(f) => {
          const body: Record<string, unknown> = { effectiveFrom: f.get('effectiveFrom'), reason: f.get('reason') };
          const note = String(f.get('note') ?? '').trim();
          if (note) body.note = note;
          for (const k of ['legalEntityId', 'departmentId', 'locationId', 'designationId', 'managerEmployeeId', 'grade']) {
            const v = String(f.get(k) ?? '');
            const current = (e as unknown as Record<string, string | null>)[k] ?? '';
            if (v !== current) body[k] = v === '' ? null : v;
          }
          return jobChangeAction(e.id, body);
        }}
      >
        <Field label="Effective from" required>{(p) => <Input {...p} type="date" name="effectiveFrom" defaultValue={today} required />}</Field>
        <Field label="Reason" required>
          {(p) => <Select {...p} name="reason" defaultValue="transfer"><option value="transfer">Transfer</option><option value="promotion">Promotion</option><option value="manager_change">Manager change</option><option value="correction">Correction</option><option value="other">Other</option></Select>}
        </Field>
        <Field label="Legal entity">{(p) => <Select {...p} name="legalEntityId" value={entity} onChange={(ev) => setEntity(ev.target.value)}>{entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        <Field label="Department">{(p) => <Select {...p} name="departmentId" defaultValue={e.departmentId ?? ''}><option value="">None</option>{departments.filter((d) => !d.legalEntityId || d.legalEntityId === entity).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
        <Field label="Location">{(p) => <Select {...p} name="locationId" defaultValue={e.locationId ?? ''}><option value="">None</option>{locations.filter((l) => l.legalEntityId === entity).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <Field label="Designation">{(p) => <Select {...p} name="designationId" defaultValue={e.designationId ?? ''}><option value="">None</option>{designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
        <Field label="Reports to">{(p) => <Select {...p} name="managerEmployeeId" defaultValue={e.managerEmployeeId ?? ''}><option value="">No manager</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</Select>}</Field>
        <Field label="Grade">{(p) => <Input {...p} name="grade" defaultValue={e.grade ?? ''} maxLength={20} />}</Field>
        <Field label="Note" className="sm:col-span-2">{(p) => <Textarea {...p} name="note" maxLength={500} />}</Field>
      </ActionDialog>
      <ActionDialog open={dialog === 'confirm'} onClose={() => setDialog(null)} title="Confirm employment" submit="Confirm" run={(f) => lifecycleAction(e.id, 'confirm', pick(f, ['effectiveOn', 'note']))}>
        <Field label="Confirmed on" required>{(p) => <Input {...p} type="date" name="effectiveOn" defaultValue={e.probationEndDate && e.probationEndDate < today ? e.probationEndDate : today} required />}</Field>
        <Field label="Note">{(p) => <Input {...p} name="note" />}</Field>
      </ActionDialog>
      <ActionDialog open={dialog === 'extend'} onClose={() => setDialog(null)} title="Extend probation" submit="Extend" run={(f) => lifecycleAction(e.id, 'extend-probation', pick(f, ['newEndDate', 'note']))}>
        <Field label="New end date" required>{(p) => <Input {...p} type="date" name="newEndDate" min={e.probationEndDate ?? undefined} required />}</Field>
        <Field label="Note">{(p) => <Input {...p} name="note" />}</Field>
      </ActionDialog>
      <ActionDialog
        open={dialog === 'exit'}
        onClose={() => setDialog(null)}
        title="Record exit"
        description="They keep access until the last working day. After it, their SampCrew login is suspended and pending leave is cancelled."
        submit="Record exit"
        danger
        run={(f) => lifecycleAction(e.id, 'exit', pick(f, ['exitType', 'resignationDate', 'lastWorkingDay', 'reason']))}
      >
        <Field label="Type" required>
          {(p) => <Select {...p} name="exitType" defaultValue="resignation"><option value="resignation">Resignation</option><option value="termination">Termination</option><option value="retirement">Retirement</option><option value="contract_end">End of contract</option><option value="other">Other</option></Select>}
        </Field>
        <Field label="Resignation date">{(p) => <Input {...p} type="date" name="resignationDate" />}</Field>
        <Field label="Last working day" required>{(p) => <Input {...p} type="date" name="lastWorkingDay" required />}</Field>
        <Field label="Reason" className="sm:col-span-2">{(p) => <Textarea {...p} name="reason" maxLength={1000} />}</Field>
      </ActionDialog>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------------------
// Leave
// -------------------------------------------------------------------------------------------------------------

export function BalanceCards({ balances }: { balances: LeaveBalance[] }) {
  if (!balances.length) return <EmptyState title="No leave types apply yet" description="HR sets up leave types and policies under Leave settings." />;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {balances.map((b) => (
        <Card key={b.leaveTypeId} className="p-4">
          <div className="flex items-center gap-2 text-[0.8125rem] font-medium"><span className="size-2.5 rounded-full" style={{ background: b.color }} />{b.name}</div>
          {b.tracked ? (
            <>
              <div className="mt-2 text-2xl font-semibold tabular-nums">{b.available}</div>
              <div className="text-xs text-fg-subtle">days available</div>
              <div className="mt-2 text-[0.6875rem] text-fg-muted tabular-nums">
                {b.accrued} accrued{Number(b.carriedForward) ? ` · ${b.carriedForward} carried` : ''}{Number(b.adjusted) ? ` · ${b.adjusted} adjusted` : ''} · {b.taken} taken{Number(b.pending) ? ` · ${b.pending} pending` : ''}
              </div>
            </>
          ) : (
            <>
              <div className="mt-2 text-2xl font-semibold tabular-nums">{b.taken}</div>
              <div className="text-xs text-fg-subtle">days taken (no balance limit)</div>
            </>
          )}
        </Card>
      ))}
    </div>
  );
}

const range = (r: LeaveRequest) => {
  const s = `${r.startDate}${r.startHalf === 'second_half' ? ' (2nd half)' : ''}`;
  if (r.startDate === r.endDate) return r.startHalf === 'full' && r.endHalf === 'full' ? r.startDate : `${r.startDate} (half day)`;
  return `${s} to ${r.endDate}${r.endHalf === 'first_half' ? ' (1st half)' : ''}`;
};

export function RequestsTable({ requests, actions }: { requests: LeaveRequest[]; actions?: (r: LeaveRequest) => ReactNode }) {
  if (!requests.length) return <EmptyState title="No leave requests" />;
  return (
    <Table>
      <THead><tr><TH>Type</TH><TH>Dates</TH><TH>Days</TH><TH>Reason</TH><TH>Status</TH>{actions && <TH />}</tr></THead>
      <TBody>
        {requests.map((r) => (
          <TR key={r.id}>
            <TD><span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: r.color }} />{r.leaveTypeName}</span></TD>
            <TD className="whitespace-nowrap">{range(r)}</TD>
            <TD className="tabular-nums">{r.days}</TD>
            <TD className="max-w-xs truncate text-fg-muted">{r.reason ?? '—'}{r.cancelReason && <span className="block text-xs">Cancelled: {r.cancelReason}</span>}</TD>
            <TD><StatusPill status={r.status} /></TD>
            {actions && <TD className="text-right">{actions(r)}</TD>}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function LeaveTab({ balances, requests }: { balances: { year: number; balances: LeaveBalance[] }; requests: LeaveRequest[] }) {
  return (
    <div className="grid gap-6">
      <div>
        <h2 className="mb-3 text-sm font-semibold">Balances for {balances.year}</h2>
        <BalanceCards balances={balances.balances} />
      </div>
      <Card>
        <CardHeader title="Requests" />
        <RequestsTable requests={requests} />
      </Card>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------------------
// Documents
// -------------------------------------------------------------------------------------------------------------

const CATEGORIES = [['id_proof', 'Identity proof'], ['address_proof', 'Address proof'], ['contract', 'Contract'], ['offer_letter', 'Offer letter'], ['policy', 'Policy acknowledgement'], ['certificate', 'Certificate'], ['tax', 'Tax'], ['other', 'Other']] as const;
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function DocumentsTab({ e, documents }: { e: EmployeeProfile; documents: EmployeeDocument[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const canUpload = e.can.manageDocuments || e.isSelf;
  return (
    <Card>
      <CardHeader
        title="Documents"
        description="PDF, images, Word or text files up to 10 MB. Downloads use short-lived links and are recorded in the audit trail."
        action={canUpload && <Button size="sm" onClick={() => setOpen(true)}><Upload className="size-3.5" /> Upload</Button>}
      />
      {error && <div className="px-5"><Alert tone="danger">{error}</Alert></div>}
      {documents.length ? (
        <Table>
          <THead><tr><TH>Title</TH><TH>Category</TH><TH>Size</TH><TH>Uploaded</TH><TH>Visibility</TH><TH /></tr></THead>
          <TBody>
            {documents.map((d) => (
              <TR key={d.id}>
                <TD><span className="flex items-center gap-2"><FileText className="size-4 text-fg-subtle" /><span><span className="block font-medium">{d.title}</span><span className="block text-xs text-fg-subtle">{d.fileName}</span></span></span></TD>
                <TD className="text-fg-muted">{CATEGORIES.find(([k]) => k === d.category)?.[1] ?? d.category}</TD>
                <TD className="tabular-nums text-fg-muted">{size(d.sizeBytes)}</TD>
                <TD className="text-fg-muted">{new Date(d.createdAt).toLocaleDateString()}{d.uploadedBy && <span className="block text-xs">{d.uploadedBy}</span>}</TD>
                <TD>{d.visibility === 'hr_only' ? <Badge tone="warning">HR only</Badge> : <Badge>Employee can see</Badge>}</TD>
                <TD className="whitespace-nowrap text-right">
                  <a className="inline-flex items-center gap-1 text-[0.8125rem] font-medium text-accent hover:underline" href={`/files/${d.id}`}><Download className="size-3.5" /> Download</a>
                  {e.can.manageDocuments && (
                    <button className="ml-3 text-[0.8125rem] text-fg-subtle hover:text-danger" disabled={pending} onClick={() => {
                      if (!confirm(`Archive "${d.title}"? The file is kept for records but hidden from the profile.`)) return;
                      start(async () => { const r = await archiveDocumentAction(e.id, d.id); if (r.ok) router.refresh(); else setError(r.message); });
                    }}>Archive</button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState icon={<FileText className="size-5" />} title="No documents yet" />}
      <ActionDialog open={open} onClose={() => setOpen(false)} title="Upload document" submit="Upload" run={(f) => uploadDocumentAction(e.id, f)}>
        <Field label="Title" required>{(p) => <Input {...p} name="title" required maxLength={200} />}</Field>
        <Field label="Category" required>{(p) => <Select {...p} name="category" defaultValue="other">{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        {e.can.manageDocuments ? (
          <Field label="Who can see it">{(p) => <Select {...p} name="visibility" defaultValue="employee"><option value="employee">The employee and HR</option><option value="hr_only">HR only</option></Select>}</Field>
        ) : <input type="hidden" name="visibility" value="employee" />}
        <Field label="File" required>{(p) => <Input {...p} type="file" name="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.docx" className="py-1.5" />}</Field>
      </ActionDialog>
    </Card>
  );
}

// -------------------------------------------------------------------------------------------------------------
// Onboarding
// -------------------------------------------------------------------------------------------------------------

const OWNER_LABEL: Record<string, string> = { hr: 'HR', manager: 'Manager', employee: 'Employee', it: 'IT' };

export function TaskList({ tasks, showEmployee }: { tasks: OnboardingTask[]; showEmployee?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = (t: OnboardingTask) => start(async () => {
    const r = await taskStatusAction(t.id, t.status === 'open' ? 'done' : 'open');
    if (r.ok) router.refresh(); else setError(r.message);
  });
  if (!tasks.length) return <EmptyState title="Nothing to do" description={showEmployee ? 'Onboarding tasks assigned to you appear here.' : 'No onboarding checklist for this employee.'} />;
  return (
    <>
      {error && <div className="px-5 pt-3"><Alert tone="danger">{error}</Alert></div>}
      <ul className="divide-y divide-border">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-3 px-5 py-3">
            <button onClick={() => toggle(t)} disabled={pending} aria-label={t.status === 'open' ? `Mark "${t.title}" done` : `Reopen "${t.title}"`} className="mt-0.5 text-fg-subtle hover:text-accent">
              {t.status === 'open' ? <Circle className="size-5" /> : <CheckCircle2 className="size-5 text-success" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className={`text-sm ${t.status !== 'open' ? 'text-fg-subtle line-through' : 'font-medium'}`}>{t.title}</div>
              <div className="text-xs text-fg-subtle">
                {showEmployee && <><Link className="text-accent hover:underline" href={`/employees/${t.employeeId}?tab=onboarding`}>{t.employeeName}</Link> · </>}
                {OWNER_LABEL[t.owner]}{t.assigneeName ? ` (${t.assigneeName})` : t.owner === 'it' ? ' queue' : ''}
                {t.dueOn && <> · due {t.dueOn}</>}
                {t.completedBy && <> · done by {t.completedBy}</>}
              </div>
            </div>
            {t.overdue && <Badge tone="danger">Overdue</Badge>}
          </li>
        ))}
      </ul>
    </>
  );
}

export function OnboardingTab({ tasks }: { e: EmployeeProfile; tasks: OnboardingTask[] }) {
  const done = tasks.filter((t) => t.status !== 'open').length;
  return (
    <Card>
      <CardHeader title="Onboarding checklist" description={tasks.length ? `${done} of ${tasks.length} done` : undefined} />
      <TaskList tasks={tasks} />
    </Card>
  );
}
