'use client';
import { REQUEST_WORKFLOW_LABELS, hoursBetween, requestDateLabel, requestTimeLabel, type LeaveDuration, type RequestWorkflow } from '@crew/contracts';
import { Alert, Button, DatePicker, Field, Input, Select, Textarea, cn } from '@crew/ui';
import { CalendarCheck2, Clock, Send, SunMedium } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { applyLeaveAction, previewLeaveDaysAction } from './actions';
import { KindTile } from './kind-visual';
import { initialPicked } from './new/request-form';
import { Attachments, PeoplePicker, PickedSummary, RequesterCard, Step, pickedBody, type Picked } from './people-picker';
import type { RequestOptions, UploadedDoc } from './types';

const HOURS_PER_DAY = 8;

/**
 * Apply for Leave: a request of its own. The details are filled in, the person chooses the leave type (with its
 * balance), the dates, full day, half day or hours, and the approvers; it goes straight to them. The days are held as
 * pending and booked (balance and attendance) only when it is fully approved.
 */
export function LeaveForm({ options, today, workflow, attachments }: { options: RequestOptions; today: string; workflow: RequestWorkflow; attachments: 'none' | 'optional' | 'required' }) {
  const router = useRouter();
  const types = options.leaveTypes;
  const [leaveTypeId, setLeaveTypeId] = useState(types[0]?.id ?? '');
  const type = types.find((t) => t.id === leaveTypeId);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [duration, setDuration] = useState<LeaveDuration>('full');
  const [half, setHalf] = useState<'first_half' | 'second_half'>('first_half');
  const [startHalf, setStartHalf] = useState<'full' | 'second_half'>('full');
  const [endHalf, setEndHalf] = useState<'full' | 'first_half'>('full');
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('12:00');
  const [reason, setReason] = useState('');
  const [contact, setContact] = useState('');
  const [handover, setHandover] = useState('');
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [picked, setPicked] = useState<Picked>(() => initialPicked(options));
  const [preview, setPreview] = useState<{ days: string; available: string | null; balanceAfter: string | null; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const oneDay = startDate === endDate;
  const canPart = Boolean(type?.allowHalfDay);

  useEffect(() => { if (!oneDay && duration === 'hours') setDuration('full'); }, [oneDay, duration]);
  useEffect(() => { if (!canPart && duration !== 'full') setDuration('full'); }, [canPart, duration]);

  // The leave module's own count (weekly offs and holidays left out) and the balance after this leave.
  const halves = duration === 'half' && oneDay
    ? (half === 'second_half' ? { startHalf: 'second_half', endHalf: 'full' } : { startHalf: 'full', endHalf: 'first_half' })
    : duration === 'hours' ? { startHalf: 'full', endHalf: 'full' } : { startHalf: duration === 'half' ? startHalf : 'full', endHalf: duration === 'half' ? endHalf : 'full' };
  useEffect(() => {
    if (!leaveTypeId || !startDate || !endDate || endDate < startDate) { setPreview(null); return; }
    const t = setTimeout(() => {
      void previewLeaveDaysAction({ leaveTypeId, startDate, endDate, ...halves }).then((r) => setPreview(r.ok ? r.data! : null));
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaveTypeId, startDate, endDate, halves.startHalf, halves.endHalf]);

  const hours = duration === 'hours' ? hoursBetween(startTime, endTime) : 0;
  const days = duration === 'hours' ? (Math.round((hours / HOURS_PER_DAY) * 100) / 100).toFixed(2) : preview?.days ?? null;
  const left = type && !type.notAssigned && type.available !== null && days ? (Number(type.available) - Number(days)).toFixed(2) : null;

  const submit = () => start(async () => {
    setError(null);
    setFieldErrors({});
    const body: Record<string, unknown> = {
      leaveTypeId, startDate, endDate, duration, reason, ...pickedBody(picked), attachmentIds: docs.map((d) => d.id),
      ...(duration === 'half' ? (oneDay ? { startHalf: half } : { startHalf, endHalf }) : {}),
      ...(duration === 'hours' ? { startTime, endTime } : {}),
      ...(contact.trim() ? { contactDuringLeave: contact.trim() } : {}),
      ...(handover.trim() ? { handoverTo: handover.trim() } : {}),
    };
    const r = await applyLeaveAction(body);
    if (!r.ok) { setError(r.message); setFieldErrors(r.fieldErrors ?? {}); return; }
    router.push(`/requests/${r.data!.id}?sent=1`);
  });

  const durationBtn = (d: LeaveDuration, label: string, icon: React.ReactNode, disabled = false) => (
    <button type="button" role="radio" aria-checked={duration === d} disabled={disabled} onClick={() => setDuration(d)} data-testid={`duration-${d}`}
      className={cn('flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-[0.8125rem] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        duration === d ? 'border-accent bg-accent-subtle text-accent ring-1 ring-accent/30' : 'border-border text-fg hover:bg-bg-subtle')}>
      {icon}{label}
    </button>
  );

  if (!options.hasEmployeeRecord) return <Alert tone="warning" title="No employee record yet">Your login is not linked to an employee record, so there is no leave to apply for. Ask HR to link it.</Alert>;
  if (!types.length) return <Alert tone="info" title="No leave types for you">No leave type is available to you yet. Ask HR.</Alert>;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 content-start gap-5">
        <Step n={1} title="Your details" hint="Filled in from your employee record.">
          <RequesterCard me={options.me} manager={options.reportingManager} hr={options.hrManager} />
        </Step>

        <Step n={2} title="Leave details" hint="Future dates are fine, tomorrow included.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Leave type" required error={fieldErrors.leaveTypeId} help={false} className="sm:col-span-2">
              {(a) => (
                <Select {...a} value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} data-testid="leave-type">
                  {types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.notAssigned || t.available === null ? '' : ` (${t.available} days available)`}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Start date" required error={fieldErrors.startDate} help={false}>
              {(a) => <DatePicker {...a} value={startDate} onChange={(v) => { setStartDate(v); if (!endDate || endDate < v) setEndDate(v); }} calendarLabel="Choose the first day of leave" />}
            </Field>
            <Field label="End date" required error={fieldErrors.endDate} help={false}>
              {(a) => <DatePicker {...a} value={endDate} onChange={setEndDate} min={startDate || undefined} calendarLabel="Choose the last day of leave" />}
            </Field>
          </div>
          <div className="mt-4">
            <span className="mb-1.5 block text-[0.8125rem] font-medium text-fg">Leave duration</span>
            <div role="radiogroup" aria-label="Leave duration" className="grid grid-cols-3 gap-2">
              {durationBtn('full', 'Full day', <CalendarCheck2 className="size-4" />)}
              {durationBtn('half', 'Half day', <SunMedium className="size-4" />, !canPart)}
              {durationBtn('hours', 'Hours', <Clock className="size-4" />, !canPart || !oneDay)}
            </div>
            {!canPart && <p className="mt-1.5 text-xs text-fg-muted">{type?.name} is taken in full days.</p>}
          </div>
          {duration === 'half' && oneDay && (
            <div role="radiogroup" aria-label="Which half" className="mt-3 grid grid-cols-2 gap-2">
              {(['first_half', 'second_half'] as const).map((h) => (
                <button key={h} type="button" role="radio" aria-checked={half === h} onClick={() => setHalf(h)} data-testid={`half-${h}`}
                  className={cn('rounded-lg border px-3 py-2 text-[0.8125rem] font-medium', half === h ? 'border-accent bg-accent-subtle text-accent' : 'border-border hover:bg-bg-subtle')}>
                  {h === 'first_half' ? 'First half (morning)' : 'Second half (afternoon)'}
                </button>
              ))}
            </div>
          )}
          {duration === 'half' && !oneDay && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="First day" help={false}>{(a) => <Select {...a} value={startHalf} onChange={(e) => setStartHalf(e.target.value as 'full' | 'second_half')}><option value="full">Full day</option><option value="second_half">From the second half</option></Select>}</Field>
              <Field label="Last day" help={false}>{(a) => <Select {...a} value={endHalf} onChange={(e) => setEndHalf(e.target.value as 'full' | 'first_half')}><option value="full">Full day</option><option value="first_half">Until the first half</option></Select>}</Field>
            </div>
          )}
          {duration === 'hours' && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="From" required error={fieldErrors.startTime} help={false}>{(a) => <Input {...a} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />}</Field>
              <Field label="To" required error={fieldErrors.endTime} help={false}>{(a) => <Input {...a} type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />}</Field>
            </div>
          )}
          <Field label="Reason" required className="mt-4" error={fieldErrors.reason} help={false}>
            {(a) => <Textarea {...a} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: family function out of town." />}
          </Field>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Contact while on leave" help={false}>{(a) => <Input {...a} value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} placeholder="Phone number (optional)" />}</Field>
            <Field label="Work handed over to" help={false}>{(a) => <Input {...a} value={handover} onChange={(e) => setHandover(e.target.value)} maxLength={120} placeholder="Name (optional)" />}</Field>
          </div>
          <div className="mt-4"><Attachments value={docs} onChange={setDocs} mode={attachments === 'none' ? 'optional' : attachments} /></div>
        </Step>

        <Step n={3} title="Approvers and CC" hint={`Your application goes straight to these approvers. ${REQUEST_WORKFLOW_LABELS[workflow]}.`}>
          <PeoplePicker suggested={options.suggested} value={picked} onChange={setPicked} error={fieldErrors.primaryApproverId ?? fieldErrors.additionalApproverIds ?? fieldErrors.ccIds} />
        </Step>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start" aria-label="Your leave application">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-pop">
          <div className="relative p-4" style={{ background: 'linear-gradient(135deg, color-mix(in srgb, #2563eb 16%, transparent), transparent 70%)' }}>
            <div className="flex items-center gap-3">
              <KindTile kind="leave" size="lg" />
              <div className="min-w-0">
                <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">Leave application</div>
                <div className="truncate text-base font-semibold text-fg">{type?.name ?? 'Leave'}</div>
              </div>
            </div>
          </div>
          <dl className="grid gap-3 p-4 text-[0.8125rem]">
            <div><dt className="text-xs text-fg-subtle">When</dt><dd className="font-medium text-fg" data-testid="leave-when">
              {startDate ? (oneDay ? requestDateLabel(startDate) : `${requestDateLabel(startDate)} to ${requestDateLabel(endDate)}`) : '—'}
              {duration === 'half' && oneDay ? (half === 'first_half' ? ', first half' : ', second half') : ''}
              {duration === 'hours' ? `, ${requestTimeLabel(startTime)} to ${requestTimeLabel(endTime)}` : ''}
            </dd></div>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-bg-subtle px-3 py-2"><dt className="text-[0.6875rem] text-fg-subtle">Duration</dt><dd className="font-semibold tabular" data-testid="leave-days">{days ? `${days} day${days === '1.00' ? '' : 's'}` : '—'}</dd></div>
              <div className="rounded-lg bg-bg-subtle px-3 py-2"><dt className="text-[0.6875rem] text-fg-subtle">Balance after</dt><dd className="font-semibold tabular">{type?.notAssigned || type?.available === null ? 'Not tracked' : left ?? '—'}</dd></div>
            </div>
            {preview?.warnings?.map((w) => <Alert key={w} tone="warning">{w}</Alert>)}
            <p className="text-xs text-fg-muted">Nothing is deducted until every approver approves.</p>
            <div><dt className="mb-1.5 text-xs text-fg-subtle">Goes to</dt><dd><PickedSummary value={picked} onChange={setPicked} /></dd></div>
          </dl>
          <div className="grid gap-2 border-t border-border p-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Button size="lg" onClick={submit} loading={pending} disabled={!picked.primary || reason.trim().length < 5 || !leaveTypeId || (attachments === 'required' && !docs.length)} data-testid="apply-leave"><Send className="size-4" /> Submit leave request</Button>
          </div>
        </div>
      </aside>
    </div>
  );
}
