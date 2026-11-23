import { Alert, Button, Card, CardHeader, EmptyState, Input, Select, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import { Download, FileBarChart } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { dateLabel, DueLabel, LearnerStatusBadge, scoreLabel } from '../../labels';
import type { EnrolmentRow, LearningAccessView, LearningOptions, ModuleSummary, Tally } from '../../types';

export const metadata: Metadata = { title: 'Learning reports' };

const KEYS = ['moduleId', 'hrWorkspaceId', 'departmentId', 'designationId', 'status', 'from', 'to', 'minScore', 'maxScore', 'q'] as const;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Partial<Record<(typeof KEYS)[number], string>>> }) {
  const sp = await searchParams;
  const access = await load<LearningAccessView>('/learning/access');
  if (!access.caps.reports) return <Alert tone="warning">Your Super Workspace has not let your HR Workspace see learning reports.</Alert>;
  const qs = new URLSearchParams();
  for (const k of KEYS) if (sp[k]) qs.set(k, sp[k]!.slice(0, 100));
  const [report, options, modules] = await Promise.all([
    load<{ rows: EnrolmentRow[]; total: number; summary: Tally; canExport: boolean }>(`/learning/reports?${qs}`),
    load<LearningOptions>('/learning/options'),
    load<ModuleSummary[]>('/learning/modules?status=all'),
  ]);
  const s = report.summary;
  const filtered = KEYS.some((k) => sp[k]);
  return (
    <div className="grid gap-4">
      <form className="grid gap-2 rounded-xl border border-border bg-bg-elevated p-4 sm:grid-cols-2 lg:grid-cols-5" role="search" aria-label="Report filters">
        <Input name="q" defaultValue={sp.q} placeholder="Employee, ID or module" aria-label="Search" />
        <Select name="moduleId" defaultValue={sp.moduleId ?? ''} aria-label="Learning module"><option value="">Every module</option>{modules.filter((m) => m.version > 0).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</Select>
        <Select name="hrWorkspaceId" defaultValue={sp.hrWorkspaceId ?? ''} aria-label="HR Workspace"><option value="">Every HR Workspace</option>{options.canAssignCentral && <option value="central">Central group</option>}{options.hrWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
        <Select name="departmentId" defaultValue={sp.departmentId ?? ''} aria-label="Department"><option value="">Every department</option>{options.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select name="designationId" defaultValue={sp.designationId ?? ''} aria-label="Job role"><option value="">Every job role</option>{options.designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select name="status" defaultValue={sp.status ?? ''} aria-label="Status"><option value="">Any status</option><option value="not_started">Not started</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="overdue">Overdue</option></Select>
        <label className="grid gap-1 text-xs text-fg-muted">From<Input type="date" name="from" defaultValue={sp.from} /></label>
        <label className="grid gap-1 text-xs text-fg-muted">To<Input type="date" name="to" defaultValue={sp.to} /></label>
        <label className="grid gap-1 text-xs text-fg-muted">Score at least (%)<Input type="number" min={0} max={100} name="minScore" defaultValue={sp.minScore} /></label>
        <label className="grid gap-1 text-xs text-fg-muted">Score at most (%)<Input type="number" min={0} max={100} name="maxScore" defaultValue={sp.maxScore} /></label>
        <div className="flex flex-wrap items-end gap-2 lg:col-span-5">
          <Button type="submit" size="sm" variant="secondary">Show</Button>
          {filtered && <Link href="/learning/manage/reports" className={buttonClass('ghost', 'sm')}>Clear</Link>}
          {report.canExport && <a href={`/learning-export?${qs}`} className={buttonClass('primary', 'sm', 'ml-auto')} data-testid="export-learning"><Download className="size-4" aria-hidden />Export to Excel</a>}
        </div>
      </form>
      <Card>
        <CardHeader title={`${report.total} enrolment${report.total === 1 ? '' : 's'}`} description={`${s.completed} completed (${s.completionRate ?? 0}%) · ${s.inProgress} in progress · ${s.notStarted} not started · ${s.overdue} overdue${s.averageScore !== null ? ` · average score ${s.averageScore}%` : ''}`} />
        {report.rows.length ? (
          <Table aria-label="Learning report">
            <THead><TR><TH>Employee</TH><TH>HR Workspace</TH><TH>Department</TH><TH>Module</TH><TH>Status</TH><TH className="text-right">Progress</TH><TH className="text-right">Score</TH><TH>Deadline</TH><TH>Completed</TH></TR></THead>
            <TBody>
              {report.rows.map((r) => (
                <TR key={r.id} data-testid="report-row">
                  <TD><Link href={`/learning/manage/learners/${r.employeeId}`} className="font-medium hover:underline">{r.employeeName}</Link><span className="block text-xs text-fg-muted">{r.employeeCode}{r.designation ? ` · ${r.designation}` : ''}</span></TD>
                  <TD className="text-fg-muted">{r.hrWorkspace ?? 'Central group'}</TD>
                  <TD className="text-fg-muted">{r.department ?? '—'}</TD>
                  <TD><Link href={`/learning/manage/enrolments/${r.id}`} className="hover:underline">{r.moduleTitle}</Link><span className="block text-xs text-fg-subtle">Version {r.version}</span></TD>
                  <TD><LearnerStatusBadge status={r.status} /></TD>
                  <TD className="text-right tabular-nums">{r.progressPercent}%</TD>
                  <TD className="text-right tabular-nums">{scoreLabel(r.scorePercent) || '—'}</TD>
                  <TD className="text-xs">{r.status === 'completed' ? '—' : <DueLabel dueOn={r.dueOn} due={r.due} />}</TD>
                  <TD className="text-xs text-fg-muted">{dateLabel(r.completedOn) || '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <div className="p-5"><EmptyState icon={<FileBarChart className="size-5" />} title="No records" description={filtered ? 'Nothing matches these filters.' : 'Records appear once learning is assigned.'} /></div>}
        {report.total > report.rows.length && <p className="px-5 pb-4 text-xs text-fg-muted">Showing the first {report.rows.length}. Narrow the filters or export to Excel for every row.</p>}
      </Card>
    </div>
  );
}
