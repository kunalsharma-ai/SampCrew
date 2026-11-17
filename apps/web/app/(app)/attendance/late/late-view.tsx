'use client';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { AlarmClock, Bell } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/api';
import type { AttendancePenalty, LateMonth, LateTier } from '@/lib/types';
import { sendReminderAction, waivePenaltyAction, withdrawReminderAction } from './actions';

export const deduction = (t: Pick<LateTier, 'basis' | 'value'>) => (t.basis === 'percent' ? `${t.value}% of the month's gross pay` : `${t.value} day${t.value === '1' ? "'s" : "s'"} pay`);
const time = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '—');
const PENALTY_TONE: Record<string, 'danger' | 'neutral' | 'success'> = { active: 'danger', waived: 'success', cancelled: 'neutral' };

/** The workspace's late-coming rules in one sentence. */
export function RulesLine({ policy }: { policy: LateMonth['policy'] }) {
  const l = policy.late;
  if (!l.enabled) return null;
  const tiers = l.tiers.length ? l.tiers.map((t) => `${t.reminders} reminders: ${deduction(t)}`).join('; ') : 'reminders only, no deduction';
  return (
    <p className="text-[0.8125rem] text-fg-muted">
      {l.autoReminders ? `Reminders go out automatically for arrivals ${l.minLateMinutes}+ minutes late` : 'Reminders are sent by hand'}
      {l.email ? ', in the app and by email' : ', in the app'}. Deductions per month: {tiers}.
    </p>
  );
}

/** Asks for a reason (or a note) before an action. */
function ReasonDialog({ open, title, label, required, submit, onClose, onSubmit, pending }: {
  open: boolean; title: string; label: string; required: boolean; submit: string; pending: boolean; onClose: () => void; onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={required && text.trim().length < 3} onClick={() => onSubmit(text.trim())}>{submit}</Button></>}
    >
      <Field label={label} required={required}>{(p) => <Textarea {...p} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />}</Field>
    </Dialog>
  );
}

export function LateMonthView({ data }: { data: LateMonth }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [ask, setAsk] = useState<null | { kind: 'remind'; employeeId: string; workDate: string; name: string; late: boolean } | { kind: 'withdraw'; id: string } | { kind: 'waive'; id: string }>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Done' } : { tone: 'danger', text: r.message });
    if (r.ok) {
      setAsk(null);
      router.refresh();
    }
  });
  const submit = (text: string) => {
    if (!ask) return;
    if (ask.kind === 'remind') run(() => sendReminderAction({ employeeId: ask.employeeId, workDate: ask.workDate, ...(text ? { note: text } : {}) }));
    if (ask.kind === 'withdraw') run(() => withdrawReminderAction(ask.id, text));
    if (ask.kind === 'waive') run(() => waivePenaltyAction(ask.id, text));
  };
  const sent = data.reminders.filter((r) => r.status === 'sent');
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {!data.policy.late.enabled ? (
        <Alert tone="info" title="Late-coming reminders are off">
          Nothing is sent or deducted for late arrivals. An attendance admin can switch them on in <Link className="underline" href="/settings/attendance">Attendance settings</Link>.
        </Alert>
      ) : <RulesLine policy={data.policy} />}

      <Card>
        <CardHeader title="People this month" description="Late days, live reminders and the deductions payroll will make for the month." />
        {data.people.length ? (
          <Table>
            <THead><tr><TH>Employee</TH><TH>Late days</TH><TH>Reminders</TH><TH>Deductions</TH></tr></THead>
            <TBody>
              {data.people.map((p) => (
                <TR key={p.employeeId}>
                  <TD className="font-medium">{p.employeeName ?? '—'}</TD>
                  <TD className="tabular">{p.lateDays}</TD>
                  <TD className="tabular">{p.reminders}</TD>
                  <TD>{p.deductions.length ? p.deductions.map((d) => <div key={d} className="text-[0.8125rem] text-danger">{d}</div>) : <span className="text-fg-subtle">None</span>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState icon={<AlarmClock className="size-5" />} title="Nobody was late" description="No late arrivals, reminders or penalties this month for the people you can see." />}
      </Card>

      <Card>
        <CardHeader title="Late arrivals" description="Every day someone arrived after their shift start and grace time. Send a reminder for a day that did not get one." />
        {data.lateDays.length ? (
          <Table>
            <THead><tr><TH>Date</TH><TH>Employee</TH><TH>In at</TH><TH>Late by</TH><TH>Reminder</TH><TH /></tr></THead>
            <TBody>
              {data.lateDays.map((d) => (
                <TR key={`${d.employeeId}-${d.workDate}`}>
                  <TD className="whitespace-nowrap"><Link className="hover:underline" href={`/attendance/day/${d.employeeId}/${d.workDate}`}>{d.workDate}</Link></TD>
                  <TD>{d.employeeName}<div className="text-xs text-fg-subtle">{d.employeeCode}</div></TD>
                  <TD className="tabular">{time(d.firstIn)}</TD>
                  <TD className="tabular">{d.lateMinutes}m{!d.counts && <span className="block text-xs text-fg-subtle">under the threshold</span>}</TD>
                  <TD>{d.reminder ? <Badge tone="warning">Reminder {d.reminder.sequence} · {d.reminder.source === 'auto' ? 'automatic' : 'by hand'}</Badge> : <span className="text-fg-subtle">None</span>}</TD>
                  <TD className="text-right">
                    {d.canRemind && data.policy.late.enabled && (
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => setAsk({ kind: 'remind', employeeId: d.employeeId, workDate: d.workDate, name: d.employeeName ?? '', late: true })}>
                        <Bell className="size-3.5" /> Send reminder
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No late arrivals" description="Nobody you can see arrived late this month." />}
      </Card>

      <Card>
        <CardHeader title="Reminders sent" description={`${sent.length} live reminder${sent.length === 1 ? '' : 's'} this month. Withdrawing one works out the month's deduction again.`} />
        {data.reminders.length ? (
          <Table>
            <THead><tr><TH>Date</TH><TH>Employee</TH><TH>No.</TH><TH>Sent</TH><TH>Status</TH><TH /></tr></THead>
            <TBody>
              {data.reminders.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap">{r.workDate}</TD>
                  <TD>{r.employeeName}{r.note && <div className="text-xs text-fg-subtle">“{r.note}”</div>}</TD>
                  <TD className="tabular">{r.sequence}</TD>
                  <TD className="text-[0.8125rem]">{r.source === 'auto' ? 'Automatically' : `By ${r.sentBy ?? 'a manager'}`}{r.emailed ? ', with email' : ''}</TD>
                  <TD>{r.status === 'sent' ? <Badge tone="warning">Sent</Badge> : <Badge>Withdrawn</Badge>}{r.withdrawnReason && <div className="text-xs text-fg-subtle">{r.withdrawnReason}</div>}</TD>
                  <TD className="text-right">{r.canWithdraw && <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAsk({ kind: 'withdraw', id: r.id })}>Withdraw</Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No reminders yet" />}
      </Card>

      <PenaltiesCard penalties={data.penalties} pending={pending} onWaive={(id) => setAsk({ kind: 'waive', id })} />

      <ReasonDialog
        key={ask ? JSON.stringify(ask) : 'none'}
        open={!!ask}
        pending={pending}
        onClose={() => setAsk(null)}
        onSubmit={submit}
        title={ask?.kind === 'remind' ? `Send a late reminder to ${ask.name} for ${ask.workDate}` : ask?.kind === 'withdraw' ? 'Withdraw this reminder' : 'Waive this penalty'}
        label={ask?.kind === 'remind' ? 'Note to the employee' : 'Reason'}
        required={ask?.kind !== 'remind'}
        submit={ask?.kind === 'remind' ? 'Send reminder' : ask?.kind === 'withdraw' ? 'Withdraw' : 'Waive'}
      />
    </div>
  );
}

export function PenaltiesCard({ penalties, pending, onWaive }: { penalties: (AttendancePenalty & { canWaive?: boolean })[]; pending?: boolean; onWaive?: (id: string) => void }) {
  return (
    <Card>
      <CardHeader title="Penalties this month" description="Late-coming deductions and same-day leave penalties. Active ones are deducted in this month's payroll." />
      {penalties.length ? (
        <Table>
          <THead><tr><TH>Employee</TH><TH>Penalty</TH><TH>Deduction</TH><TH>How</TH><TH>Status</TH><TH /></tr></THead>
          <TBody>
            {penalties.map((p) => (
              <TR key={p.id}>
                <TD>{p.employeeName ?? '—'}</TD>
                <TD>{p.label}{p.reason && <div className="text-xs text-fg-subtle">{p.reason}</div>}</TD>
                <TD className="font-medium">{p.deduction}</TD>
                <TD className="text-[0.8125rem]">{p.source === 'auto' ? 'Workspace rule' : `By ${p.createdBy ?? 'a manager'}`}</TD>
                <TD><Badge tone={PENALTY_TONE[p.status] ?? 'neutral'}>{p.status === 'active' ? 'Will be deducted' : p.status === 'waived' ? 'Waived' : 'Cancelled'}</Badge>{p.statusReason && <div className="text-xs text-fg-subtle">{p.statusReason}{p.statusBy ? ` (${p.statusBy})` : ''}</div>}</TD>
                <TD className="text-right">{p.canWaive && onWaive && <Button size="sm" variant="ghost" disabled={pending} onClick={() => onWaive(p.id)}>Waive</Button>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="No penalties" description="Nothing will be deducted for attendance this month." />}
    </Card>
  );
}

