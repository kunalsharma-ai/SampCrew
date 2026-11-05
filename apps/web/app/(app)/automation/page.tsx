import { automation } from '@crew/contracts';
import { Badge, buttonClass, Card, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { when, WORKFLOW_STATUS } from './labels';
import type { WorkflowRow } from './types';

export const metadata: Metadata = { title: 'Automation Studio' };

export default async function AutomationPage() {
  const rows = await load<WorkflowRow[]>('/automation/workflows');
  return (
    <>
      <PageHeader
        title="Automation Studio"
        description="Workflows start when something happens in CREW and run their steps in order: check a condition, notify people, wait, ask for approval or assign a course. Each version is tested before it goes live, and every run is traced."
        actions={<div className="flex gap-2"><Link className={buttonClass('secondary')} href="/automation/runs">Runs</Link><Link className={buttonClass()} href="/automation/new">New workflow</Link></div>}
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="No workflows yet" description="Create one to automate a routine HR step, for example reminding a manager when someone joins their team." action={<Link className={buttonClass()} href="/automation/new">New workflow</Link>} />
        ) : (
          <Table>
            <THead><tr><TH>Workflow</TH><TH>Starts when</TH><TH>Status</TH><TH>Version</TH><TH>Runs as</TH><TH className="text-right">Runs (30 days)</TH><TH className="text-right">Under way</TH><TH className="text-right">Failed</TH></tr></THead>
            <TBody>
              {rows.map((w) => (
                <TR key={w.id}>
                  <TD><Link className="font-medium text-accent hover:underline" href={`/automation/${w.id}`}>{w.name}</Link>{w.description && <div className="text-xs text-fg-muted line-clamp-1">{w.description}</div>}</TD>
                  <TD className="text-[13px]">{automation.TRIGGERS[w.trigger]?.label ?? w.trigger}</TD>
                  <TD><Badge tone={WORKFLOW_STATUS[w.status].tone} dot>{WORKFLOW_STATUS[w.status].label}</Badge>{w.statusReason && <div className="mt-1 text-xs text-danger">{w.statusReason}</div>}</TD>
                  <TD className="text-[13px] tabular-nums">v{w.latestVersion}{w.activeVersion && w.activeVersion !== w.latestVersion ? ` (v${w.activeVersion} live)` : ''}</TD>
                  <TD className="text-[13px]">{w.ownerName}</TD>
                  <TD className="text-right tabular-nums">{w.runs30d}</TD>
                  <TD className="text-right tabular-nums">{w.openRuns}</TD>
                  <TD className="text-right tabular-nums">{w.failedRuns ? <Link className="text-danger hover:underline" href={`/automation/runs?workflowId=${w.id}&status=failed`}>{w.failedRuns}</Link> : 0}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-xs text-fg-subtle">Last updated {when(rows.reduce<string | null>((m, r) => (!m || r.updatedAt > m ? r.updatedAt : m), null))}.</p>
    </>
  );
}
