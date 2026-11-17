import { Badge, Card, CardBody, CardHeader } from '@crew/ui';
import Link from 'next/link';
import type { LateMonth } from '@/lib/types';

const deduction = (basis: string, value: string) => (basis === 'percent' ? `${value}% of the month's gross pay` : `${value} day${value === '1' ? "'s" : "s'"} pay`);

/** One person's late reminders and deductions for the month, with how far they are from the next tier. */
export function LateSummary({ data, own }: { data: LateMonth; own: boolean }) {
  const l = data.policy.late;
  const sent = data.reminders.filter((r) => r.status === 'sent');
  const active = data.penalties.filter((p) => p.status === 'active');
  if (!l.enabled && !data.penalties.length) return null;
  const next = [...l.tiers].sort((a, b) => a.reminders - b.reminders).find((t) => t.reminders > sent.length);
  return (
    <Card>
      <CardHeader
        title="Late reminders and penalties"
        description={own ? 'Reminders you got this month for arriving late, and anything that will be deducted from your salary.' : 'Reminders this person got this month, and what will be deducted.'}
        action={!own ? <Link className="text-sm font-medium text-accent hover:underline" href={`/attendance/late?month=${data.month}`}>Late coming & penalties</Link> : undefined}
      />
      <CardBody className="grid gap-3 text-[0.8125rem]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={sent.length ? 'warning' : 'success'}>{sent.length} late reminder{sent.length === 1 ? '' : 's'}</Badge>
          {data.lateDays.length > 0 && <span className="text-fg-muted">{data.lateDays.length} late arrival{data.lateDays.length === 1 ? '' : 's'} this month</span>}
          {l.enabled && next && <span className="text-fg-muted">At {next.reminders} reminders, {deduction(next.basis, next.value)} is deducted ({next.reminders - sent.length} to go).</span>}
        </div>
        {sent.length > 0 && (
          <ul className="grid gap-1">
            {sent.map((r) => (
              <li key={r.id}>{r.workDate}: reminder {r.sequence}{r.lateMinutes ? `, ${r.lateMinutes} minutes late` : ''}{r.note ? `. “${r.note}”` : ''}</li>
            ))}
          </ul>
        )}
        {data.penalties.map((p) => (
          <div key={p.id} className={p.status === 'active' ? 'text-danger' : 'text-fg-subtle'}>
            {p.label}: {p.deduction} {p.status === 'active' ? 'will be deducted from this month’s salary.' : `(${p.status}${p.statusReason ? `: ${p.statusReason}` : ''}).`}
          </div>
        ))}
        {!active.length && !sent.length && <p className="text-fg-muted">No late reminders this month.</p>}
      </CardBody>
    </Card>
  );
}
