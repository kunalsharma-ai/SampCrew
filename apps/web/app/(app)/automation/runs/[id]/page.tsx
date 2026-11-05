import { Badge, Card, CardBody, CardHeader, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { RUN_STATUS, STEP_STATUS, when } from '../../labels';
import type { RunDetail } from '../../types';
import { RunActions } from './run-actions';

export const metadata: Metadata = { title: 'Workflow run' };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await load<RunDetail>(`/automation/runs/${id}`);
  const st = RUN_STATUS[run.status];
  const context = Object.entries(run.context).filter(([, v]) => v !== null && v !== '');
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/automation/runs" className="hover:underline">Workflow runs</Link>}
        title={<span className="inline-flex flex-wrap items-center gap-3">{run.workflowName}<Badge tone={st.tone} dot>{st.label}</Badge>{run.mode === 'test' && <Badge tone="ember">Test run</Badge>}</span>}
        description={`Version ${run.version}, started ${when(run.createdAt)}${run.finishedAt ? `, ended ${when(run.finishedAt)}` : ''}.`}
        actions={<RunActions id={run.id} canRetry={run.canRetry} canCancel={run.canCancel} />}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader title="Trace" description={run.error ? undefined : run.outcome ?? undefined} />
          <CardBody className="grid gap-4">
            {run.error && <p className="text-[13px] text-danger">{run.error}</p>}
            {run.plan.map((p) => {
              const attempts = run.steps.filter((s) => s.index === p.index);
              const current = run.status === 'running' || run.status === 'waiting' ? run.stepIndex === p.index : false;
              return (
                <div key={p.index} className="flex gap-3">
                  <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${current ? 'bg-accent text-white' : 'bg-bg-subtle text-fg-muted'}`}>{p.index + 1}</span>
                  <div className="min-w-0 text-[13px]">
                    <div className="font-medium">{p.summary}</div>
                    {attempts.length === 0 && <div className="text-fg-subtle">{current ? 'Next' : 'Not reached'}</div>}
                    {attempts.map((a, i) => (
                      <div key={i} className="mt-1">
                        <Badge tone={STEP_STATUS[a.status]?.tone ?? 'neutral'}>{STEP_STATUS[a.status]?.label ?? a.status}</Badge>
                        {a.attempt > 1 && <span className="ml-1 text-xs text-fg-subtle">attempt {a.attempt}</span>}
                        <span className="ml-2">{a.detail}</span>
                        {a.error && <div className="text-danger">{a.error}</div>}
                        <span className="ml-2 text-xs text-fg-subtle">{when(a.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {run.approvalRequestId && run.status === 'waiting' && <p className="text-[13px] text-fg-muted">Waiting for a decision in <Link className="text-accent hover:underline" href="/approvals">Approvals</Link>.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Values" description="What the trigger provided when the run started." />
          <CardBody className="grid gap-1 text-[13px]">
            {context.length === 0 && <p className="text-fg-muted">None.</p>}
            {context.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><span className="text-fg-muted">{k}</span><span className="text-right">{String(v)}</span></div>)}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
