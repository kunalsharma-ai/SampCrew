'use client';
import Link from 'next/link';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Wallet } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRunner } from '../../../recruitment/use-runner';
import { assignSalaryAction, previewSalaryAction, removeSalaryAction } from '../../actions';
import { amount, times } from '../../labels';
import type { SalaryRevision, SalaryStatutoryProfile, Structure } from '../../types';

type Preview = { currency: string; components: { code: string; name: string; kind: string; monthly: string; annual: string }[]; employerPfMonthly: string; employerInCtc?: boolean; warnings: string[] };

const INDIA: SalaryStatutoryProfile = { countryCode: 'IN', currency: 'INR', saved: true, pf: 'Provident Fund', esi: 'ESI when eligible', pt: 'Professional tax', tds: 'Income tax (TDS), new regime', employerInCtc: true };

export function SalaryView({ employeeId, revisions, structures, canEdit, statutory }: { employeeId: string; revisions: SalaryRevision[]; structures: Structure[]; canEdit: boolean; statutory?: SalaryStatutoryProfile | null }) {
  // What the four statutory switches mean in the employee's country (India: PF, ESI, professional tax, TDS).
  const sw = statutory ?? INDIA;
  const india = sw.countryCode === 'IN';
  const employerLabel = sw.employerInCtc ? 'Employer PF (part of CTC, not paid out)' : 'Employer contributions (estimate, on top of salary)';
  const switchSummary = (r: SalaryRevision) =>
    india
      ? `PF ${r.pfEnabled ? 'on' : 'off'} · ESI ${r.esiEnabled ? 'when eligible' : 'off'} · Professional tax ${r.ptEnabled ? 'on' : 'off'} · TDS ${r.tdsEnabled ? 'on' : 'off'}`
      : [sw.pf && `${sw.pf}: ${r.pfEnabled ? 'yes' : 'no'}`, sw.pt && `${sw.pt} ${r.ptEnabled ? 'on' : 'off'}`, sw.tds && `${sw.tds} ${r.tdsEnabled ? 'on' : 'off'}`].filter(Boolean).join(' · ');
  const { pending, notice, run } = useRunner();
  const [previewing, startPreview] = useTransition();
  const current = revisions[0];
  const [form, setForm] = useState({
    effectiveFrom: new Date().toISOString().slice(0, 10), annualCtc: current?.annualCtc.replace(/\.00$/, '') ?? '', structureId: current?.structureId ?? structures[0]?.id ?? '',
    pfEnabled: current?.pfEnabled ?? true, esiEnabled: current?.esiEnabled ?? true, ptEnabled: current?.ptEnabled ?? true, tdsEnabled: current?.tdsEnabled ?? true, note: '',
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string | boolean) => {
    setForm((f) => ({ ...f, [k]: v }));
    setPreview(null);
  };
  const doPreview = () =>
    startPreview(async () => {
      const r = await previewSalaryAction(employeeId, form);
      if (r.ok) {
        setPreview(r.data as Preview);
        setError(null);
      } else setError(r.message);
    });

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="grid content-start gap-6 lg:col-span-2">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {revisions.length ? revisions.map((r, i) => (
          <Card key={r.id}>
            <CardHeader
              title={<span className="flex items-center gap-2">{amount(r.annualCtc, r.currency)} a year {i === 0 && <Badge tone="success">Latest</Badge>}</span>}
              description={`From ${r.effectiveFrom} · ${r.structureName}${r.createdBy ? ` · saved by ${r.createdBy}` : ''}`}
              action={canEdit && !r.usedByPayroll && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Remove this revision? Only possible because payroll has not used it.') && run(() => removeSalaryAction(employeeId, r.id))}>Remove</Button>}
            />
            <Table>
              <THead><tr><TH>Component</TH><TH className="text-right">Monthly</TH><TH className="text-right">Yearly</TH></tr></THead>
              <TBody>
                {r.lines.map((l) => (
                  <TR key={l.code}><TD>{l.name}{l.kind === 'deduction' && <span className="ml-1 text-xs text-fg-muted">(deduction)</span>}</TD><TD className="text-right tabular-nums">{amount(l.monthly, r.currency)}</TD><TD className="text-right tabular-nums text-fg-muted">{amount(times(l.monthly, 12), r.currency)}</TD></TR>
                ))}
                <TR><TD className="text-fg-muted">{employerLabel}</TD><TD className="text-right tabular-nums">{amount(r.employerPfMonthly, r.currency)}</TD><TD /></TR>
              </TBody>
            </Table>
            <CardBody className="text-xs text-fg-muted">
              {switchSummary(r)}{r.note ? ` · ${r.note}` : ''}
            </CardBody>
          </Card>
        )) : (
          <Card><EmptyState icon={<Wallet className="size-5" />} title="No salary yet" description="Assign one to include this person in payroll." /></Card>
        )}
      </div>

      {canEdit && (
        <Card className="h-fit">
          <CardHeader title={current ? 'New revision' : 'Assign a salary'} description="Preview the split before saving." />
          <CardBody className="grid gap-4">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Effective from" required>{(p) => <Input {...p} type="date" value={form.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} />}</Field>
            <Field label={india ? 'Annual CTC' : 'Annual salary'} required hint={india ? 'Cost to company per year, including employer PF' : `Gross pay per year in ${sw.currency}; employer contributions are paid on top`}>{(p) => <Input {...p} inputMode="decimal" value={form.annualCtc} onChange={(e) => set('annualCtc', e.target.value)} placeholder="600000" />}</Field>
            <Field label="Salary structure" required>
              {(p) => <Select {...p} value={form.structureId} onChange={(e) => set('structureId', e.target.value)}>{structures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
            </Field>
            <div className="grid gap-2">
              {sw.pf && <Checkbox label={sw.pf} checked={form.pfEnabled} onChange={(e) => set('pfEnabled', e.target.checked)} />}
              {sw.esi && <Checkbox label={sw.esi} description="Applies only while the monthly gross is under the ESI ceiling" checked={form.esiEnabled} onChange={(e) => set('esiEnabled', e.target.checked)} />}
              {sw.pt && <Checkbox label={sw.pt} checked={form.ptEnabled} onChange={(e) => set('ptEnabled', e.target.checked)} />}
              {sw.tds && <Checkbox label={sw.tds} checked={form.tdsEnabled} onChange={(e) => set('tdsEnabled', e.target.checked)} />}
              {!india && <p className="text-xs text-fg-muted">Contributions that apply to everyone in {sw.countryCode} are always calculated.{sw.saved ? '' : ' Statutory settings for this entity are not saved yet.'}</p>}
            </div>
            <Field label="Note">{(p) => <Input {...p} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="Annual increment" />}</Field>
            {preview && (
              <div className="rounded-md border border-border p-3 text-[0.8125rem]">
                <div className="mb-2 font-medium">Monthly split</div>
                <ul className="grid gap-1">
                  {preview.components.map((c) => <li key={c.code} className="flex justify-between"><span>{c.name}</span><span className="tabular-nums">{amount(c.monthly, preview.currency)}</span></li>)}
                  <li className="flex justify-between text-fg-muted"><span>{preview.employerInCtc === false ? 'Employer contributions (estimate)' : 'Employer PF'}</span><span className="tabular-nums">{amount(preview.employerPfMonthly, preview.currency)}</span></li>
                </ul>
                {preview.warnings.map((w, i) => <p key={i} className="mt-2 text-xs text-warning">{w}{/statutory settings/i.test(w) && <> <Link className="font-medium underline" href="/settings/payroll">Open statutory settings</Link></>}</p>)}
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" loading={previewing} disabled={!form.annualCtc || !form.structureId} onClick={doPreview}>Preview</Button>
              <Button size="sm" loading={pending} disabled={!preview} onClick={() => run(() => assignSalaryAction(employeeId, form), () => setPreview(null))}>Save salary</Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
