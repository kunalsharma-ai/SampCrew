import { ModuleNotices } from '@/components/module-notices';
import { buttonClass, Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Award } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { SubNav } from '@/components/sub-nav';
import { load, loadOptional } from '@/lib/api';
import type { AppraisalSummary, Me } from '@/lib/types';
import { day, pct, Ring, StageBadge, StageStepper } from './appraisal-ui';

export const metadata: Metadata = { title: 'Appraisal' };

function ReviewTable({ rows, empty }: { rows: AppraisalSummary[]; empty: string }) {
  if (!rows.length) return <EmptyState title="Nothing here" description={empty} />;
  return (
    <Table aria-label="Appraisals">
      <THead><tr><TH>Employee</TH><TH>Cycle</TH><TH>Stage</TH><TH>Self</TH><TH>Manager</TH><TH>Final</TH><TH><span className="sr-only">Open</span></TH></tr></THead>
      <TBody>
        {rows.map((a) => (
          <TR key={a.id}>
            <TD><div className="font-medium">{a.employeeName}</div><div className="text-xs text-fg-subtle">{a.departmentName ?? ''}</div></TD>
            <TD>{a.cycleName}</TD>
            <TD><StageBadge stage={a.stage} />{a.overdue && <span className="ml-2 text-xs font-medium text-danger">Overdue</span>}</TD>
            <TD className="tabular">{pct(a.selfPercent)}</TD>
            <TD className="tabular">{pct(a.managerPercent)}</TD>
            <TD className="tabular">{pct(a.finalPercent)}{a.band ? <div className="text-xs text-fg-subtle">{a.band}</div> : null}</TD>
            <TD><Link className={buttonClass('secondary', 'sm')} href={`/appraisal/${a.id}`}>Open<span className="sr-only"> {a.employeeName}</span></Link></TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export default async function AppraisalPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const [me, mine, reviews] = await Promise.all([
    load<Me>('/me'),
    loadOptional<AppraisalSummary[]>('/appraisals/mine'),
    load<{ team: AppraisalSummary[]; hr: AppraisalSummary[]; isHr: boolean }>('/appraisals/reviews'),
  ]);
  const teamWaiting = reviews.team.filter((a) => a.stage === 'manager').length;
  const hrWaiting = reviews.hr.filter((a) => a.stage === 'hr').length;
  const tabs = [
    { href: '/appraisal?tab=mine', label: 'My appraisal' },
    ...(reviews.team.length ? [{ href: '/appraisal?tab=team', label: 'My team', count: teamWaiting, alert: teamWaiting > 0, testId: 'tab-team-appraisals' }] : []),
    ...(reviews.isHr ? [{ href: '/appraisal?tab=hr', label: 'HR review', count: hrWaiting, alert: hrWaiting > 0, testId: 'tab-hr-appraisals' }] : []),
  ];
  const tab = tabs.some((t) => t.href === `/appraisal?tab=${sp.tab}`) ? sp.tab! : 'mine';
  const current = mine?.[0];
  const history = (mine ?? []).slice(1);
  return (
    <>
      <PageHeader
        title="Appraisal & performance"
        description="Your self-appraisal, your manager's evaluation and HR's final result, stage by stage."
        actions={reviews.isHr && me.permissions['performance:configure'] ? <Link className={buttonClass('secondary')} href="/settings/appraisals">Forms & cycles</Link> : undefined}
      />
      <ModuleNotices category="appraisal" label="Appraisal" />
      {tabs.length > 1 && <SubNav label="Appraisal views" items={tabs} current={`/appraisal?tab=${tab}`} />}
      {tab === 'team' && <Card><CardHeader title="Team appraisals" description="Evaluate each person once they submit their self-appraisal. Their scores lock when they submit." /><ReviewTable rows={reviews.team} empty="When someone you manage has an appraisal, it appears here." /></Card>}
      {tab === 'hr' && <Card><CardHeader title="Waiting for HR" description="Manager evaluations that are in, and finalised appraisals not yet shared with the employee." /><ReviewTable rows={reviews.hr} empty="Appraisals reach HR after the manager submits." /></Card>}
      {tab === 'mine' && (
        <div className="grid gap-6">
          {!current ? (
            <Card><EmptyState icon={<Award className="size-6" />} title="No appraisal yet" description="When HR opens an appraisal cycle you are part of, it appears here and you are notified." /></Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="grid gap-6 bg-gradient-to-br from-accent/10 via-transparent to-transparent p-6 lg:grid-cols-[minmax(0,1fr)_auto]">
                <div className="grid content-start gap-4">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Current appraisal</div>
                    <h2 className="mt-1 text-xl font-semibold">{current.cycleName}</h2>
                    <p className="text-sm text-fg-muted">{current.formTitle} · {day(current.periodStart)} to {day(current.periodEnd)}</p>
                  </div>
                  <StageStepper stage={current.stage} />
                  <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    <div><dt className="text-xs text-fg-subtle">Self-appraisal due</dt><dd className={current.overdue && current.stage === 'self' ? 'font-medium text-danger' : 'font-medium'}>{day(current.selfDue)}</dd></div>
                    <div><dt className="text-xs text-fg-subtle">Manager</dt><dd className="font-medium">{current.managerName ?? 'HR'}</dd></div>
                    <div><dt className="text-xs text-fg-subtle">Performance category</dt><dd className="font-medium">{current.band ?? 'After HR shares it'}</dd></div>
                    <div><dt className="text-xs text-fg-subtle">Status</dt><dd><StageBadge stage={current.stage} /></dd></div>
                  </dl>
                  <div><Link className={buttonClass('primary')} href={`/appraisal/${current.id}`}>{current.stage === 'self' ? (current.selfCompletion ? 'Continue self-appraisal' : 'Start self-appraisal') : 'View appraisal'}</Link></div>
                </div>
                <div className="flex flex-wrap justify-center gap-6">
                  <Ring value={current.selfCompletion} label="Self-appraisal complete" />
                  <Ring value={current.selfPercent} label="Your score" />
                  <Ring value={current.managerPercent} label="Manager score" />
                  <Ring value={current.finalPercent} label="Final" />
                </div>
              </div>
            </Card>
          )}
          <Card>
            <CardHeader title="Previous appraisals" />
            {history.length ? (
              <Table aria-label="Previous appraisals">
                <THead><tr><TH>Cycle</TH><TH>Period</TH><TH>Final</TH><TH>Category</TH><TH><span className="sr-only">Open</span></TH></tr></THead>
                <TBody>
                  {history.map((a) => (
                    <TR key={a.id}>
                      <TD className="font-medium">{a.cycleName}</TD>
                      <TD>{day(a.periodStart)} to {day(a.periodEnd)}</TD>
                      <TD className="tabular">{pct(a.finalPercent)}</TD>
                      <TD>{a.band ?? <StageBadge stage={a.stage} />}</TD>
                      <TD><Link className={buttonClass('secondary', 'sm')} href={`/appraisal/${a.id}`}>Open<span className="sr-only"> {a.cycleName}</span></Link></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : <EmptyState title="No earlier appraisals" description="Finished appraisals stay here with their results." />}
          </Card>
        </div>
      )}
    </>
  );
}
