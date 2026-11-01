'use client';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { LegalEntity } from '@/lib/types';
import { useRunner } from '../../recruitment/use-runner';
import { removeStatutoryAction, saveStatutoryAction } from '../../payroll/actions';
import type { StatutoryResponse, StatutorySettings } from '../../payroll/types';

const num = (label: string, value: string, onChange: (v: string) => void, hint?: string) => (
  <Field label={label} hint={hint}>{(p) => <Input {...p} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />}</Field>
);

/** Review and save statutory settings for one legal entity. Nothing applies until a person saves them. */
export function StatutoryEditor({ statutory, entities }: { statutory: StatutoryResponse; entities: LegalEntity[] }) {
  const { pending, notice, run } = useRunner();
  const [entityId, setEntityId] = useState(entities[0]?.id ?? '');
  const saved = statutory.settings.filter((s) => s.legalEntityId === entityId);
  const base = saved[0]?.settings ?? statutory.startingValues.settings;
  const [s, setS] = useState<StatutorySettings>(structuredClone(base));
  const [effectiveFrom, setEffectiveFrom] = useState(saved.length ? new Date().toISOString().slice(0, 10) : `${new Date().getFullYear() - (new Date().getMonth() < 3 ? 1 : 0)}-04-01`);
  const [lopSource, setLopSource] = useState(saved[0]?.lopSource ?? 'attendance_and_leave');
  const [newState, setNewState] = useState('');
  const pick = (id: string) => {
    setEntityId(id);
    const latest = statutory.settings.find((x) => x.legalEntityId === id);
    setS(structuredClone(latest?.settings ?? statutory.startingValues.settings));
    setLopSource(latest?.lopSource ?? 'attendance_and_leave');
  };
  const up = (fn: (d: StatutorySettings) => void) => setS((prev) => {
    const d = structuredClone(prev);
    fn(d);
    return d;
  });

  return (
    <Card>
      <CardHeader
        title="Statutory settings"
        description="Provident Fund, ESI, professional tax and income tax for each legal entity, effective from a date."
        action={entities.length > 1 && <Select value={entityId} onChange={(e) => pick(e.target.value)} className="w-56">{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>}
      />
      <CardBody className="grid gap-5">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {saved.length === 0 ? (
          <Alert tone="warning" title="Not saved yet">{statutory.startingValues.notice}</Alert>
        ) : (
          <Table>
            <THead><tr><TH>Effective from</TH><TH>Loss of pay from</TH><TH>Saved</TH><TH /></tr></THead>
            <TBody>
              {saved.map((x) => (
                <TR key={x.id}>
                  <TD className="font-medium">{x.effectiveFrom}</TD>
                  <TD>{x.lopSource === 'leave_only' ? 'Unpaid leave only' : 'Attendance and unpaid leave'}</TD>
                  <TD className="text-fg-muted">{new Date(x.savedAt).toLocaleDateString()}{x.savedBy ? ` by ${x.savedBy}` : ''}</TD>
                  <TD className="text-right">{x.usedByRun ? <span className="text-xs text-fg-subtle">Used by payroll</span> : <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Remove these settings?') && run(() => removeStatutoryAction(x.id))}>Remove</Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Effective from" required>{(p) => <Input {...p} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />}</Field>
          <Field label="Loss-of-pay days come from" hint="Use unpaid leave only if this entity does not record attendance in CREW">
            {(p) => (
              <Select {...p} value={lopSource} onChange={(e) => setLopSource(e.target.value)}>
                <option value="attendance_and_leave">Attendance (absences, half days) and unpaid leave</option>
                <option value="leave_only">Unpaid leave only</option>
              </Select>
            )}
          </Field>
        </div>

        <section className="grid gap-3">
          <h3 className="text-[0.8125rem] font-semibold">Provident Fund</h3>
          <div className="grid gap-3 sm:grid-cols-4">
            {num('Employee %', s.pf.employeeRatePercent, (v) => up((d) => { d.pf.employeeRatePercent = v; }))}
            {num('Employer %', s.pf.employerRatePercent, (v) => up((d) => { d.pf.employerRatePercent = v; }))}
            {num('Pension (EPS) %', s.pf.epsRatePercent, (v) => up((d) => { d.pf.epsRatePercent = v; }))}
            {num('Wage ceiling', s.pf.wageCeiling, (v) => up((d) => { d.pf.wageCeiling = v; }), 'Per month')}
          </div>
          <Checkbox label="Calculate PF on wages up to the ceiling only" checked={s.pf.restrictToCeiling} onChange={(e) => up((d) => { d.pf.restrictToCeiling = e.target.checked; })} />
        </section>

        <section className="grid gap-3">
          <h3 className="text-[0.8125rem] font-semibold">ESI</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            {num('Employee %', s.esi.employeeRatePercent, (v) => up((d) => { d.esi.employeeRatePercent = v; }))}
            {num('Employer %', s.esi.employerRatePercent, (v) => up((d) => { d.esi.employerRatePercent = v; }))}
            {num('Gross ceiling', s.esi.grossCeiling, (v) => up((d) => { d.esi.grossCeiling = v; }), 'Monthly gross at or below this')}
          </div>
        </section>

        <section className="grid gap-3">
          <h3 className="text-[0.8125rem] font-semibold">Professional tax</h3>
          <p className="text-xs text-fg-muted">Slabs on monthly gross for each state. The state is matched to the region written on the employee’s work location.</p>
          {Object.entries(s.pt.states).map(([state, slabs]) => (
            <div key={state} className="rounded-md border border-border p-3">
              <div className="mb-2 flex items-center justify-between"><span className="text-[0.8125rem] font-medium">{state}</span><Button size="sm" variant="ghost" onClick={() => up((d) => { delete d.pt.states[state]; })}><Trash2 className="size-3.5" /> Remove state</Button></div>
              <div className="grid gap-2">
                {slabs.map((sl, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                    {num(i === 0 ? 'Gross up to' : '', sl.upTo ?? '', (v) => up((d) => { d.pt.states[state]![i]!.upTo = v === '' ? null : v; }), i === slabs.length - 1 ? 'Empty = no limit' : undefined)}
                    {num(i === 0 ? 'Amount' : '', sl.amount, (v) => up((d) => { d.pt.states[state]![i]!.amount = v; }))}
                    {num(i === 0 ? 'February amount' : '', sl.februaryAmount ?? '', (v) => up((d) => { if (v) d.pt.states[state]![i]!.februaryAmount = v; else delete d.pt.states[state]![i]!.februaryAmount; }))}
                    <Button size="sm" variant="ghost" aria-label="Remove slab" disabled={slabs.length === 1} onClick={() => up((d) => { d.pt.states[state]!.splice(i, 1); })}><Trash2 className="size-3.5" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="secondary" className="w-fit" onClick={() => up((d) => { d.pt.states[state]!.splice(d.pt.states[state]!.length - 1, 0, { upTo: '0', amount: '0' }); })}><Plus className="size-3.5" /> Add slab</Button>
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Input value={newState} onChange={(e) => setNewState(e.target.value)} placeholder="State, e.g. Tamil Nadu" className="w-64" />
            <Button size="sm" variant="secondary" disabled={newState.trim().length < 2 || newState.trim() in s.pt.states} onClick={() => { up((d) => { d.pt.states[newState.trim()] = [{ upTo: null, amount: '0' }]; }); setNewState(''); }}>Add state</Button>
          </div>
        </section>

        <section className="grid gap-3">
          <h3 className="text-[0.8125rem] font-semibold">Income tax (TDS), new regime</h3>
          <div className="grid gap-3 sm:grid-cols-4">
            {num('Standard deduction', s.tds.standardDeduction, (v) => up((d) => { d.tds.standardDeduction = v; }), 'Per year')}
            {num('Full rebate up to', s.tds.rebateLimit, (v) => up((d) => { d.tds.rebateLimit = v; }), 'Taxable income per year')}
            {num('Cess %', s.tds.cessPercent, (v) => up((d) => { d.tds.cessPercent = v; }))}
            {num('Surcharge above', s.tds.surchargeThreshold, (v) => up((d) => { d.tds.surchargeThreshold = v; }), 'Not calculated; flagged for review')}
          </div>
          <div className="grid gap-2">
            {s.tds.slabs.map((sl, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                {num(i === 0 ? 'Taxable income up to' : '', sl.upTo ?? '', (v) => up((d) => { d.tds.slabs[i]!.upTo = v === '' ? null : v; }), i === s.tds.slabs.length - 1 ? 'Empty = no limit' : undefined)}
                {num(i === 0 ? 'Rate %' : '', sl.ratePercent, (v) => up((d) => { d.tds.slabs[i]!.ratePercent = v; }))}
                <Button size="sm" variant="ghost" aria-label="Remove slab" disabled={s.tds.slabs.length === 1} onClick={() => up((d) => { d.tds.slabs.splice(i, 1); })}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" className="w-fit" onClick={() => up((d) => { d.tds.slabs.splice(d.tds.slabs.length - 1, 0, { upTo: '0', ratePercent: '0' }); })}><Plus className="size-3.5" /> Add slab</Button>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button loading={pending} disabled={!entityId} onClick={() => run(() => saveStatutoryAction({ legalEntityId: entityId, effectiveFrom, lopSource, settings: s }))}>I have checked these values. Save.</Button>
          {saved.length === 0 && <span className="text-xs text-fg-muted">Starting values are filled in; CREW does not certify them as current law.</span>}
        </div>
      </CardBody>
    </Card>
  );
}
