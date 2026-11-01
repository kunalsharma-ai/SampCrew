import { Badge, Card, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { RUN_STATUS, when } from '../labels';
import type { RunRow, RunStatus } from '../types';

export const metadata: Metadata = { title: 'Workflow runs' };

const FILTERS: { key: RunStatus | ''; label: string }[] = [
  { key: '', label: 'All' }, { key: 'running', label: 'Running' }, { key: 'waiting', label: 'Waiting' }, { key: 'failed', label: 'Failed' },
  { key: 'succeeded', label: 'Finished' }, { key: 'stopped', label: 'Stopped by a step' }, { key: 'cancelled', label: 'Cancelled' },
];

export default async function RunsPage({ searchParams }: { searchParams: Promise<{ status?: string; workflowId?: string; mode?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (sp.status) qs.set('status', sp.status);
  if (sp.workflowId) qs.set('workflowId', sp.workflowId);
  if (sp.mode === 'live' || sp.mode === 'test') qs.set('mode', sp.mode);
  const rows = await load<RunRow[]>(`/automation/runs?${qs}`);
  const href = (status: string) => {
    const q = new URLSearchParams(qs);
    if (status) q.set('status', status); else q.delete('status');
    return `/automation/runs?${q}`;
  };
  return (
    <>
      <PageHeader eyebrow={<Link href="/automation" className="hover:underline">Automation Studio</Link>} title="Workflow runs" description="Every run with where it got to. Open a run for its step-by-step trace; failed runs can be retried from the step that failed." />
      <div className="mb-4 flex flex-wrap gap-3 text-[13px]">
        {FILTERS.map((f) => <Link key={f.key} href={href(f.key)} className={(sp.status ?? '') === f.key ? 'font-semibold text-accent' : 'text-fg-muted hover:text-fg'}>{f.label}</Link>)}
        {sp.workflowId && <Link href={sp.status ? `/automation/runs?status=${sp.status}` : '/automation/runs'} className="text-fg-muted hover:text-fg">(all workflows)</Link>}
      </div>
      <Card>
        {rows.length === 0 ? <EmptyState title="No runs match" /> : (
          <Table>
            <THead><tr><TH>Started</TH><TH>Workflow</TH><TH>About</TH><TH>Status</TH><TH>Progress</TH><TH>Outcome</TH></tr></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap"><Link className="font-medium text-accent hover:underline" href={`/automation/runs/${r.id}`}>{when(r.createdAt)}</Link></TD>
                  <TD>{r.workflowName} <span className="text-xs text-fg-subtle">v{r.version}</span>{r.mode === 'test' && <Badge tone="ember" className="ml-2">Test</Badge>}</TD>
                  <TD>{r.employeeName ?? '–'}</TD>
                  <TD><Badge tone={RUN_STATUS[r.status].tone} dot>{RUN_STATUS[r.status].label}</Badge></TD>
                  <TD className="tabular-nums text-[13px]">{Math.min(r.stepIndex, r.stepCount)} of {r.stepCount}{r.status === 'waiting' && r.wakeAt ? `, next ${when(r.wakeAt)}` : ''}</TD>
                  <TD className="max-w-[24rem] text-[13px]">{r.error ? <span className="text-danger">{r.error}</span> : r.outcome ?? '–'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
