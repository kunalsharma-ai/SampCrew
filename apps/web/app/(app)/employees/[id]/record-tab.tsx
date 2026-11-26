'use client';
import { WORK_STATUSES, WORK_STATUS_LABEL, type EmployeeRecord, type RecordItem } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, Select, Textarea, cn } from '@crew/ui';
import { CheckCircle2, Circle, Pencil, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveEmployeeRecordAction } from '../actions';

const GROUPS: { key: RecordItem['group']; title: string }[] = [
  { key: 'identity', title: 'Identity and address' },
  { key: 'job', title: 'Job' },
  { key: 'pay', title: 'Pay' },
  { key: 'contact', title: 'Contact' },
  { key: 'family', title: 'Family' },
  { key: 'bank', title: 'Bank' },
  { key: 'emergency', title: 'Emergency contact' },
  { key: 'documents', title: 'Documents' },
];

/** Where an item with no page of its own is filled in: the record form on this tab. */
const OWN_FIELDS = new Set(['work_status', 'gate_pass_id', 'ctc_annual', 'ctc_annual_in_hand', 'ctc_monthly_fixed', 'father_name', 'mother_name', 'parent_aadhaar', 'parents_address', 'any_details']);

function Meter({ score, done, total }: { score: number; done: number; total: number }) {
  const tone = score >= 90 ? 'bg-success' : score >= 60 ? 'bg-accent' : 'bg-warning';
  return (
    <div className="flex items-center gap-4" data-testid="record-score">
      <div className="relative grid size-20 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(var(--crew-accent, #6366f1) ${score * 3.6}deg, rgb(127 127 127 / 0.18) 0deg)` }}>
        <span className="grid size-16 place-items-center rounded-full bg-surface text-lg font-semibold" data-testid="record-score-value">{score}%</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[0.9375rem] font-semibold">Record completion</div>
        <p className="text-[0.8125rem] text-fg-muted">{done} of {total} required items filled. {total - done > 0 ? `${total - done} still pending.` : 'Everything is in.'}</p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label="Record completion">
          <div className={cn('h-full rounded-full transition-all', tone)} style={{ width: `${score}%` }} />
        </div>
      </div>
    </div>
  );
}

export function RecordTab({ record }: { record: EmployeeRecord }) {
  const router = useRouter();
  const [edit, setEdit] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<'all' | 'pending'>('all');
  const v = record.values;
  const items = record.items.filter((i) => filter === 'all' || (!i.done && !i.optional));

  const save = (form: FormData) => start(async () => {
    const body: Record<string, unknown> = {};
    for (const k of ['fatherName', 'motherName', 'parentsAddress', 'gatePassId', 'workStatus', 'anyDetails']) body[k] = String(form.get(k) ?? '').trim() || null;
    const aadhaar = String(form.get('parentAadhaar') ?? '').trim();
    if (aadhaar) body.parentAadhaar = aadhaar;
    if (record.can.seePay) for (const k of ['ctcAnnual', 'ctcAnnualInHand', 'ctcMonthlyFixed']) body[k] = String(form.get(k) ?? '').trim() || null;
    const r = await saveEmployeeRecordAction(record.employeeId, body);
    if (!r.ok) { setError(r.message); setFe(r.fieldErrors ?? {}); return; }
    setError(null); setFe({}); setEdit(false); router.refresh();
  });

  return (
    <div className="space-y-6" data-testid="employee-record">
      <Card>
        <CardBody className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1"><Meter score={record.score} done={record.done} total={record.total} /></div>
          <div className="flex flex-wrap gap-2">
            <div className="inline-flex rounded-lg border border-border p-0.5 text-[0.8125rem]" role="radiogroup" aria-label="Show">
              {(['all', 'pending'] as const).map((f) => (
                <button key={f} type="button" role="radio" aria-checked={filter === f} onClick={() => setFilter(f)} data-testid={`record-filter-${f}`}
                  className={cn('rounded-md px-2.5 py-1', filter === f ? 'bg-accent text-white' : 'text-fg-muted hover:text-fg')}>{f === 'all' ? 'Everything' : 'Pending only'}</button>
              ))}
            </div>
            {record.can.edit && <Button size="sm" variant="secondary" onClick={() => setEdit((x) => !x)} data-testid="record-edit"><Pencil className="size-3.5" /> {edit ? 'Close' : 'Edit record details'}</Button>}
            {record.can.uploadDocuments && <Link href={`/employees/${record.employeeId}?tab=documents`} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[0.8125rem] font-medium hover:bg-bg-subtle"><Upload className="size-3.5" /> Upload documents</Link>}
          </div>
        </CardBody>
      </Card>

      {edit && (
        <Card>
          <CardHeader title="Record details" description="The details kept only with the record. Everything else is filled in where it lives (use the links in the list)." />
          <CardBody>
            <form action={save} className="grid gap-4 sm:grid-cols-2" data-testid="record-form">
              {error && <Alert tone="danger" className="sm:col-span-2">{error}{Object.keys(fe).length > 0 && <ul className="mt-1 list-disc pl-4 text-xs">{Object.entries(fe).map(([k, m]) => <li key={k}>{k}: {m}</li>)}</ul>}</Alert>}
              <Field label="Work status">{(p) => (
                <Select {...p} name="workStatus" defaultValue={v.workStatus ?? ''}>
                  <option value="">Not recorded</option>
                  {WORK_STATUSES.map((s) => <option key={s} value={s}>{WORK_STATUS_LABEL[s]}</option>)}
                </Select>
              )}</Field>
              <Field label="Gate pass ID">{(p) => <Input {...p} name="gatePassId" defaultValue={v.gatePassId ?? ''} />}</Field>
              <Field label="Father name">{(p) => <Input {...p} name="fatherName" defaultValue={v.fatherName ?? ''} />}</Field>
              <Field label="Mother name">{(p) => <Input {...p} name="motherName" defaultValue={v.motherName ?? ''} />}</Field>
              <Field label="Father / mother Aadhaar number" hint={v.parentAadhaarMasked ? `Saved as ${v.parentAadhaarMasked}. Leave empty to keep it.` : 'Stored encrypted; only the last 4 digits are shown.'} error={fe.parentAadhaar}>
                {(p) => <Input {...p} name="parentAadhaar" inputMode="numeric" autoComplete="off" placeholder="XXXX XXXX XXXX" />}
              </Field>
              <Field label="Father / mother address">{(p) => <Input {...p} name="parentsAddress" defaultValue={v.parentsAddress ?? ''} />}</Field>
              {record.can.seePay && (
                <>
                  <Field label="CTC (annual)" error={fe.ctcAnnual}>{(p) => <Input {...p} name="ctcAnnual" inputMode="decimal" defaultValue={v.ctcAnnual ?? ''} />}</Field>
                  <Field label="CTC annual in hand" error={fe.ctcAnnualInHand}>{(p) => <Input {...p} name="ctcAnnualInHand" inputMode="decimal" defaultValue={v.ctcAnnualInHand ?? ''} />}</Field>
                  <Field label="Monthly CTC (fixed)" error={fe.ctcMonthlyFixed}>{(p) => <Input {...p} name="ctcMonthlyFixed" inputMode="decimal" defaultValue={v.ctcMonthlyFixed ?? ''} />}</Field>
                </>
              )}
              <div className="sm:col-span-2"><Field label="Any details">{(p) => <Textarea {...p} name="anyDetails" rows={3} defaultValue={v.anyDetails ?? ''} />}</Field></div>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="button" variant="secondary" onClick={() => setEdit(false)}>Cancel</Button>
                <Button type="submit" loading={pending} data-testid="record-save">Save record</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {GROUPS.map((g) => {
          const list = items.filter((i) => i.group === g.key);
          if (!list.length) return null;
          const all = record.items.filter((i) => i.group === g.key && (!i.optional || i.done));
          return (
            <Card key={g.key} data-testid={`record-group-${g.key}`}>
              <CardHeader title={g.title} action={<span className="text-xs text-fg-subtle">{all.filter((i) => i.done).length} of {all.length}</span>} />
              <CardBody className="pt-0">
                <ul className="divide-y divide-border">
                  {list.map((i) => {
                    const href = i.href;
                    return (
                      <li key={i.key} className="flex items-center gap-2.5 py-2 text-[0.8125rem]" data-testid="record-item" data-done={i.done ? 'true' : 'false'} data-key={i.key}>
                        {i.done ? <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Done" /> : <Circle className={cn('size-4 shrink-0', i.optional ? 'text-fg-subtle' : 'text-warning')} aria-label={i.optional ? 'Optional' : 'Pending'} />}
                        <span className="min-w-0 flex-1">
                          <span className="block text-fg">{i.label}{i.optional && !i.done && <span className="ml-1 text-xs text-fg-subtle">(optional)</span>}</span>
                          {i.value && <span className="block truncate text-xs text-fg-muted">{i.value}</span>}
                        </span>
                        {!i.done && href && <Link href={href} className="shrink-0 text-xs font-medium text-accent hover:underline">Fill in</Link>}
                        {!i.done && !href && record.can.edit && OWN_FIELDS.has(i.key) && <button type="button" onClick={() => setEdit(true)} className="shrink-0 text-xs font-medium text-accent hover:underline">Fill in</button>}
                      </li>
                    );
                  })}
                </ul>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
