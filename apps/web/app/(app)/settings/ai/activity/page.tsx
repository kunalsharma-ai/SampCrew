import { Badge, Card, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { FEATURE, STATUS } from '../../../ai/labels';
import type { AiInteractionRow } from '../../../ai/types';

export const metadata: Metadata = { title: 'AI activity' };

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default async function AiActivityPage({ searchParams }: { searchParams: Promise<{ feature?: string }> }) {
  const { feature } = await searchParams;
  const rows = await load<AiInteractionRow[]>(`/ai/interactions?limit=200${feature ? `&feature=${encodeURIComponent(feature)}` : ''}`);
  return (
    <>
      <PageHeader title="AI activity" description="Every AI call in this workspace: who asked, what was sent after personal identifiers were removed, the answer, its sources and the credits used. Opening a call is recorded in the audit trail." />
      <div className="mb-4 flex flex-wrap gap-2 text-[0.8125rem]">
        <Link className={!feature ? 'font-semibold text-accent' : 'text-fg-muted hover:text-fg'} href="/settings/ai/activity">All</Link>
        {Object.entries(FEATURE).map(([k, v]) => <Link key={k} className={feature === k ? 'font-semibold text-accent' : 'text-fg-muted hover:text-fg'} href={`/settings/ai/activity?feature=${k}`}>{v.name}</Link>)}
      </div>
      <Card>
        {rows.length === 0 ? <EmptyState title="No AI calls yet" /> : (
          <Table>
            <THead><tr><TH>When</TH><TH>Feature</TH><TH>Asked by</TH><TH>Result</TH><TH className="text-right">Sources</TH><TH className="text-right">Credits</TH><TH>Feedback</TH></tr></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap"><Link className="font-medium text-accent hover:underline" href={`/settings/ai/activity/${r.id}`}>{when(r.createdAt)}</Link></TD>
                  <TD>{FEATURE[r.feature]?.name ?? r.feature}</TD>
                  <TD>{r.byName ?? '–'}</TD>
                  <TD><Badge tone={STATUS[r.status]?.tone ?? 'neutral'}>{STATUS[r.status]?.label ?? r.status}</Badge>{r.purged && <Badge className="ml-1">Text removed</Badge>}</TD>
                  <TD className="text-right tabular-nums">{r.sourceCount}</TD>
                  <TD className="text-right tabular-nums">{r.credits}</TD>
                  <TD>{r.helpful === null ? '–' : r.helpful ? 'Helpful' : 'Not helpful'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
