'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Department, LegalEntity } from '@/lib/types';
import { useRunner } from '../../../recruitment/use-runner';
import { cycleStepAction, deleteCycleAction } from '../../../talent/actions';
import { CYCLE_STATUS, CYCLE_TONE, PART_STATUS } from '../../../talent/labels';
import type { CycleDetail, Distribution } from '../../../talent/types';
import { CycleDialog } from '../cycles-view';

function Bars({ title, d }: { title: string; d: Distribution }) {
  const max = Math.max(1, ...d.levels.map((l) => l.count));
  return (
    <div className="grid gap-2">
      <div className="text-[13px] font-medium">{title}</div>
      {d.levels.map((l) => (
        <div key={l.value} className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-2 text-xs">
          <span className="truncate text-fg-muted">{l.value} · {l.label}</span>
          <div className="h-2 rounded-full bg-bg-subtle"><div className="h-full rounded-full bg-accent" style={{ width: `${(l.count / max) * 100}%` }} /></div>
          <span className="text-right tabular-nums">{l.count}</span>
        </div>
      ))}
      {d.unrated > 0 && <div className="text-xs text-fg-muted">{d.unrated} without a rating yet</div>}
    </div>
  );
}

export function CycleView({ cycle, entities, departments }: { cycle: CycleDetail; entities: LegalEntity[]; departments: Department[] }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [edit, setEdit] = useState(false);
  const included = cycle.reviews.filter((r) => !r.excluded);
  const managerDone = included.filter((r) => r.managerStatus === 'submitted').length;
  const selfDone = included.filter((r) => r.selfStatus === 'submitted').length;
  const label = (scale: number | null) => (scale == null ? '–' : String(scale));

  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2">Stage <Badge tone={CYCLE_TONE[cycle.status]} dot>{CYCLE_STATUS[cycle.status]}</Badge></span>}
          description={
            cycle.status === 'draft' ? 'Check who the cycle includes, then launch it.' :
            cycle.status === 'active' ? 'People and managers are writing. Start calibration once every manager review is in (or leave people out with a reason).' :
            cycle.status === 'calibration' ? 'Final ratings start as the manager’s. Open a review to change a rating with a reason, then release results.' :
            'Results are released and locked.'
          }
          action={
            <div className="flex flex-wrap gap-2">
              {cycle.status === 'draft' && (
                <>
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Delete this draft?') && run(() => deleteCycleAction(cycle.id), () => router.push('/reviews/cycles'))}>Delete</Button>
                  <Button size="sm" variant="secondary" onClick={() => setEdit(true)}>Edit</Button>
                  <Button size="sm" loading={pending} onClick={() => confirm(`Launch for ${cycle.preview?.length ?? 0} people? They and their managers will be notified.`) && run(() => cycleStepAction(cycle.id, 'launch'))}>Launch cycle</Button>
                </>
              )}
              {cycle.status === 'active' && <Button size="sm" loading={pending} onClick={() => confirm('Close writing and start calibration? Unanswered feedback requests are withdrawn.') && run(() => cycleStepAction(cycle.id, 'calibration'))}>Start calibration</Button>}
              {cycle.status === 'calibration' && <Button size="sm" loading={pending} onClick={() => confirm('Release results to everyone in this cycle? Reviews cannot change afterwards.') && run(() => cycleStepAction(cycle.id, 'release'))}>Release results</Button>}
            </div>
          }
        />
        {cycle.status !== 'draft' && (
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Stat label="People" value={included.length} hint={cycle.reviews.length > included.length ? `${cycle.reviews.length - included.length} left out` : undefined} />
            <Stat label="Self reviews" value={cycle.selfReview ? `${selfDone} of ${included.length}` : 'Not used'} />
            <Stat label="Manager reviews" value={`${managerDone} of ${included.length}`} />
          </CardBody>
        )}
      </Card>

      {cycle.status === 'draft' ? (
        <Card>
          <CardHeader title={`Would include ${cycle.preview?.length ?? 0} people`} description="Current employees in the chosen legal entity and department (with sub-departments) who joined by the end of the period." />
          <Table>
            <THead><tr><TH>Person</TH><TH>Reviewing manager</TH></tr></THead>
            <TBody>
              {cycle.preview?.map((p) => (
                <TR key={p.id}><TD>{p.name}</TD><TD className="text-fg-muted">{p.manager_name ?? 'None: HR writes the review'}</TD></TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : (
        <>
          {cycle.status !== 'active' && (
            <Card>
              <CardHeader title="Rating distribution" description="Compare manager ratings with final ratings after calibration." />
              <CardBody className="grid gap-6 md:grid-cols-2">
                <Bars title="Manager ratings" d={cycle.distribution.manager} />
                <Bars title="Final ratings" d={cycle.distribution.final} />
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Reviews" />
            <Table>
              <THead><tr><TH>Person</TH><TH>Reviewer</TH><TH>Self</TH><TH>Manager</TH><TH className="text-right">Manager rating</TH><TH className="text-right">Final</TH><TH className="text-right">Peers</TH><TH /></tr></THead>
              <TBody>
                {cycle.reviews.map((r) => (
                  <TR key={r.id} className={r.excluded ? 'opacity-60' : undefined}>
                    <TD>
                      <div className="font-medium">{r.employeeName}</div>
                      <div className="text-xs text-fg-muted">{r.departmentName}{r.excluded ? ` · left out: ${r.excludedReason}` : ''}</div>
                    </TD>
                    <TD className="text-fg-muted">{r.managerName ?? 'HR'}</TD>
                    <TD className="text-fg-muted">{PART_STATUS[r.selfStatus]}</TD>
                    <TD className="text-fg-muted">{PART_STATUS[r.managerStatus]}</TD>
                    <TD className="text-right tabular-nums">{label(r.managerRating)}</TD>
                    <TD className="text-right tabular-nums font-medium">{label(r.finalRating)}{r.calibrationChanges > 0 && <span className="ml-1 text-xs text-warning" title="Changed in calibration">●</span>}</TD>
                    <TD className="text-right tabular-nums">{cycle.peerFeedback ? `${r.peerSubmitted}/${r.peerRequested}` : '–'}</TD>
                    <TD className="text-right"><Link className="text-[13px] font-medium text-accent hover:underline" href={`/reviews/${r.id}`}>Open</Link></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        </>
      )}
      {cycle.status === 'draft' && <CycleDialog open={edit} onClose={() => setEdit(false)} entities={entities} departments={departments} cycle={cycle} />}
    </div>
  );
}
