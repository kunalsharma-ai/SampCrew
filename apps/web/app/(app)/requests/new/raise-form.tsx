'use client';
import { REQUEST_KIND_DEFS, REQUEST_MAX_APPROVERS, requestDays, requestWhen, type RequestKind, type RequestPerson } from '@crew/contracts';
import { Alert, Avatar, Button, DatePicker, Field, Input, Select, Textarea, cn } from '@crew/ui';
import { Check, Search, Send, UserPlus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { createRequestAction, searchPeopleAction } from '../actions';
import { KindTile } from '../kind-visual';
import type { RequestOptions } from '../types';

const ROLE_STYLE: Record<string, string> = {
  manager: 'bg-info-subtle text-info',
  hr: 'bg-success-subtle text-success',
  super: 'bg-accent-subtle text-accent',
};

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`} className="rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-hover text-xs font-bold text-accent-fg shadow-card" aria-hidden>{n}</span>
        <div className="min-w-0">
          <h2 id={`step-${n}`} className="text-[0.9375rem] font-semibold text-fg">{title}</h2>
          {hint && <p className="text-xs text-fg-muted">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function PersonChip({ p, selected, onToggle, testId }: { p: RequestPerson; selected: boolean; onToggle: () => void; testId?: string }) {
  return (
    <button type="button" onClick={onToggle} aria-pressed={selected} data-testid={testId}
      className={cn('flex w-full min-w-0 items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors', selected ? 'border-accent bg-accent-subtle' : 'border-border bg-surface hover:border-border-strong hover:bg-bg-subtle')}>
      <Avatar name={p.name} size={34} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-semibold text-fg">{p.name}</span>
        <span className="block truncate text-[0.6875rem] text-fg-muted">{[p.levelLabel, p.designation, p.department].filter(Boolean).join(' · ')}</span>
        {p.roleLabel && <span className={cn('mt-1 inline-block rounded-full px-1.5 py-px text-[0.625rem] font-semibold', ROLE_STYLE[p.role ?? ''] ?? 'bg-bg-subtle text-fg-muted')}>{p.roleLabel}</span>}
      </span>
      <span className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-full border', selected ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong text-transparent')}>
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    </button>
  );
}

/**
 * The request form: type, dates and times, reason, and the people looped in to approve. The summary on the side
 * shows the request as approvers will see it.
 */
export function RaiseRequestForm({ options, initialKind, today }: { options: RequestOptions; initialKind: RequestKind; today: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<RequestKind>(initialKind);
  const def = REQUEST_KIND_DEFS[kind];
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [withTimes, setWithTimes] = useState(false);
  const [startTime, setStartTime] = useState(kind === 'late_coming' ? '11:00' : kind === 'early_leave' ? '16:00' : '09:30');
  const [endTime, setEndTime] = useState('18:30');
  const [workedOn, setWorkedOn] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [reason, setReason] = useState('');
  // Your reporting manager and your HR are looped in to start with; change them freely.
  const [picked, setPicked] = useState<RequestPerson[]>(() => [options.suggested.find((p) => p.role === 'manager'), options.suggested.find((p) => p.role === 'hr')].filter((p): p is RequestPerson => Boolean(p)));
  const [q, setQ] = useState('');
  const [found, setFound] = useState<RequestPerson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  // Each type starts with sensible times.
  useEffect(() => {
    if (kind === 'late_coming') setStartTime('11:00');
    if (kind === 'early_leave') setStartTime('16:00');
    if (kind === 'half_day') { setStartTime('13:30'); setEndTime('18:30'); }
    if (def.timing !== 'days') setEndDate(startDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound([]); return; }
    const t = setTimeout(() => { void searchPeopleAction(term).then((r) => setFound(r.ok ? r.data?.items ?? [] : [])); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const single = def.timing !== 'days';
  const times = def.timing !== 'days' || withTimes;
  const end = single ? startDate : endDate || startDate;
  const when = useMemo(() => (startDate ? requestWhen({ kind, startDate, endDate: end, startTime: times ? startTime : null, endTime: times && (def.timing === 'day_time_range' || (def.timing === 'days' && withTimes)) ? endTime : null }) : ''), [kind, startDate, end, times, startTime, endTime, def.timing, withTimes]);
  const toggle = (p: RequestPerson) => setPicked((cur) => (cur.some((x) => x.membershipId === p.membershipId) ? cur.filter((x) => x.membershipId !== p.membershipId) : cur.length >= REQUEST_MAX_APPROVERS ? cur : [...cur, p]));
  const isPicked = (id: string) => picked.some((x) => x.membershipId === id);

  const submit = () => start(async () => {
    setError(null);
    setFieldErrors({});
    const body: Record<string, unknown> = {
      kind, reason, startDate, endDate: end, approverMembershipIds: picked.map((p) => p.membershipId),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(times ? { startTime } : {}),
      ...(times && (def.timing === 'day_time_range' || (def.timing === 'days' && withTimes)) ? { endTime } : {}),
      ...(kind === 'comp_off' && workedOn ? { workedOn } : {}),
      ...(def.leadsToLeave && leaveTypeId ? { leaveTypeId } : {}),
    };
    const r = await createRequestAction(body);
    if (!r.ok) {
      setError(r.message);
      setFieldErrors(r.fieldErrors ?? {});
      return;
    }
    router.push(`/requests/${r.data!.id}?sent=1`);
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 content-start gap-5">
        <Step n={1} title="What do you need?" hint="Choose the type of request.">
          <div role="radiogroup" aria-label="Request type" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {options.kinds.map((k) => (
              <button key={k.key} type="button" role="radio" aria-checked={kind === k.key} onClick={() => setKind(k.key)} data-testid={`pick-${k.key}`}
                className={cn('flex min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-colors', kind === k.key ? 'border-accent bg-accent-subtle ring-1 ring-accent/30' : 'border-border hover:border-border-strong hover:bg-bg-subtle')}>
                <KindTile kind={k.key} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-[0.8125rem] font-semibold text-fg">{k.label}</span>
                  <span className="block truncate text-[0.6875rem] text-fg-muted">{k.description}</span>
                </span>
              </button>
            ))}
          </div>
          {kind === 'other' && (
            <Field label="Title" required className="mt-4" error={fieldErrors.title} help={false}>
              {(a) => <Input {...a} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="For example: Access to the client's office" />}
            </Field>
          )}
        </Step>

        <Step n={2} title="When?" hint={single ? 'The day and the time.' : 'The days it covers, and the times if they matter.'}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={single ? 'Date' : 'From date'} required error={fieldErrors.startDate} help={false}>
              {(a) => <DatePicker {...a} value={startDate} onChange={(v) => { setStartDate(v); if (!endDate || endDate < v) setEndDate(v); }} calendarLabel="Choose the start date" />}
            </Field>
            {!single && (
              <Field label="To date" required error={fieldErrors.endDate} hint={startDate && end ? `${requestDays(startDate, end)} day${requestDays(startDate, end) === 1 ? '' : 's'}` : undefined} help={false}>
                {(a) => <DatePicker {...a} value={endDate} onChange={setEndDate} min={startDate || undefined} calendarLabel="Choose the end date" />}
              </Field>
            )}
            {times && (
              <Field label={def.timeLabels?.start ?? 'From (time)'} required={single} error={fieldErrors.startTime} help={false}>
                {(a) => <Input {...a} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />}
              </Field>
            )}
            {times && (def.timing === 'day_time_range' || (def.timing === 'days' && withTimes)) && (
              <Field label={def.timeLabels?.end ?? 'To (time)'} required error={fieldErrors.endTime} help={false}>
                {(a) => <Input {...a} type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />}
              </Field>
            )}
            {kind === 'comp_off' && (
              <Field label="Weekly off or holiday you worked on" required error={fieldErrors.workedOn} help={false}>
                {(a) => <DatePicker {...a} value={workedOn} onChange={setWorkedOn} max={startDate || undefined} calendarLabel="Choose the day you worked" />}
              </Field>
            )}
            {def.leadsToLeave && options.leaveTypes.length > 0 && (
              <Field label="Leave type you will use" hint="Optional: it fills in the leave form after approval." help={false}>
                {(a) => (
                  <Select {...a} value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}>
                    <option value="">Choose later</option>
                    {options.leaveTypes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.notAssigned ? '' : ` (${t.available} left)`}</option>)}
                  </Select>
                )}
              </Field>
            )}
          </div>
          {def.timing === 'days' && (
            <label className="mt-4 inline-flex cursor-pointer items-center gap-2 text-[0.8125rem] text-fg">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={withTimes} onChange={(e) => setWithTimes(e.target.checked)} /> Add times
            </label>
          )}
        </Step>

        <Step n={3} title="Why?" hint="The reason approvers read first.">
          <Field label="Reason" required error={fieldErrors.reason} help={false}>
            {(a) => <Textarea {...a} rows={4} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={def.placeholder} />}
          </Field>
        </Step>

        <Step n={4} title="Loop in approvers" hint={`Everyone you choose gets it in Approvals and must approve. Up to ${REQUEST_MAX_APPROVERS} people; include your manager, HR or the Super Workspace.`}>
          {options.suggested.length > 0 && (
            <>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Suggested for you</h3>
              <div className="grid gap-2 sm:grid-cols-2" data-testid="suggested-approvers">
                {options.suggested.map((p) => <PersonChip key={p.membershipId} p={p} selected={isPicked(p.membershipId)} onToggle={() => toggle(p)} testId={`suggested-${p.role ?? 'person'}`} />)}
              </div>
            </>
          )}
          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input aria-label="Find someone to loop in" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find anyone: name, workspace, department, employee code" />
          </div>
          {found.length > 0 && (
            <ul className="mt-2 grid max-h-64 gap-1.5 overflow-y-auto rounded-xl border border-border bg-bg-subtle p-1.5" aria-label="People found">
              {found.map((p) => <li key={p.membershipId}><PersonChip p={p} selected={isPicked(p.membershipId)} onToggle={() => toggle(p)} /></li>)}
            </ul>
          )}
          {fieldErrors.approverMembershipIds && <p className="mt-2 text-xs text-danger">{fieldErrors.approverMembershipIds}</p>}
        </Step>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start" aria-label="Your request">
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-pop">
          <div className="relative p-4" style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${def.color} 16%, transparent), transparent 70%)` }}>
            <div className="flex items-center gap-3">
              <KindTile kind={kind} size="lg" />
              <div className="min-w-0">
                <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">Your request</div>
                <div className="truncate text-base font-semibold text-fg">{kind === 'other' && title.trim() ? title : def.label}</div>
              </div>
            </div>
          </div>
          <dl className="grid gap-3 p-4 text-[0.8125rem]">
            <div><dt className="text-xs text-fg-subtle">When</dt><dd className="font-medium text-fg" data-testid="request-when">{when || 'Choose the date'}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Reason</dt><dd className="line-clamp-3 break-words text-fg">{reason || <span className="text-fg-subtle">Not written yet</span>}</dd></div>
            <div>
              <dt className="mb-1.5 text-xs text-fg-subtle">Goes to ({picked.length})</dt>
              <dd>
                {picked.length ? (
                  <ul className="grid gap-1.5" data-testid="picked-approvers">
                    {picked.map((p) => (
                      <li key={p.membershipId} className="flex items-center gap-2 rounded-lg bg-bg-subtle px-2 py-1.5">
                        <Avatar name={p.name} size={24} />
                        <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{p.name}</span><span className="block truncate text-[0.6875rem] text-fg-muted">{p.levelLabel}</span></span>
                        <button type="button" onClick={() => toggle(p)} className="rounded p-0.5 text-fg-subtle hover:bg-surface hover:text-fg" aria-label={`Remove ${p.name}`}><X className="size-3.5" /></button>
                      </li>
                    ))}
                  </ul>
                ) : <span className="inline-flex items-center gap-1 text-xs text-fg-subtle"><UserPlus className="size-3.5" /> Loop in at least one person</span>}
              </dd>
            </div>
          </dl>
          <div className="grid gap-2 border-t border-border p-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Button size="lg" onClick={submit} loading={pending} disabled={!picked.length || reason.trim().length < 5 || !startDate} data-testid="send-request"><Send className="size-4" /> Send request</Button>
            <p className="text-center text-[0.6875rem] text-fg-subtle">You will be notified as each person decides.</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
