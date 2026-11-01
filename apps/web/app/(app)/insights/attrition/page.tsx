import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { BAND, OUTCOME, RULE_TEXT } from '../labels';
import type { AttritionList, Band } from '../types';
import { RecalculateButton } from './recalculate';

export const metadata: Metadata = { title: 'Attrition risk' };

export default async function AttritionPage({ searchParams }: { searchParams: Promise<{ band?: string }> }) {
  const { band } = await searchParams;
  const b = band === 'high' || band === 'medium' || band === 'low' ? (band as Band) : undefined;
  const data = await load<AttritionList>(`/insights/attrition${b ? `?band=${b}` : ''}`);
  return (
    <>
      <PageHeader
        title="Attrition risk"
        description="A rule-based score per person showing signals that people sometimes show before they leave. It is a prompt for a conversation, not a prediction, and never changes a record. Only HR with this permission can see it; managers cannot, and every view is logged."
        actions={<RecalculateButton />}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid content-start gap-4">
          <div className="flex flex-wrap gap-3 text-[13px]">
            {(['', 'high', 'medium', 'low'] as const).map((k) => (
              <Link key={k} href={k ? `/insights/attrition?band=${k}` : '/insights/attrition'} className={(b ?? '') === k ? 'font-semibold text-accent' : 'text-fg-muted hover:text-fg'}>{k ? BAND[k].label : 'All'}</Link>
            ))}
            <span className="ml-auto text-fg-subtle">{data.computedOn ? `Calculated ${data.computedOn}` : 'Not calculated yet'}</span>
          </div>
          <Card>
            {data.people.length === 0 ? (
              <EmptyState title={data.computedOn ? 'No one in this band' : 'No scores yet'} description={data.computedOn ? undefined : 'Scores are calculated every day. Use Recalculate to calculate them now.'} />
            ) : (
              <Table>
                <THead><tr><TH>Employee</TH><TH>Department</TH><TH className="text-right">Score</TH><TH>Risk</TH><TH>Main signals</TH><TH>Review</TH></tr></THead>
                <TBody>
                  {data.people.map((p) => (
                    <TR key={p.employeeId}>
                      <TD><Link className="font-medium text-accent hover:underline" href={`/insights/attrition/${p.employeeId}`}>{p.name}</Link></TD>
                      <TD className="text-[13px]">{p.department ?? '–'}</TD>
                      <TD className="text-right tabular-nums">{p.score}</TD>
                      <TD><Badge tone={BAND[p.band].tone} dot>{BAND[p.band].label}</Badge></TD>
                      <TD className="max-w-[22rem] text-[13px]">{p.factors.length ? p.factors.slice(0, 3).map((f) => f.label).join('; ') : <span className="text-fg-subtle">None</span>}</TD>
                      <TD className="text-[13px]">{p.reviewOutcome ? OUTCOME[p.reviewOutcome] : <span className="text-fg-subtle">Not reviewed</span>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
        <Card>
          <CardHeader title="How scores work" description={`Rules ${data.rulesVersion}. Each signal adds the points shown; the total is capped at 100.`} />
          <CardBody className="grid gap-2 text-[13px]">
            {Object.entries(data.rules).map(([k, pts]) => (
              <div key={k} className="flex justify-between gap-3"><span>{RULE_TEXT[k] ?? k}</span><span className="tabular-nums font-medium">+{pts}</span></div>
            ))}
            <p className="mt-2 text-fg-muted">High is 50 or more, medium 25 to 49. Salary amounts, the reasons given for leave, protected characteristics and confidential helpdesk cases are never used.</p>
            <Alert tone="info">Use a score to start a supportive conversation. Do not use it on its own for any decision about someone&apos;s job, pay or performance.</Alert>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
