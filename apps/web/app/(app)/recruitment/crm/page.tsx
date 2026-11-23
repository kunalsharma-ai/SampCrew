import { buttonClass, Card, CardBody, CardHeader, EmptyState, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { CalendarClock, Plus, UserPlus, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { CrmShell } from './crm-shell';
import type { CrmContext, Overview } from './crm-types';

export const metadata: Metadata = { title: 'Candidate CRM' };

const fmt = (d: string) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const KIND_BAR: Record<string, string> = { open: 'bg-info', won: 'bg-success', lost: 'bg-fg-subtle', paused: 'bg-warning' };

export default async function CrmOverviewPage() {
  const [ctx, o] = await Promise.all([load<CrmContext>('/recruitment/crm/context'), load<Overview>('/recruitment/crm/overview')]);
  const maxStage = Math.max(1, ...o.stages.map((s) => s.count));
  const maxSource = Math.max(1, ...o.sources.map((s) => s.count));
  const maxWeek = Math.max(1, ...o.weeks.map((w) => Math.max(w.added, w.joined)));
  return (
    <CrmShell
      ctx={ctx}
      current="/recruitment/crm"
      title="Candidate CRM"
      description="Every candidate, their calls, follow-ups and progress in one place."
      overdue={o.followUps.overdue}
      actions={<Link href="/recruitment/crm/candidates/new" className={buttonClass('primary', 'sm')}><Plus className="size-3.5" /> Add candidate</Link>}
    >
      <div className="grid gap-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Total candidates" value={o.totals.candidates.toLocaleString('en-IN')} hint={`${o.totals.addedThisMonth} added this month · ${o.totals.addedToday} today`} icon={<Users className="size-4" />} />
          <Stat label="In progress" value={o.totals.inProgress} hint={`${o.totals.onHold} on hold · ${o.totals.unassigned} without a recruiter`} />
          <Stat label="Joined" value={o.totals.joined} hint={`${o.conversion.joinRate}% of candidates · ${o.conversion.interviewRate}% reached interview`} icon={<UserPlus className="size-4" />} />
          <Stat label="Follow-ups overdue" value={o.followUps.overdue} hint={`${o.followUps.today} due today · ${o.followUps.upcoming} upcoming`} icon={<CalendarClock className="size-4" />} />
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
          <Card>
            <CardHeader title="My day" description="Your follow-ups that are overdue or due today." action={<Link href="/recruitment/crm/follow-ups" className="text-sm font-medium text-accent hover:underline">All follow-ups</Link>} />
            {o.myDay.length === 0 ? (
              <EmptyState icon={<CalendarClock className="size-5" />} title="Nothing due today" description="Follow-ups you schedule from a candidate’s profile appear here." />
            ) : (
              <ul className="divide-y divide-border">
                {o.myDay.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-3 px-5 py-3 text-[0.8125rem]">
                    <span>
                      <Link href={`/recruitment/crm/candidates/${f.candidateId}`} className="font-medium text-accent hover:underline">{f.candidateName}</Link>
                      <span className="block text-xs text-fg-muted">{f.candidateCode} · {f.type.replace(/_/g, ' ')} · {f.priority}</span>
                    </span>
                    <span className={f.overdue ? 'text-danger' : 'text-fg-muted'}>{f.overdue ? 'Overdue · ' : ''}{fmt(f.dueAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Follow-up summary" description="This week’s follow-up work." />
            <CardBody className="grid grid-cols-2 gap-4 text-[0.8125rem]">
              {[
                ['Overdue', o.followUps.overdue, 'overdue'], ['Due today', o.followUps.today, 'today'], ['Upcoming', o.followUps.upcoming, 'upcoming'],
                ['Completed this week', o.followUps.completedThisWeek, 'completed'], ['Missed this week', o.followUps.missedThisWeek, 'missed'],
              ].map(([label, n, bucket]) => (
                <Link key={label as string} href={`/recruitment/crm/follow-ups?bucket=${bucket}`} className="rounded-lg border border-border p-3 hover:bg-bg-subtle">
                  <span className="block text-xs text-fg-muted">{label}</span>
                  <span className="text-xl font-semibold text-fg">{n}</span>
                </Link>
              ))}
            </CardBody>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Candidates by stage" description="Where everyone is in the recruitment pipeline." action={<Link href="/recruitment/crm/pipeline" className="text-sm font-medium text-accent hover:underline">Open pipeline</Link>} />
            <CardBody className="grid gap-2">
              {o.stages.map((s) => (
                <Link key={s.key} href={`/recruitment/crm/candidates?stage=${s.key}`} className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3 text-[0.8125rem] hover:text-accent">
                  <span className="truncate">{s.label}</span>
                  <span className="h-2 rounded-full bg-bg-subtle"><span className={`block h-2 rounded-full ${KIND_BAR[s.kind] ?? 'bg-info'}`} style={{ width: `${(s.count / maxStage) * 100}%` }} /></span>
                  <span className="text-right tabular-nums">{s.count}</span>
                </Link>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Candidates by source" description="Where candidates came from." />
            <CardBody className="grid gap-2">
              {o.sources.length === 0 && <p className="text-[0.8125rem] text-fg-muted">No candidates yet.</p>}
              {o.sources.map((s) => (
                <Link key={s.key} href={`/recruitment/crm/candidates?source=${s.key}`} className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3 text-[0.8125rem] hover:text-accent">
                  <span className="truncate">{s.label}</span>
                  <span className="h-2 rounded-full bg-bg-subtle"><span className="block h-2 rounded-full bg-accent" style={{ width: `${(s.count / maxSource) * 100}%` }} /></span>
                  <span className="text-right tabular-nums">{s.count}</span>
                </Link>
              ))}
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader title="Weekly trend" description="Candidates added and joined in each of the last 12 weeks." />
          <CardBody>
            <div className="flex h-40 items-end gap-2" role="img" aria-label="Candidates added and joined per week">
              {o.weeks.map((w) => (
                <div key={w.week} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex h-32 w-full items-end justify-center gap-0.5">
                    <span className="w-1/2 max-w-3 rounded-t bg-accent" style={{ height: `${(w.added / maxWeek) * 100}%` }} title={`${w.added} added`} />
                    <span className="w-1/2 max-w-3 rounded-t bg-success" style={{ height: `${(w.joined / maxWeek) * 100}%` }} title={`${w.joined} joined`} />
                  </div>
                  <span className="text-[0.6875rem] text-fg-subtle">{new Date(w.week).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 flex gap-4 text-xs text-fg-muted"><span><span className="mr-1 inline-block size-2 rounded-full bg-accent" />Added</span><span><span className="mr-1 inline-block size-2 rounded-full bg-success" />Joined</span></p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Recruiter-wise view" description="Candidates, follow-ups and calls for each recruiter (last 30 days for activity)." />
          {o.recruiters.length === 0 ? (
            <EmptyState title="No candidates are assigned yet" description="Assign a recruiter from a candidate’s profile or with a bulk action on All Candidates." />
          ) : (
            <Table aria-label="Recruiters">
              <THead><TR><TH>Recruiter</TH><TH>Assigned</TH><TH>In progress</TH><TH>Joined</TH><TH>Pending follow-ups</TH><TH>Overdue</TH><TH>Activities</TH><TH>Calls</TH></TR></THead>
              <TBody>
                {o.recruiters.map((r) => (
                  <TR key={r.membershipId}>
                    <TD><Link className="font-medium text-accent hover:underline" href={`/recruitment/crm/candidates?recruiter=${r.membershipId}`}>{r.name}</Link></TD>
                    <TD>{r.assigned}</TD><TD>{r.open}</TD><TD>{r.joined}</TD><TD>{r.pendingFollowUps}</TD>
                    <TD className={r.overdueFollowUps ? 'text-danger' : ''}>{r.overdueFollowUps}</TD><TD>{r.activities30}</TD><TD>{r.calls30}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" description="The latest calls, notes and changes." action={<Link href="/recruitment/crm/activities" className="text-sm font-medium text-accent hover:underline">All activities</Link>} />
          {o.recent.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="divide-y divide-border">
              {o.recent.map((x) => (
                <li key={x.id} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3 text-[0.8125rem]">
                  <span>
                    <Link href={`/recruitment/crm/candidates/${x.candidateId}`} className="font-medium text-accent hover:underline">{x.candidateName}</Link>
                    <span className="text-fg-muted"> · {x.detail}</span>
                  </span>
                  <span className="text-xs text-fg-subtle">{x.by ? `${x.by} · ` : ''}{fmt(x.occurredAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </CrmShell>
  );
}
