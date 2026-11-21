import { Badge, Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import { GraduationCap } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ChartPanel, DonutChart, KpiRow, MeterRows } from '@/components/neon';
import { load } from '@/lib/api';
import { dateLabel, scoreLabel } from '../labels';
import type { Group, LearningAccessView, LearningDashboard } from '../types';

export const metadata: Metadata = { title: 'Learning management' };

function GroupTable({ title, rows, label, testId }: { title: string; rows: Group[]; label: string; testId?: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader title={title} />
      {rows.length ? (
        <Table aria-label={title}>
          <THead><TR><TH>{label}</TH><TH className="text-right">Assigned</TH><TH className="text-right">Completed</TH><TH className="text-right">Completion</TH><TH className="text-right">Avg. score</TH></TR></THead>
          <TBody>
            {rows.slice(0, 8).map((r) => (
              <TR key={r.name}>
                <TD className="font-medium">{r.name}{r.overdue > 0 && <span className="block text-xs font-normal text-danger">{r.overdue} overdue</span>}</TD>
                <TD className="text-right tabular-nums">{r.assigned}</TD>
                <TD className="text-right tabular-nums">{r.completed}</TD>
                <TD className="text-right tabular-nums">{r.completionRate ?? 0}%</TD>
                <TD className="text-right tabular-nums">{scoreLabel(r.averageScore) || '—'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <p className="px-5 pb-5 text-[0.8125rem] text-fg-muted">Nothing assigned yet.</p>}
    </Card>
  );
}

export default async function LearningDashboardPage() {
  const [d, access] = await Promise.all([load<LearningDashboard>('/learning/dashboard'), load<LearningAccessView>('/learning/access')]);
  const empty = d.assigned === 0;
  return (
    <div className="grid gap-5" data-testid="learning-dashboard">
      <KpiRow tiles={[
        { key: 'modules', label: 'Learning modules', value: d.modules.total, tone: 'violet', icon: 'book-open', hint: `${d.modules.published} published · ${d.modules.draft} draft${d.modules.scheduled ? ` · ${d.modules.scheduled} scheduled` : ''}`, href: '/learning/manage/library' },
        { key: 'learners', label: 'Learners', value: d.learners, tone: 'blue', icon: 'users', hint: `${d.assigned} enrolments` },
        { key: 'completion', label: 'Completion rate', value: d.completionRate, unit: 'percent', tone: 'green', icon: 'check', hint: `${d.completed} completed${d.averageScore !== null ? ` · average score ${d.averageScore}%` : ''}` },
        { key: 'overdue', label: 'Overdue', value: d.overdue, tone: 'orange', icon: 'alarm-clock', invert: true, ...(access.caps.reports ? { href: '/learning/manage/reports?status=overdue' } : {}) },
        { key: 'reviews', label: 'Waiting for review', value: d.pendingSubmissions + d.pendingQuizReviews, tone: 'teal', icon: 'clipboard-list', hint: `${d.pendingSubmissions} assignments · ${d.pendingQuizReviews} quizzes`, ...(access.caps.grade ? { href: '/learning/manage/reviews' } : {}) },
      ]} />
      {empty ? (
        <EmptyState icon={<GraduationCap className="size-5" />} title="No learning assigned yet" description="Create a module, publish it and assign it. Progress, scores and completions show here as people learn."
          action={access.caps.create ? <Link href="/learning/manage/new" className={buttonClass('primary', 'sm')}>Create a learning module</Link> : undefined} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartPanel title="Where everyone is">
              <DonutChart
                centerValue={`${d.completionRate ?? 0}%`}
                centerLabel="completed"
                slices={[
                  { label: 'Completed', value: d.completed, color: 'var(--success)' },
                  { label: 'In progress', value: d.inProgress, color: 'var(--info)' },
                  { label: 'Not started', value: d.notStarted, color: 'var(--fg-subtle)' },
                  { label: 'Overdue', value: d.overdue, color: 'var(--danger)' },
                ]}
              />
            </ChartPanel>
            <ChartPanel title="Completion by learning module">
              <MeterRows rows={d.byModule.slice(0, 8).map((m) => ({ label: m.name, value: Math.round(m.completionRate ?? 0), count: m.completed }))} caption="Share of enrolled people who completed each module." />
            </ChartPanel>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <GroupTable title="By HR Workspace" label="HR Workspace" rows={d.byHrWorkspace} testId="by-hr-workspace" />
            <GroupTable title="By department" label="Department" rows={d.byDepartment} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <GroupTable title="By job role" label="Job role" rows={d.byDesignation} />
            <Card>
              <CardHeader title="Quiz results" />
              {d.quizResults.length ? (
                <Table aria-label="Quiz results">
                  <THead><TR><TH>Quiz</TH><TH className="text-right">Attempts</TH><TH className="text-right">Avg. score</TH><TH className="text-right">Pass rate</TH></TR></THead>
                  <TBody>{d.quizResults.map((q) => <TR key={`${q.module}${q.quiz}`}><TD><span className="font-medium">{q.quiz}</span><span className="block text-xs text-fg-muted">{q.module}</span></TD><TD className="text-right tabular-nums">{q.attempts}</TD><TD className="text-right tabular-nums">{scoreLabel(q.averagePercent) || '—'}</TD><TD className="text-right tabular-nums">{q.passRate ?? 0}%</TD></TR>)}</TBody>
                </Table>
              ) : <p className="px-5 pb-5 text-[0.8125rem] text-fg-muted">No quiz attempts yet.</p>}
            </Card>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title="Recent completions" />
              {d.recentCompletions.length ? (
                <ul className="divide-y divide-border">
                  {d.recentCompletions.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[0.8125rem]">
                      <span><Link href={`/learning/manage/learners/${r.employeeId}`} className="font-medium hover:underline">{r.employeeName}</Link><span className="block text-xs text-fg-muted">{r.moduleTitle}</span></span>
                      <span className="text-right text-xs text-fg-muted">{dateLabel(r.completedOn)}{r.scorePercent !== null && <Badge tone="success" className="ml-2">{r.scorePercent}%</Badge>}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="px-5 pb-5 text-[0.8125rem] text-fg-muted">No completions yet.</p>}
            </Card>
            <Card>
              <CardHeader title="Overdue learning" />
              {d.overdueList.length ? (
                <ul className="divide-y divide-border">
                  {d.overdueList.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[0.8125rem]">
                      <span><Link href={`/learning/manage/learners/${r.employeeId}`} className="font-medium hover:underline">{r.employeeName}</Link><span className="block text-xs text-fg-muted">{r.moduleTitle} · {r.hrWorkspace ?? 'Central group'}</span></span>
                      <span className="text-xs font-medium text-danger">Due {dateLabel(r.dueOn)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="px-5 pb-5 text-[0.8125rem] text-fg-muted">Nothing is overdue.</p>}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
