import { Card, CardHeader, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { KpiRow } from '@/components/neon';
import { load } from '@/lib/api';
import { dateLabel, DueLabel, LearnerStatusBadge, minutesLabel, scoreLabel } from '../../../labels';
import type { LearnerProfile } from '../../../types';

export const metadata: Metadata = { title: 'Learning profile' };

export default async function LearnerProfilePage({ params }: { params: Promise<{ employeeId: string }> }) {
  const { employeeId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(employeeId)) return null;
  const p = await load<LearnerProfile>(`/learning/learners/${employeeId}`);
  const e = p.employee;
  return (
    <div className="grid gap-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <h2 className="text-lg font-semibold" data-testid="learner-name">{e.name}</h2>
            <p className="text-xs text-fg-muted">{[e.code, e.designation, e.department, e.hrWorkspace, e.level].filter(Boolean).join(' · ')}</p>
          </div>
          <Link href={`/employees/${e.id}`} className={buttonClass('secondary', 'sm')}>Employee record</Link>
        </div>
      </Card>
      <KpiRow tiles={[
        { key: 'assigned', label: 'Enrolled', value: p.summary.assigned, tone: 'violet', icon: 'graduation-cap' },
        { key: 'done', label: 'Completed', value: p.summary.completed, tone: 'green', icon: 'check', hint: `${p.summary.completionRate ?? 0}% completion` },
        { key: 'overdue', label: 'Overdue', value: p.summary.overdue, tone: 'orange', icon: 'alarm-clock', invert: true },
        { key: 'score', label: 'Average score', value: p.summary.averageScore, unit: 'percent', tone: 'teal', icon: 'award' },
        { key: 'time', label: 'Time spent (min)', value: p.summary.timeSpentMinutes, tone: 'blue', icon: 'clock' },
      ]} />
      <Card>
        <CardHeader title="Learning history" description="Every module, including earlier versions they finished." />
        <Table aria-label="Learning history">
          <THead><TR><TH>Module</TH><TH>Status</TH><TH className="text-right">Progress</TH><TH className="text-right">Score</TH><TH>Assigned</TH><TH>Deadline</TH><TH>Completed</TH><TH>Certificate</TH><TH>Time</TH></TR></THead>
          <TBody>
            {p.rows.map((r) => (
              <TR key={r.id}>
                <TD><Link href={`/learning/manage/enrolments/${r.id}`} className="font-medium hover:underline">{r.moduleTitle}</Link><span className="block text-xs text-fg-subtle">Version {r.version}</span></TD>
                <TD><LearnerStatusBadge status={r.status} /></TD>
                <TD className="text-right tabular-nums">{r.progressPercent}%</TD>
                <TD className="text-right tabular-nums">{scoreLabel(r.scorePercent) || '—'}</TD>
                <TD className="text-xs text-fg-muted">{dateLabel(r.assignedOn)}</TD>
                <TD className="text-xs">{r.status === 'completed' ? '—' : <DueLabel dueOn={r.dueOn} due={r.due} />}</TD>
                <TD className="text-xs text-fg-muted">{dateLabel(r.completedOn) || '—'}</TD>
                <TD className="font-mono text-xs">{r.certificateNo ?? '—'}</TD>
                <TD className="text-xs text-fg-muted">{minutesLabel(r.timeSpentMinutes) ?? '—'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {!p.rows.length && <p className="px-5 pb-5 text-[0.8125rem] text-fg-muted">No learning yet.</p>}
      </Card>
    </div>
  );
}
