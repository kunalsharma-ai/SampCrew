'use client';
import { FOLLOW_UP_PRIORITIES, FOLLOW_UP_TYPES } from '@crew/contracts';
import { Button, Card, Dialog, EmptyState, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { CalendarClock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRunner } from '../../use-runner';
import { updateFollowUpAction } from '../crm-actions';
import type { CrmContext, FollowUp } from '../crm-types';
import { FollowUpBadge, NoticeBar, PriorityBadge, localInput, toIso, when } from '../crm-ui';

const TILES: [string, string][] = [['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Upcoming'], ['completed', 'Completed'], ['missed', 'Missed']];

export function FollowUpBoard({ ctx, counts, rows, bucket, assigned, type, priority }: {
  ctx: CrmContext; counts: Record<string, number>; rows: FollowUp[]; bucket: string; assigned: string; type: string; priority: string;
}) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [closing, setClosing] = useState<{ f: FollowUp; status: string } | null>(null);
  const [outcome, setOutcome] = useState('');
  const [dueAt, setDueAt] = useState('');
  const url = (patch: Record<string, string>) => `/recruitment/crm/follow-ups?${new URLSearchParams(Object.entries({ bucket, assigned, type, priority, ...patch }).filter(([, v]) => v))}`;
  const start = (f: FollowUp, status: string) => { setClosing({ f, status }); setOutcome(''); setDueAt(localInput(new Date(Math.max(Date.now(), new Date(f.dueAt).getTime()) + 86400000))); };
  return (
    <div className="grid gap-4">
      <NoticeBar notice={notice} />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TILES.map(([k, label]) => (
          <Link key={k} href={url({ bucket: k })} aria-current={bucket === k ? 'page' : undefined} className={`rounded-xl ${bucket === k ? 'ring-2 ring-accent' : ''}`}>
            <Stat label={label} value={counts[k] ?? 0} hint={k === 'completed' ? `${counts.completedToday ?? 0} today` : undefined} />
          </Link>
        ))}
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <Select aria-label="Which follow-ups" className="sm:w-40" value={bucket} onChange={(e) => router.push(url({ bucket: e.target.value }))}>
            <option value="open">All open</option>{TILES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}<option value="all">Everything</option>
          </Select>
          <Select aria-label="Assigned to" className="sm:w-48" value={assigned} onChange={(e) => router.push(url({ assigned: e.target.value }))}>
            <option value="me">Assigned to me</option><option value="all">Everyone</option>
            {ctx.recruiters.map((r) => <option key={r.membershipId} value={r.membershipId}>{r.name}</option>)}
          </Select>
          <Select aria-label="Follow-up type" className="sm:w-48" value={type} onChange={(e) => router.push(url({ type: e.target.value }))}>
            <option value="">Any type</option>{FOLLOW_UP_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          <Select aria-label="Priority" className="sm:w-36" value={priority} onChange={(e) => router.push(url({ priority: e.target.value }))}>
            <option value="">Any priority</option>{FOLLOW_UP_PRIORITIES.map((p) => <option key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</option>)}
          </Select>
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<CalendarClock className="size-5" />} title="No follow-ups here" description="Schedule a follow-up from a candidate’s profile, or when logging a call." />
        ) : (
          <Table aria-label="Follow-ups">
            <THead><TR><TH>Candidate</TH><TH>Follow-up</TH><TH>Due</TH><TH>Priority</TH><TH>Status</TH><TH>Assigned to</TH><TH /></TR></THead>
            <TBody>
              {rows.map((f) => {
                const live = f.status === 'pending' || f.status === 'rescheduled';
                return (
                  <TR key={f.id}>
                    <TD>
                      <Link href={`/recruitment/crm/candidates/${f.candidateId}?tab=follow-ups`} className="font-medium text-accent hover:underline">{f.candidateName}</Link>
                      <span className="block text-xs text-fg-muted">{[f.candidateCode, f.candidatePhone, f.candidateStage].filter(Boolean).join(' · ')}</span>
                    </TD>
                    <TD>{f.typeLabel}{f.reason && <span className="block text-xs text-fg-muted">{f.reason}</span>}</TD>
                    <TD className={`whitespace-nowrap ${f.overdue ? 'text-danger' : ''}`}>{when(f.dueAt)}</TD>
                    <TD><PriorityBadge priority={f.priority} /></TD>
                    <TD><FollowUpBadge status={f.status} overdue={f.overdue} /></TD>
                    <TD>{f.assignedTo ?? 'Unassigned'}</TD>
                    <TD className="whitespace-nowrap text-right">
                      {live && <>
                        <Button size="sm" variant="secondary" onClick={() => start(f, 'completed')}>Complete</Button>{' '}
                        <Button size="sm" variant="ghost" onClick={() => start(f, 'rescheduled')}>Reschedule</Button>{' '}
                        <Button size="sm" variant="ghost" onClick={() => start(f, 'missed')}>Missed</Button>
                      </>}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
      <Dialog open={!!closing} onClose={() => setClosing(null)} title={closing?.status === 'completed' ? 'Complete follow-up' : closing?.status === 'rescheduled' ? 'Reschedule follow-up' : 'Mark as missed'}
        description={closing ? `${closing.f.typeLabel} with ${closing.f.candidateName}` : undefined}
        footer={<><Button variant="ghost" onClick={() => setClosing(null)}>Back</Button><Button loading={pending} onClick={() => closing && run(() => updateFollowUpAction(closing.f.candidateId, closing.f.id, {
          status: closing.status, outcome: outcome || null, ...(closing.status === 'rescheduled' ? { dueAt: toIso(dueAt) } : {}),
        }), () => setClosing(null))}>Save</Button></>}>
        <div className="grid gap-4">
          {closing?.status === 'rescheduled' && <Field label="New time" required>{(p) => <Input {...p} type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />}</Field>}
          <Field label="Outcome or note">{(p) => <Textarea {...p} rows={3} value={outcome} onChange={(e) => setOutcome(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </div>
  );
}
