import { ACTIVITY_TYPES, CALL_OUTCOMES } from '@crew/contracts';
import { Badge, Card, CardBody, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { CrmShell } from '../crm-shell';
import type { Activity, CrmContext } from '../crm-types';
import { ActivityFilters } from './activity-filters';

export const metadata: Metadata = { title: 'Activities · Candidate CRM' };
const fmt = (d: string) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const date = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '');

export default async function CrmActivitiesPage({ searchParams }: { searchParams: Promise<{ type?: string; outcome?: string; by?: string; from?: string; to?: string; include?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (sp.type && ACTIVITY_TYPES.some(([k]) => k === sp.type)) qs.set('type', sp.type);
  if (sp.outcome && CALL_OUTCOMES.some(([k]) => k === sp.outcome)) qs.set('outcome', sp.outcome);
  if (sp.by && /^(me|[0-9a-f-]{36})$/.test(sp.by)) qs.set('by', sp.by);
  if (date(sp.from)) qs.set('from', date(sp.from));
  if (date(sp.to)) qs.set('to', date(sp.to));
  if (sp.include === 'all') qs.set('include', 'all');
  qs.set('limit', '300');
  const [ctx, data] = await Promise.all([
    load<CrmContext>('/recruitment/crm/context'),
    load<{ total: number; calls: { outcome: string; label: string; count: number }[]; rows: Activity[] }>(`/recruitment/crm/activities?${qs}`),
  ]);
  const callTotal = data.calls.reduce((n, c) => n + c.count, 0);
  return (
    <CrmShell ctx={ctx} current="/recruitment/crm/activities" title="Activities" description="Every call, email, message and meeting logged by recruiters, with call outcomes.">
      <div className="grid gap-6">
        <Card>
          <CardHeader title="Call outcomes" description={`${callTotal} call${callTotal === 1 ? '' : 's'} in this view.`} />
          <CardBody className="flex flex-wrap gap-2">
            {data.calls.length === 0 && <p className="text-[0.8125rem] text-fg-muted">No calls logged in this view.</p>}
            {data.calls.map((c) => <Link key={c.outcome} href={`?${new URLSearchParams({ ...Object.fromEntries(qs), type: 'call', outcome: c.outcome })}`}><Badge tone="neutral">{c.label}: {c.count}</Badge></Link>)}
          </CardBody>
        </Card>
        <Card>
          <ActivityFilters ctx={ctx} current={Object.fromEntries(qs)} />
          {data.rows.length === 0 ? <EmptyState title="No activities match" description="Log a call or activity from a candidate’s profile." /> : (
            <Table aria-label="Activities">
              <THead><TR><TH>When</TH><TH>Candidate</TH><TH>Activity</TH><TH>Outcome</TH><TH>Remarks</TH><TH>By</TH></TR></THead>
              <TBody>
                {data.rows.map((a) => (
                  <TR key={a.id}>
                    <TD className="whitespace-nowrap">{fmt(a.occurredAt)}</TD>
                    <TD><Link href={`/recruitment/crm/candidates/${a.candidateId}?tab=activities`} className="font-medium text-accent hover:underline">{a.candidateName}</Link><span className="block text-xs text-fg-muted">{a.candidateCode}</span></TD>
                    <TD>{a.automatic ? a.text : ACTIVITY_TYPES.find(([k]) => k === a.kind)?.[1] ?? a.kind}{a.subject && <span className="block text-xs text-fg-muted">{a.subject}</span>}</TD>
                    <TD>{a.outcomeLabel ?? '—'}</TD>
                    <TD className="max-w-80 truncate">{a.remarks ?? '—'}</TD>
                    <TD>{a.by ?? 'SampCrew'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </CrmShell>
  );
}
