'use client';
import { REQUEST_KIND_DEFS, REQUEST_WORKFLOW_LABELS, requestDays, requestWhen, type RequestCategory } from '@crew/contracts';
import { Alert, Button, DatePicker, Field, Input, Textarea, cn } from '@crew/ui';
import { Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { createRequestAction } from '../actions';
import { KindTile } from '../kind-visual';
import { Attachments, PeoplePicker, PickedSummary, RequesterCard, Step, pickedBody, type Picked } from '../people-picker';
import type { RequestOptions, UploadedDoc } from '../types';

/** The people the form starts with: the primary approver (reporting manager) and HR as an additional approver. */
export function initialPicked(o: RequestOptions): Picked {
  const all = [...o.suggested, ...(o.reportingManager ? [o.reportingManager] : []), ...(o.hrManager ? [o.hrManager] : [])];
  const find = (id: string | null) => (id ? all.find((p) => p.membershipId === id) ?? null : null);
  return { primary: find(o.defaults.primaryApproverId), additional: o.defaults.additionalApproverIds.map(find).filter((p): p is NonNullable<typeof p> => Boolean(p)), cc: [] };
}

/**
 * The Create Request form: the requester's details (filled in), the request type, dates and times, reason and
 * documents, then the primary approver, additional approvers and CC participants. The card on the side shows the
 * request as approvers will see it.
 */
export function RequestForm({ options, categories, initial, today }: { options: RequestOptions; categories: RequestCategory[]; initial: string; today: string }) {
  const router = useRouter();
  const [key, setKey] = useState(initial);
  const cat = categories.find((c) => c.key === key) ?? categories[0]!;
  const def = REQUEST_KIND_DEFS[cat.kind];
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [withTimes, setWithTimes] = useState(false);
  const [startTime, setStartTime] = useState('09:30');
  const [endTime, setEndTime] = useState('18:30');
  const [workedOn, setWorkedOn] = useState('');
  const [reason, setReason] = useState('');
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [picked, setPicked] = useState<Picked>(() => initialPicked(options));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  const choose = (c: RequestCategory) => {
    setKey(c.key);
    const d = REQUEST_KIND_DEFS[c.kind];
    if (c.kind === 'late_coming') setStartTime('11:00');
    else if (c.kind === 'early_leave') setStartTime('16:00');
    else if (c.kind === 'attendance_regularization') { setStartTime('09:30'); setEndTime('18:30'); }
    if (d.timing !== 'days') setEndDate(startDate);
  };
  const single = def.timing !== 'days';
  const times = single || withTimes;
  const hasEnd = def.timing === 'day_time_range' || (def.timing === 'days' && withTimes);
  const end = single ? startDate : endDate || startDate;
  const when = useMemo(() => (startDate ? requestWhen({ kind: cat.kind, startDate, endDate: end, startTime: times ? startTime : null, endTime: times && hasEnd ? endTime : null }) : ''), [cat.kind, startDate, end, times, startTime, endTime, hasEnd]);
  const needsTitle = cat.kind === 'other' && !cat.custom;

  const submit = () => start(async () => {
    setError(null);
    setFieldErrors({});
    const body: Record<string, unknown> = {
      kind: cat.kind, ...(cat.custom ? { categoryKey: cat.key } : {}), reason, startDate, endDate: end, ...pickedBody(picked), attachmentIds: docs.map((d) => d.id),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(times ? { startTime } : {}),
      ...(times && hasEnd ? { endTime } : {}),
      ...(cat.kind === 'comp_off' && workedOn ? { workedOn } : {}),
    };
    const r = await createRequestAction(body);
    if (!r.ok) { setError(r.message); setFieldErrors(r.fieldErrors ?? {}); return; }
    router.push(`/requests/${r.data!.id}?sent=1`);
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 content-start gap-5">
        <Step n={1} title="Your details" hint="Filled in from your employee record.">
          <RequesterCard me={options.me} manager={options.reportingManager} hr={options.hrManager} />
        </Step>

        <Step n={2} title="Request type" hint="Choose what you are asking for.">
          <div role="radiogroup" aria-label="Request type" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {categories.map((c) => (
              <button key={c.key} type="button" role="radio" aria-checked={key === c.key} onClick={() => choose(c)} data-testid={`pick-${c.key}`}
                className={cn('flex min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-colors', key === c.key ? 'border-accent bg-accent-subtle ring-1 ring-accent/30' : 'border-border hover:border-border-strong hover:bg-bg-subtle')}>
                <KindTile kind={c.kind} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-[0.8125rem] font-semibold text-fg">{c.label}</span>
                  <span className="block truncate text-[0.6875rem] text-fg-muted">{c.description}</span>
                </span>
              </button>
            ))}
          </div>
          {needsTitle && (
            <Field label="Title" required className="mt-4" error={fieldErrors.title} help={false}>
              {(a) => <Input {...a} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="For example: Access to the client's office" />}
            </Field>
          )}
        </Step>

        <Step n={3} title="Request details" hint={single ? 'The day and the time.' : 'The days it covers, and the times if they matter.'}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={single ? 'Date' : 'Start date'} required error={fieldErrors.startDate} help={false}>
              {(a) => <DatePicker {...a} value={startDate} onChange={(v) => { setStartDate(v); if (!endDate || endDate < v) setEndDate(v); }} max={cat.kind === 'attendance_regularization' ? today : undefined} calendarLabel="Choose the start date" />}
            </Field>
            {!single && (
              <Field label="End date" required error={fieldErrors.endDate} hint={startDate && end ? `${requestDays(startDate, end)} day${requestDays(startDate, end) === 1 ? '' : 's'}` : undefined} help={false}>
                {(a) => <DatePicker {...a} value={endDate} onChange={setEndDate} min={startDate || undefined} calendarLabel="Choose the end date" />}
              </Field>
            )}
            {times && (
              <Field label={def.timeLabels?.start ?? 'Start time'} required={single} error={fieldErrors.startTime} help={false}>
                {(a) => <Input {...a} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />}
              </Field>
            )}
            {times && hasEnd && (
              <Field label={def.timeLabels?.end ?? 'End time'} required error={fieldErrors.endTime} help={false}>
                {(a) => <Input {...a} type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />}
              </Field>
            )}
            {cat.kind === 'comp_off' && (
              <Field label="Weekly off or holiday you worked on" required error={fieldErrors.workedOn} help={false}>
                {(a) => <DatePicker {...a} value={workedOn} onChange={setWorkedOn} max={startDate || undefined} calendarLabel="Choose the day you worked" />}
              </Field>
            )}
          </div>
          {def.timing === 'days' && (
            <label className="mt-4 inline-flex cursor-pointer items-center gap-2 text-[0.8125rem] text-fg">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={withTimes} onChange={(e) => setWithTimes(e.target.checked)} /> Add start and end times
            </label>
          )}
          <Field label="Reason" required className="mt-4" error={fieldErrors.reason} help={false}>
            {(a) => <Textarea {...a} rows={4} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={def.placeholder} />}
          </Field>
          <div className="mt-4"><Attachments value={docs} onChange={setDocs} mode={cat.attachments} /></div>
        </Step>

        <Step n={4} title="Approvers and CC" hint={`Choose the primary approver, any additional approvers, and people to keep informed (CC). ${REQUEST_WORKFLOW_LABELS[cat.workflow]}.`}>
          <PeoplePicker suggested={options.suggested} value={picked} onChange={setPicked} error={fieldErrors.primaryApproverId ?? fieldErrors.additionalApproverIds ?? fieldErrors.ccIds} />
        </Step>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start" aria-label="Your request">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-pop">
          <div className="relative p-4" style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${cat.color} 16%, transparent), transparent 70%)` }}>
            <div className="flex items-center gap-3">
              <KindTile kind={cat.kind} size="lg" />
              <div className="min-w-0">
                <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">Your request</div>
                <div className="truncate text-base font-semibold text-fg">{needsTitle && title.trim() ? title : cat.label}</div>
              </div>
            </div>
          </div>
          <dl className="grid gap-3 p-4 text-[0.8125rem]">
            <div><dt className="text-xs text-fg-subtle">When</dt><dd className="font-medium text-fg" data-testid="request-when">{when || 'Choose the date'}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Reason</dt><dd className="line-clamp-3 break-words text-fg">{reason || <span className="text-fg-subtle">Not written yet</span>}</dd></div>
            <div><dt className="text-xs text-fg-subtle">How it is approved</dt><dd className="text-fg">{REQUEST_WORKFLOW_LABELS[cat.workflow]}</dd></div>
            <div><dt className="mb-1.5 text-xs text-fg-subtle">Goes to</dt><dd><PickedSummary value={picked} onChange={setPicked} /></dd></div>
          </dl>
          <div className="grid gap-2 border-t border-border p-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Button size="lg" onClick={submit} loading={pending} disabled={!picked.primary || reason.trim().length < 5 || !startDate || (cat.attachments === 'required' && !docs.length)} data-testid="send-request"><Send className="size-4" /> Submit request</Button>
            <p className="text-center text-[0.6875rem] text-fg-subtle">Each request gets its own Request ID. You are told as it is decided.</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
