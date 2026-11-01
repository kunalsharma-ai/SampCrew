'use client';
import { Alert, Badge, Card, Select, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import { Trophy } from 'lucide-react';
import Link from 'next/link';
import type { Application, Stage } from '@/lib/types';
import { moveAction } from '../../../actions';
import { OFFER_STATUS, SOURCE } from '../../../labels';
import { useRunner } from '../../../use-runner';

export interface ComparedApplication extends Application {
  locationText: string | null; anonymized: boolean; daysInProcess: number; daysInStage: number;
  criteria: Record<string, { average: string; ratings: number }>;
  recommendations: Partial<Record<'strong_yes' | 'yes' | 'no' | 'strong_no', number>>;
}
export interface Comparison { requisition: { id: string; code: string; title: string }; criteria: string[]; applications: ComparedApplication[] }

const REC: [keyof ComparedApplication['recommendations'], string, 'success' | 'info' | 'warning' | 'danger'][] = [
  ['strong_yes', 'Strong yes', 'success'], ['yes', 'Yes', 'info'], ['no', 'No', 'warning'], ['strong_no', 'Strong no', 'danger'],
];

/** Highest value in a row, so the leader stands out; none when nobody has a score or everyone ties. */
function leader(values: (number | null)[]) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  const max = Math.max(...nums);
  return nums.filter((v) => v === max).length === 1 ? max : null;
}

export function CompareView({ data, stages, canMove, path }: { data: Comparison; stages: Stage[]; canMove: boolean; path: string }) {
  const { pending, notice, run } = useRunner();
  const apps = data.applications;
  const scoreRow = (label: string, values: (number | null)[], render: (v: number | null, i: number) => React.ReactNode) => {
    const best = leader(values);
    return (
      <TR>
        <TH scope="row" className="text-left font-medium text-fg-muted">{label}</TH>
        {values.map((v, i) => <TD key={apps[i]!.id} className={cn('align-top', best !== null && v === best && 'bg-success/5')}>{render(v, i)}</TD>)}
      </TR>
    );
  };
  const bar = (v: number | null, ratings?: number) => v === null ? <span className="text-fg-subtle">Not rated</span> : (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded-full bg-bg-subtle" aria-hidden><div className="h-2 rounded-full bg-accent" style={{ width: `${(v / 4) * 100}%` }} /></div>
      <span className="tabular-nums">{v.toFixed(2)}</span>
      {ratings !== undefined && <span className="text-xs text-fg-subtle">({ratings})</span>}
    </div>
  );
  const avg = apps.map((a) => (a.averageScore ? Number(a.averageScore) : null));
  const bestAvg = leader(avg);
  return (
    <div className="space-y-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">Candidates compared for {data.requisition.title}</caption>
            <THead>
              <TR>
                <TH className="w-48"><span className="sr-only">Measure</span></TH>
                {apps.map((a, i) => (
                  <TH key={a.id} scope="col" className="min-w-56 text-left align-top">
                    <Link href={`/recruitment/candidates/${a.candidateId}`} className="text-sm font-semibold text-accent hover:underline">{a.candidateName}</Link>
                    {bestAvg !== null && avg[i] === bestAvg && <Badge tone="success" className="ml-2"><Trophy className="size-3" /> Top score</Badge>}
                    <span className="block text-xs font-normal text-fg-muted">{[a.currentTitle, a.currentCompany].filter(Boolean).join(' at ') || 'No current role given'}</span>
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              <TR>
                <TH scope="row" className="text-left font-medium text-fg-muted">Stage</TH>
                {apps.map((a) => (
                  <TD key={a.id}>
                    <span className="font-medium">{a.stageName}</span>
                    <span className="block text-xs text-fg-subtle">{a.daysInStage} {a.daysInStage === 1 ? 'day' : 'days'} in stage, {a.daysInProcess} in process</span>
                    {canMove && a.status === 'active' && (
                      <Select aria-label={`Move ${a.candidateName}`} className="mt-2 h-8 w-44 text-xs" value="" disabled={pending} onChange={(e) => e.target.value && run(() => moveAction(a.id, e.target.value, [path]))}>
                        <option value="">Move to…</option>
                        {stages.filter((s) => s.id !== a.stageId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    )}
                  </TD>
                ))}
              </TR>
              <TR>
                <TH scope="row" className="text-left font-medium text-fg-muted">Source</TH>
                {apps.map((a) => <TD key={a.id}>{SOURCE[a.source] ?? a.source}{a.locationText ? <span className="block text-xs text-fg-subtle">{a.locationText}</span> : null}</TD>)}
              </TR>
              {scoreRow('Average score', avg, (v, i) => <div>{bar(v)}<span className="text-xs text-fg-subtle">{apps[i]!.scorecards} {apps[i]!.scorecards === 1 ? 'scorecard' : 'scorecards'}</span></div>)}
              {data.criteria.map((c) => (
                <ScoreRowFor key={c} label={c} apps={apps} render={(a) => bar(a.criteria[c] ? Number(a.criteria[c]!.average) : null, a.criteria[c]?.ratings)} scoreRow={scoreRow} />
              ))}
              <TR>
                <TH scope="row" className="text-left font-medium text-fg-muted">Recommendations</TH>
                {apps.map((a) => (
                  <TD key={a.id}>
                    <div className="flex flex-wrap gap-1">
                      {REC.filter(([k]) => a.recommendations[k]).map(([k, label, tone]) => <Badge key={k} tone={tone}>{label} × {a.recommendations[k]}</Badge>)}
                      {!Object.keys(a.recommendations).length && <span className="text-fg-subtle">None yet</span>}
                    </div>
                  </TD>
                ))}
              </TR>
              <TR>
                <TH scope="row" className="text-left font-medium text-fg-muted">Interviews scheduled</TH>
                {apps.map((a) => <TD key={a.id} className="tabular-nums">{a.interviews}</TD>)}
              </TR>
              <TR>
                <TH scope="row" className="text-left font-medium text-fg-muted">Offer</TH>
                {apps.map((a) => <TD key={a.id}>{a.offerStatus ? <Badge tone={a.offerStatus === 'accepted' ? 'success' : 'warning'}>{OFFER_STATUS[a.offerStatus] ?? a.offerStatus}</Badge> : <span className="text-fg-subtle">No offer</span>}</TD>)}
              </TR>
            </TBody>
          </Table>
        </div>
      </Card>
      <p className="text-xs text-fg-subtle">Scores support a decision; they do not make it. Read each interviewer&apos;s notes on the candidate&apos;s profile before moving someone on or rejecting them.</p>
    </div>
  );
}

function ScoreRowFor({ label, apps, render, scoreRow }: { label: string; apps: ComparedApplication[]; render: (a: ComparedApplication) => React.ReactNode; scoreRow: (label: string, values: (number | null)[], render: (v: number | null, i: number) => React.ReactNode) => React.ReactNode }) {
  const values = apps.map((a) => (a.criteria[label] ? Number(a.criteria[label]!.average) : null));
  return <>{scoreRow(label, values, (_, i) => render(apps[i]!))}</>;
}
