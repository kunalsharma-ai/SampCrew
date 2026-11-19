import { Badge, buttonClass, Card, CardHeader, EmptyState, PageHeader, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { AppraisalCycle, AppraisalForm, AppraisalSummary, Department } from '@/lib/types';
import { day, pct, StageBadge } from '../../../../appraisal/appraisal-ui';
import { CycleCommands, CycleDialog } from '../../admin-ui';
import { flatDepartments } from '../../departments';

export const metadata: Metadata = { title: 'Appraisal cycle' };

export default async function AppraisalCyclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadOptional<{ cycle: AppraisalCycle; appraisals: AppraisalSummary[] }>(`/appraisals/cycles/${id}`);
  if (!data) notFound();
  const { cycle, appraisals } = data;
  const [forms, departments] = cycle.status === 'draft'
    ? await Promise.all([load<{ forms: AppraisalForm[] }>('/appraisals/forms'), loadOptional<Department[]>('/org/departments')])
    : [null, null];
  const s = cycle.byStage;
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/settings/appraisals" className="hover:underline">Appraisal forms & cycles</Link>}
        title={cycle.name}
        description={`${cycle.formName ?? 'Form picked by rules'} · ${day(cycle.periodStart)} to ${day(cycle.periodEnd)}${cycle.departmentNames.length ? ` · ${cycle.departmentNames.join(', ')}` : ' · everyone'}`}
        actions={forms ? <CycleDialog cycle={cycle} forms={forms.forms.filter((f) => f.active)} departments={flatDepartments(departments)} label="Edit cycle" /> : undefined}
      />
      <div className="grid gap-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <Stat label="Self-appraisal" value={s.self ?? 0} />
          <Stat label="With managers" value={s.manager ?? 0} />
          <Stat label="With HR" value={s.hr ?? 0} />
          <Stat label="Finalised" value={s.finalized ?? 0} />
          <Stat label="Shared" value={s.published ?? 0} />
        </div>
        <Card>
          <CardHeader title="Cycle status" description={`Deadlines: self-appraisal ${day(cycle.selfDue)}, manager ${day(cycle.managerDue)}${cycle.hrDue ? `, HR ${day(cycle.hrDue)}` : ''}.`} action={<Badge tone={cycle.status === 'active' ? 'accent' : cycle.status === 'closed' ? 'success' : 'neutral'} dot>{cycle.status === 'draft' ? 'Draft' : cycle.status === 'active' ? 'Running' : 'Closed'}</Badge>} />
          <div className="px-5 pb-5"><CycleCommands cycle={cycle} /></div>
        </Card>
        <Card>
          <CardHeader title="Appraisals in this cycle" />
          {appraisals.length ? (
            <Table aria-label="Appraisals in this cycle">
              <THead><tr><TH>Employee</TH><TH>Manager</TH><TH>Stage</TH><TH>Self</TH><TH>Manager</TH><TH>Final</TH><TH><span className="sr-only">Open</span></TH></tr></THead>
              <TBody>
                {appraisals.map((a) => (
                  <TR key={a.id}>
                    <TD><div className="font-medium">{a.employeeName}</div><div className="text-xs text-fg-subtle">{a.departmentName ?? ''}</div></TD>
                    <TD>{a.managerName ?? 'HR'}</TD>
                    <TD><StageBadge stage={a.stage} />{a.overdue && <span className="ml-2 text-xs font-medium text-danger">Overdue</span>}</TD>
                    <TD className="tabular">{pct(a.selfPercent)}</TD>
                    <TD className="tabular">{pct(a.managerPercent)}</TD>
                    <TD className="tabular">{pct(a.finalPercent)}{a.band ? <div className="text-xs text-fg-subtle">{a.band}</div> : null}</TD>
                    <TD><Link className={buttonClass('secondary', 'sm')} href={`/appraisal/${a.id}`}>Open<span className="sr-only"> {a.employeeName}</span></Link></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : <EmptyState title={cycle.status === 'draft' ? 'Not launched yet' : 'Nobody in this cycle'} description={cycle.status === 'draft' ? 'Launch the cycle to create an appraisal for each person in it.' : 'No one matched the cycle when it was launched.'} />}
        </Card>
      </div>
    </>
  );
}
