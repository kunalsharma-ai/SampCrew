import { Badge, Card, CardBody, CardHeader, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { BAND, INPUT_TEXT, OUTCOME } from '../../labels';
import type { AttritionPerson } from '../../types';
import { ReviewForm } from './review-form';

export const metadata: Metadata = { title: 'Attrition risk' };

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export default async function AttritionPersonPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const { employeeId } = await params;
  const p = await load<AttritionPerson>(`/insights/attrition/${employeeId}`);
  const latest = p.history[0];
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/insights/attrition" className="hover:underline">Attrition risk</Link>}
        title={<span className="inline-flex flex-wrap items-center gap-3">{p.name}{latest && <Badge tone={BAND[latest.band].tone} dot>{BAND[latest.band].label} risk, {latest.score}</Badge>}</span>}
        description={latest ? `Calculated ${latest.computedOn} with rules ${latest.rulesVersion}. Advisory only.` : 'No score yet.'}
        actions={<Link className="text-[0.8125rem] text-accent hover:underline" href={`/employees/${employeeId}`}>Employee record</Link>}
      />
      {latest && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Why this score" description="Each signal, its points and the evidence behind it." />
            <CardBody className="grid gap-3 text-[0.8125rem]">
              {latest.factors.length === 0 && <p className="text-fg-muted">No signals. A score of 0 means none of the rules applied.</p>}
              {latest.factors.map((f) => (
                <div key={f.key} className="flex gap-3">
                  <span className="w-10 shrink-0 text-right font-medium tabular-nums">+{f.points}</span>
                  <div><div className="font-medium">{f.label}</div><div className="text-fg-muted">{f.evidence}</div></div>
                </div>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Inputs used" description="Taken from SampCrew records on the day of calculation." />
            <CardBody className="grid gap-1 text-[0.8125rem]">
              {Object.entries(latest.inputs).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3"><span className="text-fg-muted">{INPUT_TEXT[k] ?? k}</span><span className="tabular-nums">{v === null ? 'None' : v}</span></div>
              ))}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Record a review" description="Say what you did with this score. Marking it not accurate helps improve the rules." />
            <CardBody><ReviewForm employeeId={employeeId} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Reviews" />
            <CardBody className="grid gap-3 text-[0.8125rem]">
              {p.reviews.length === 0 && <p className="text-fg-muted">Not reviewed yet.</p>}
              {p.reviews.map((r) => (
                <div key={r.id}>
                  <div><span className="font-medium">{OUTCOME[r.outcome]}</span> <span className="text-fg-muted">by {r.byName}, {when(r.createdAt)} (score {r.score} on {r.scoreOn})</span></div>
                  {r.note && <p className="mt-0.5 whitespace-pre-wrap">{r.note}</p>}
                </div>
              ))}
            </CardBody>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader title="History" />
            <Table>
              <THead><tr><TH>Date</TH><TH className="text-right">Score</TH><TH>Risk</TH><TH>Signals</TH></tr></THead>
              <TBody>
                {p.history.map((h) => (
                  <TR key={h.id}>
                    <TD className="tabular-nums">{h.computedOn}</TD>
                    <TD className="text-right tabular-nums">{h.score}</TD>
                    <TD><Badge tone={BAND[h.band].tone}>{BAND[h.band].label}</Badge></TD>
                    <TD className="text-[0.8125rem]">{h.factors.map((f) => f.label).join('; ') || '–'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}
