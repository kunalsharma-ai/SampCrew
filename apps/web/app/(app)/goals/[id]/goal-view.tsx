'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Textarea } from '@crew/ui';
import { History, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import { checkinAction, deleteGoalAction, goalStatusAction } from '../../talent/actions';
import { CONFIDENCE, CONFIDENCE_TONE, dateTime, GOAL_STATUS, GOAL_TONE, num } from '../../talent/labels';
import { Progress } from '../../talent/progress';
import type { Alignable, GoalDetail } from '../../talent/types';
import { GoalDialog } from '../goal-form';

export function GoalView({ goal, alignable }: { goal: GoalDetail; alignable: Alignable[] }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [edit, setEdit] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(goal.keyResults.map((k) => [k.id, num(k.currentValue)])));
  const [progress, setProgress] = useState(String(goal.progress));
  const [confidence, setConfidence] = useState(goal.confidence ?? 'on_track');
  const [note, setNote] = useState('');

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="grid content-start gap-6 lg:col-span-2">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <Card>
          <CardHeader
            title="Progress"
            description={goal.description || undefined}
            action={
              <div className="flex items-center gap-2">
                <Badge tone={GOAL_TONE[goal.status]}>{GOAL_STATUS[goal.status]}</Badge>
                {goal.confidence && <Badge tone={CONFIDENCE_TONE[goal.confidence]} dot>{CONFIDENCE[goal.confidence]}</Badge>}
                {goal.can.manage && <Button size="sm" variant="secondary" onClick={() => setEdit(true)}><Pencil className="size-3.5" /> Edit</Button>}
              </div>
            }
          />
          <CardBody className="grid gap-4">
            <Progress value={goal.progress} />
            {goal.keyResults.length > 0 && (
              <ul className="grid gap-3">
                {goal.keyResults.map((k) => (
                  <li key={k.id} className="grid gap-1">
                    <div className="flex justify-between gap-4 text-[13px]">
                      <span className="font-medium">{k.title}</span>
                      <span className="whitespace-nowrap text-fg-muted">{num(k.currentValue)} of {num(k.targetValue)}{k.unit ? ` ${k.unit}` : ''} (from {num(k.startValue)})</span>
                    </div>
                    <Progress value={k.progress} />
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-fg-muted">
              {goal.keyResults.length
                ? 'Each key result counts as the share of the way from its start to its target; the goal is their average.'
                : 'This goal has no key results, so its progress is the percentage reported at the last check-in.'}
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Check-ins" description="Every update is kept." />
          {goal.checkins.length ? (
            <ul className="divide-y divide-border">
              {goal.checkins.map((c) => (
                <li key={c.id} className="grid gap-1 px-5 py-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.byName}</span>
                    <span className="text-fg-muted">{dateTime(c.createdAt)}</span>
                    <Badge tone={CONFIDENCE_TONE[c.confidence]} dot>{CONFIDENCE[c.confidence]}</Badge>
                    <span className="ml-auto tabular-nums text-fg-muted">{c.progress}%</span>
                  </div>
                  {c.values.map((v) => <div key={v.keyResultId} className="text-xs text-fg-muted">{v.title}: {num(v.from)} → {num(v.to)}</div>)}
                  {c.note && <p className="text-fg">{c.note}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<History className="size-5" />} title="No check-ins yet" description="Record progress as it happens; the latest confidence shows on the goal." />
          )}
        </Card>
      </div>

      <div className="grid content-start gap-6">
        {goal.can.manage && (
          <Card>
            <CardHeader title="Check in" />
            <CardBody>
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  const body = goal.keyResults.length
                    ? { values: goal.keyResults.filter((k) => values[k.id] !== num(k.currentValue)).map((k) => ({ keyResultId: k.id, value: values[k.id] })), confidence, note }
                    : { progress: Number(progress), confidence, note };
                  run(() => checkinAction(goal.id, body), () => setNote(''));
                }}
              >
                {goal.keyResults.map((k) => (
                  <Field key={k.id} label={k.title} hint={`Target ${num(k.targetValue)}${k.unit ? ` ${k.unit}` : ''}`}>
                    {(p) => <Input {...p} inputMode="decimal" value={values[k.id] ?? ''} onChange={(e) => setValues({ ...values, [k.id]: e.target.value })} />}
                  </Field>
                ))}
                {!goal.keyResults.length && (
                  <Field label="Progress (%)">{(p) => <Input {...p} type="number" min={0} max={100} value={progress} onChange={(e) => setProgress(e.target.value)} />}</Field>
                )}
                <Field label="Confidence">
                  {(p) => (
                    <Select {...p} value={confidence} onChange={(e) => setConfidence(e.target.value as typeof confidence)}>
                      {Object.entries(CONFIDENCE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Note">{(p) => <Textarea {...p} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed, and what is in the way" />}</Field>
                <Button type="submit" loading={pending}>Save check-in</Button>
              </form>
            </CardBody>
          </Card>
        )}

        {(goal.parent || goal.children.length > 0) && (
          <Card>
            <CardHeader title="Alignment" />
            <CardBody className="grid gap-3 text-[13px]">
              {goal.parent && (
                <div>
                  <div className="text-xs text-fg-muted">Supports</div>
                  <div className="font-medium">{goal.parent.title}</div>
                  <div className="text-xs text-fg-muted">{goal.parent.employeeName}</div>
                </div>
              )}
              {goal.children.length > 0 && (
                <div className="grid gap-2">
                  <div className="text-xs text-fg-muted">Supported by</div>
                  {goal.children.map((c) => (
                    <div key={c.id}>
                      <Link className="font-medium text-accent hover:underline" href={`/goals/${c.id}`}>{c.title}</Link>
                      <div className="text-xs text-fg-muted">{c.employeeName} · {GOAL_STATUS[c.status]}</div>
                      <Progress value={c.progress} />
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        )}

        {(goal.can.manage || goal.can.reopen) && (
          <Card>
            <CardHeader title="Status" />
            <CardBody className="flex flex-wrap gap-2">
              {goal.can.manage && (
                <>
                  <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => goalStatusAction(goal.id, 'completed'))}>Mark completed</Button>
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => { const why = prompt('Why is this goal being cancelled?'); if (why !== null) run(() => goalStatusAction(goal.id, 'cancelled', why)); }}>Cancel goal</Button>
                  {goal.checkins.length === 0 && goal.children.length === 0 && (
                    <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Delete this goal? This cannot be undone.') && run(() => deleteGoalAction(goal.id), () => router.push('/goals'))}>Delete</Button>
                  )}
                </>
              )}
              {goal.can.reopen && <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => goalStatusAction(goal.id, 'active'))}>Reopen</Button>}
            </CardBody>
          </Card>
        )}
      </div>
      {goal.can.manage && <GoalDialog open={edit} onClose={() => setEdit(false)} goal={goal} alignable={alignable} />}
    </div>
  );
}
