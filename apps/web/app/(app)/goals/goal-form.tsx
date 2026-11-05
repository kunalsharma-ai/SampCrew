'use client';
import { Alert, Button, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveGoalAction } from '../talent/actions';
import type { Alignable, GoalDetail } from '../talent/types';

interface KrDraft { id?: string; title: string; startValue: string; targetValue: string; unit: string }

const yearRange = () => {
  const y = new Date().getFullYear();
  return { start: `${y}-01-01`, end: `${y}-12-31` };
};

/** Create or edit a goal with up to ten key results. */
export function GoalDialog({ open, onClose, goal, alignable, people }: {
  open: boolean;
  onClose: () => void;
  goal?: GoalDetail;
  alignable: Alignable[];
  /** People the caller manages; when present the dialog offers an owner choice for new goals. */
  people?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [krs, setKrs] = useState<KrDraft[]>(goal?.keyResults.map((k) => ({ id: k.id, title: k.title, startValue: k.startValue, targetValue: k.targetValue, unit: k.unit })) ?? []);
  const range = yearRange();
  const setKr = (i: number, patch: Partial<KrDraft>) => setKrs((all) => all.map((k, j) => (j === i ? { ...k, ...patch } : k)));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={goal ? 'Edit goal' : 'New goal'}
      description="Make it measurable: add key results with a starting value and a target. Progress is worked out from them."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="goal-form" loading={pending}>{goal ? 'Save goal' : 'Add goal'}</Button>
        </>
      }
    >
      <form
        id="goal-form"
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const owner = String(f.get('employeeId') ?? '');
          const parent = String(f.get('parentGoalId') ?? '');
          const body = {
            ...(owner ? { employeeId: owner } : {}),
            title: String(f.get('title') ?? ''),
            description: String(f.get('description') ?? ''),
            periodStart: String(f.get('periodStart') ?? ''),
            periodEnd: String(f.get('periodEnd') ?? ''),
            weight: Number(f.get('weight') || 0),
            parentGoalId: parent || null,
            keyResults: krs.map((k) => ({ ...(k.id ? { id: k.id } : {}), title: k.title, startValue: k.startValue || '0', targetValue: k.targetValue, unit: k.unit })),
          };
          setError(null);
          setFe({});
          start(async () => {
            const r = await saveGoalAction(goal?.id ?? null, body);
            if (r.ok) {
              onClose();
              if (!goal && r.data) router.push(`/goals/${(r.data as { id: string }).id}`);
              else router.refresh();
            } else {
              setError(r.message);
              setFe(r.fieldErrors ?? {});
            }
          });
        }}
      >
        {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
        {!goal && people && people.length > 0 && (
          <Field label="Whose goal" className="col-span-2">
            {(p) => (
              <Select {...p} name="employeeId" defaultValue="">
                <option value="">Mine</option>
                {people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}
          </Field>
        )}
        <Field label="Goal" required error={fe.title} className="col-span-2">{(p) => <Input {...p} name="title" required defaultValue={goal?.title} placeholder="Reduce handover defects on the night shift" />}</Field>
        <Field label="Why it matters" error={fe.description} className="col-span-2">{(p) => <Textarea {...p} name="description" rows={2} defaultValue={goal?.description} />}</Field>
        <Field label="From" required error={fe.periodStart} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} type="date" name="periodStart" required defaultValue={goal?.periodStart ?? range.start} />}</Field>
        <Field label="To" required error={fe.periodEnd} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} type="date" name="periodEnd" required defaultValue={goal?.periodEnd ?? range.end} />}</Field>
        <Field label="Weight (%)" hint="How much this goal counts towards overall progress. Leave 0 to count goals equally." error={fe.weight} className="col-span-2 sm:col-span-1">
          {(p) => <Input {...p} type="number" min={0} max={100} name="weight" defaultValue={goal?.weight ?? 0} />}
        </Field>
        <Field label="Supports" hint="Your manager's goal this one contributes to" className="col-span-2 sm:col-span-1">
          {(p) => (
            <Select {...p} name="parentGoalId" defaultValue={goal?.parentGoalId ?? ''}>
              <option value="">Nothing in particular</option>
              {alignable.filter((a) => a.id !== goal?.id).map((a) => <option key={a.id} value={a.id}>{a.title} ({a.employeeName})</option>)}
            </Select>
          )}
        </Field>

        <div className="col-span-2 grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium">Key results</span>
            <Button size="sm" variant="ghost" type="button" disabled={krs.length >= 10} onClick={() => setKrs([...krs, { title: '', startValue: '0', targetValue: '', unit: '' }])}>
              <Plus className="size-3.5" /> Add key result
            </Button>
          </div>
          {fe.keyResults && <p className="text-xs text-danger">{fe.keyResults}</p>}
          {krs.length === 0 && <p className="text-xs text-fg-muted">Without key results you report progress as a percentage at each check-in.</p>}
          {krs.map((k, i) => (
            <div key={k.id ?? i} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border p-2">
              <label className="col-span-12 grid gap-1 text-xs text-fg-muted sm:col-span-5">Measure
                <Input aria-label={`Key result ${i + 1}`} value={k.title} required onChange={(e) => setKr(i, { title: e.target.value })} placeholder="Defects per month" />
              </label>
              <label className="col-span-4 grid gap-1 text-xs text-fg-muted sm:col-span-2">Start
                <Input inputMode="decimal" value={k.startValue} onChange={(e) => setKr(i, { startValue: e.target.value })} />
              </label>
              <label className="col-span-4 grid gap-1 text-xs text-fg-muted sm:col-span-2">Target
                <Input inputMode="decimal" value={k.targetValue} required onChange={(e) => setKr(i, { targetValue: e.target.value })} />
              </label>
              <label className="col-span-3 grid gap-1 text-xs text-fg-muted sm:col-span-2">Unit
                <Input value={k.unit} maxLength={20} onChange={(e) => setKr(i, { unit: e.target.value })} placeholder="%" />
              </label>
              <Button className="col-span-1" size="sm" variant="ghost" type="button" aria-label="Remove key result" onClick={() => setKrs(krs.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
        </div>
      </form>
    </Dialog>
  );
}
