'use client';
import { requestDateLabel, requestDays } from '@crew/contracts';
import { Alert, Avatar, Button, DatePicker, Field, Input, Select, Textarea, cn } from '@crew/ui';
import { BadgeCheck, Building2, CalendarDays, Mail, Send, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { applyLeaveFromRequestAction } from '../../actions';
import type { LeaveForm } from '../../types';

function Row({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 border-b border-border/70 py-2.5 sm:grid sm:grid-cols-[11rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium text-fg-subtle">{label}</dt>
      <dd className="break-words text-[0.8125rem] font-semibold text-fg" data-testid={testId}>{value || '—'}</dd>
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: typeof UserRound; children: React.ReactNode }) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-accent">
      <span className="inline-flex size-6 items-center justify-center rounded-md bg-accent-subtle"><Icon className="size-3.5" /></span>{children}
    </h2>
  );
}

/**
 * The leave application form, made from an approved request and filled in for the person. It reads like a formal
 * company form: employee details, leave details, who it goes to and a declaration.
 */
export function LeaveApplicationForm({ id, form }: { id: string; form: LeaveForm }) {
  const router = useRouter();
  const p = form.prefill;
  const [leaveTypeId, setLeaveTypeId] = useState(p.leaveTypeId ?? form.leaveTypes[0]?.id ?? '');
  const [startDate, setStartDate] = useState(p.startDate);
  const [endDate, setEndDate] = useState(p.endDate);
  const [startHalf, setStartHalf] = useState<'full' | 'second_half'>(p.startHalf);
  const [endHalf, setEndHalf] = useState<'full' | 'first_half'>(p.endHalf);
  const [reason, setReason] = useState(p.reason);
  const [contact, setContact] = useState('');
  const [handover, setHandover] = useState('');
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const type = form.leaveTypes.find((t) => t.id === leaveTypeId);
  const a = form.applicant;
  const single = startDate === endDate;
  const calendarDays = Math.max(0.5, requestDays(startDate, endDate) - (startHalf === 'second_half' ? 0.5 : 0) - (endHalf === 'first_half' ? 0.5 : 0));

  const submit = () => start(async () => {
    setError(null);
    setFieldErrors({});
    const r = await applyLeaveFromRequestAction(id, {
      leaveTypeId, startDate, endDate, startHalf, endHalf, reason,
      ...(contact.trim() ? { contactDuringLeave: contact.trim() } : {}), ...(handover.trim() ? { handoverTo: handover.trim() } : {}),
    });
    if (!r.ok) { setError(r.message); setFieldErrors(r.fieldErrors ?? {}); return; }
    router.push(`/requests/${id}?applied=1`);
  });

  return (
    <div className="mx-auto max-w-4xl">
      <article className="overflow-hidden rounded-2xl border border-border bg-surface shadow-pop" aria-labelledby="form-title" data-testid="leave-application-form">
        <header className="relative overflow-hidden bg-gradient-to-br from-accent to-[#7c3aed] px-6 py-6 text-white">
          <div className="pointer-events-none absolute -right-12 -top-16 size-48 rounded-full bg-white/15 blur-2xl" aria-hidden />
          <div className="relative flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-white/80"><Building2 className="size-3.5" /> {form.company}</div>
              <h1 id="form-title" className="mt-1 text-2xl font-bold tracking-tight">Leave Application Form</h1>
              <p className="mt-1 text-[0.8125rem] text-white/85">Pre-approved request {form.request.ref} · {form.request.when}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold"><BadgeCheck className="size-4" /> Request approved</span>
          </div>
        </header>

        <div className="grid gap-6 p-6">
          <section aria-label="Employee details">
            <SectionTitle icon={UserRound}>Employee details</SectionTitle>
            <dl className="grid gap-x-8 md:grid-cols-2">
              <Row label="Employee code" value={a.employeeCode} testId="form-employee-code" />
              <Row label="Full name" value={a.name} testId="form-name" />
              <Row label="Designation" value={a.designation} testId="form-designation" />
              <Row label="Department" value={a.department} />
              <Row label="Reporting manager" value={form.reportingManager ? `${form.reportingManager.name}${form.reportingManager.designation ? `, ${form.reportingManager.designation}` : ''}` : null} testId="form-manager" />
              <Row label="HR manager" value={form.hrManager ? `${form.hrManager.name}${form.hrManager.designation ? `, ${form.hrManager.designation}` : ''}` : null} testId="form-hr" />
              <Row label="Workspace" value={[a.levelLabel, a.workspace].filter(Boolean).join(', ')} />
              <Row label="Date of joining" value={a.dateOfJoining ? requestDateLabel(a.dateOfJoining) : null} />
            </dl>
          </section>

          <section aria-label="Leave details">
            <SectionTitle icon={CalendarDays}>Leave details</SectionTitle>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Leave type" required error={fieldErrors.leaveTypeId} hint={type ? (type.notAssigned ? 'No quantity assigned yet: you can still apply.' : `${type.available} days available`) : undefined} help={false}>
                {(f) => (
                  <Select {...f} value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} data-testid="form-leave-type">
                    {form.leaveTypes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.notAssigned ? '' : ` (${t.available} left)`}</option>)}
                  </Select>
                )}
              </Field>
              <div className="rounded-xl border border-dashed border-accent/40 bg-accent-subtle/60 p-3">
                <div className="text-xs text-fg-muted">Number of days</div>
                <div className="text-2xl font-bold tabular text-fg" data-testid="form-days">{calendarDays}</div>
                <div className="text-[0.6875rem] text-fg-subtle">Weekly offs and holidays are left out when it is booked.</div>
              </div>
              <Field label="From" required error={fieldErrors.startDate} help={false}>
                {(f) => <DatePicker {...f} value={startDate} min={form.request.startDate} max={form.request.endDate} onChange={(v) => { setStartDate(v); if (endDate < v) setEndDate(v); }} calendarLabel="Choose the first day" />}
              </Field>
              <Field label="To" required error={fieldErrors.endDate} help={false}>
                {(f) => <DatePicker {...f} value={endDate} min={startDate} max={form.request.endDate} onChange={setEndDate} calendarLabel="Choose the last day" />}
              </Field>
              {type?.allowHalfDay && (
                <>
                  <Field label="First day" help={false}>
                    {(f) => <Select {...f} value={startHalf} onChange={(e) => setStartHalf(e.target.value as 'full' | 'second_half')}><option value="full">Full day</option><option value="second_half">Second half only</option></Select>}
                  </Field>
                  <Field label={single ? 'Half of the day' : 'Last day'} help={false}>
                    {(f) => <Select {...f} value={endHalf} onChange={(e) => setEndHalf(e.target.value as 'full' | 'first_half')}><option value="full">Full day</option><option value="first_half">First half only</option></Select>}
                  </Field>
                </>
              )}
              <Field label="Reason for leave" required className="md:col-span-2" error={fieldErrors.reason} help={false}>
                {(f) => <Textarea {...f} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}
              </Field>
              <Field label="Contact during leave" hint="Optional: a phone number or email." help={false}>
                {(f) => <Input {...f} maxLength={120} value={contact} onChange={(e) => setContact(e.target.value)} placeholder="+91 98xxx xxxxx" />}
              </Field>
              <Field label="Work handed over to" hint="Optional: who covers your work." help={false}>
                {(f) => <Input {...f} maxLength={120} value={handover} onChange={(e) => setHandover(e.target.value)} placeholder="Colleague's name" />}
              </Field>
            </div>
          </section>

          <section aria-label="Send to">
            <SectionTitle icon={Mail}>Goes to</SectionTitle>
            <ul className="flex flex-wrap gap-2" data-testid="form-send-to">
              {form.sendTo.map((s) => (
                <li key={s.membershipId} className="flex items-center gap-2 rounded-full border border-border bg-bg-subtle py-1 pl-1 pr-3">
                  <Avatar name={s.name} size={26} />
                  <span className="text-xs"><span className="font-semibold text-fg">{s.name}</span> <span className="text-fg-muted">· {s.levelLabel}</span></span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-fg-muted">They get it in Approvals and by email, as a formal form. A copy goes to your email, and it is saved with your leave.</p>
          </section>

          <label className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 text-[0.8125rem]', agree ? 'border-success/40 bg-success-subtle/50' : 'border-border')}>
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={agree} onChange={(e) => setAgree(e.target.checked)} data-testid="form-declaration" />
            <span>I confirm that the information above is correct and that I will hand over my pending work before the leave starts.</span>
          </label>

          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => router.push(`/requests/${id}`)}>Back</Button>
            <Button size="lg" onClick={submit} loading={pending} disabled={!agree || !leaveTypeId || reason.trim().length < 5} data-testid="send-leave-application"><Send className="size-4" /> Send leave application</Button>
          </div>
        </div>
      </article>
    </div>
  );
}
