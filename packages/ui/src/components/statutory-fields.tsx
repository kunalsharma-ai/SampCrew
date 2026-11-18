'use client';
import type { ContributionRule, GenericStatutory, StatutorySettings as IndiaStatutory } from '@crew/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from './button';
import { Alert } from './surface';
import { Checkbox, Field, Input, Select, Textarea } from './form';

/**
 * Editors for statutory settings, shared by the Web Portal (a workspace's settings per legal entity) and the
 * Super Admin Console (the country packs workspaces start from). India's scheme and the rules-based scheme every
 * other country uses.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const num = (label: string, value: string, onChange: (v: string) => void, hint?: string) => (
  <Field label={label} hint={hint}>{(p) => <Input {...p} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />}</Field>
);
const optional = (label: string, value: string | null, onChange: (v: string | null) => void, hint?: string) =>
  num(label, value ?? '', (v) => onChange(v.trim() === '' ? null : v), hint);

export function SlabsEditor({ slabs, onChange, label }: { slabs: { upTo: string | null; ratePercent: string }[]; onChange: (s: { upTo: string | null; ratePercent: string }[]) => void; label: string }) {
  const set = (fn: (d: { upTo: string | null; ratePercent: string }[]) => void) => {
    const d = structuredClone(slabs);
    fn(d);
    onChange(d);
  };
  return (
    <div className="grid gap-2">
      {slabs.map((sl, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          {num(i === 0 ? label : '', sl.upTo ?? '', (v) => set((d) => { d[i]!.upTo = v === '' ? null : v; }), i === slabs.length - 1 ? 'Empty = no limit' : undefined)}
          {num(i === 0 ? 'Rate %' : '', sl.ratePercent, (v) => set((d) => { d[i]!.ratePercent = v; }))}
          <Button size="sm" variant="ghost" aria-label="Remove slab" disabled={slabs.length === 1} onClick={() => set((d) => { d.splice(i, 1); })}><Trash2 className="size-3.5" /></Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" className="w-fit" onClick={() => set((d) => { d.splice(d.length - 1, 0, { upTo: '0', ratePercent: '0' }); })}><Plus className="size-3.5" /> Add slab</Button>
    </div>
  );
}

const newRule = (n: number): ContributionRule => ({
  code: `C${n}`, name: 'New contribution', employeeRatePercent: '0', employerRatePercent: '0', base: 'gross', threshold: null, ceiling: null, eligibleFrom: null, appliesTo: 'everyone', reducesTaxablePay: false,
});

/** The rules-based scheme used outside India: contributions, income tax and regional taxes. */
export function GenericStatutoryFields({ s, setS }: { s: GenericStatutory; setS: (fn: (d: GenericStatutory) => void) => void }) {
  const [newRegion, setNewRegion] = useState('');
  const tax = s.incomeTax;
  return (
    <>
      {s.notes && <Alert tone="info" title="Not calculated by this scheme">{s.notes}</Alert>}
      <section className="grid gap-3">
        <h3 className="text-[0.8125rem] font-semibold">Tax year and rounding</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Tax year starts in">
            {(p) => <Select {...p} value={s.taxYearStartMonth} onChange={(e) => setS((d) => { d.taxYearStartMonth = Number(e.target.value); })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>}
          </Field>
          <Field label="Round contributions and tax to">
            {(p) => (
              <Select {...p} value={s.rounding} onChange={(e) => setS((d) => { d.rounding = e.target.value as GenericStatutory['rounding']; })}>
                <option value="cent">The cent (0.01)</option>
                <option value="whole">Whole units</option>
              </Select>
            )}
          </Field>
          <Field label="The salary’s “enrolled” switch means" hint="For contributions that apply to enrolled people only">
            {(p) => <Input {...p} value={s.enrolmentLabel} onChange={(e) => setS((d) => { d.enrolmentLabel = e.target.value; })} />}
          </Field>
        </div>
      </section>

      <section className="grid gap-3">
        <h3 className="text-[0.8125rem] font-semibold">Contributions</h3>
        <p className="text-xs text-fg-muted">Social security, pension, insurance and levies. Each is counted on the month’s base between the threshold and the ceiling. Codes appear on payslips as CODE_EE (employee) and CODE_ER (employer).</p>
        {s.contributions.length === 0 && <p className="text-[0.8125rem] text-fg-muted">No contributions yet.</p>}
        {s.contributions.map((r, i) => {
          const set = (fn: (x: ContributionRule) => void) => setS((d) => fn(d.contributions[i]!));
          return (
            <div key={i} className="grid gap-3 rounded-md border border-border p-3" data-testid="contribution-rule">
              <div className="grid gap-3 sm:grid-cols-[8rem_1fr_auto]">
                <Field label="Code">{(p) => <Input {...p} value={r.code} onChange={(e) => set((x) => { x.code = e.target.value.toUpperCase(); })} />}</Field>
                <Field label="Name">{(p) => <Input {...p} value={r.name} onChange={(e) => set((x) => { x.name = e.target.value; })} />}</Field>
                <Button size="sm" variant="ghost" className="self-end" aria-label={`Remove ${r.name}`} onClick={() => setS((d) => { d.contributions.splice(i, 1); })}><Trash2 className="size-3.5" /></Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-5">
                {num('Employee %', r.employeeRatePercent, (v) => set((x) => { x.employeeRatePercent = v; }))}
                {num('Employer %', r.employerRatePercent, (v) => set((x) => { x.employerRatePercent = v; }))}
                {optional('Threshold', r.threshold, (v) => set((x) => { x.threshold = v; }), 'Per month, not counted')}
                {optional('Ceiling', r.ceiling, (v) => set((x) => { x.ceiling = v; }), 'Per month, empty = none')}
                {optional('Only from', r.eligibleFrom, (v) => set((x) => { x.eligibleFrom = v; }), 'Nothing below this')}
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Counted on">
                  {(p) => (
                    <Select {...p} value={r.base} onChange={(e) => set((x) => { x.base = e.target.value as ContributionRule['base']; })}>
                      <option value="gross">Gross pay</option>
                      <option value="contribution_wages">Contribution wages (components marked as such)</option>
                    </Select>
                  )}
                </Field>
                <Field label="Applies to">
                  {(p) => (
                    <Select {...p} value={r.appliesTo} onChange={(e) => set((x) => { x.appliesTo = e.target.value as ContributionRule['appliesTo']; })}>
                      <option value="everyone">Everyone</option>
                      <option value="enrolled">Enrolled people only</option>
                    </Select>
                  )}
                </Field>
                <Checkbox className="self-end" label="Employee share reduces taxable pay" checked={r.reducesTaxablePay} onChange={(e) => set((x) => { x.reducesTaxablePay = e.target.checked; })} />
              </div>
            </div>
          );
        })}
        <Button size="sm" variant="secondary" className="w-fit" onClick={() => setS((d) => { d.contributions.push(newRule(d.contributions.length + 1)); })}><Plus className="size-3.5" /> Add contribution</Button>
      </section>

      <section className="grid gap-3">
        <h3 className="text-[0.8125rem] font-semibold">Income tax withheld by the employer</h3>
        <Checkbox
          label="The employer withholds income tax from pay"
          checked={tax !== null}
          onChange={(e) => setS((d) => { d.incomeTax = e.target.checked ? { name: 'Income tax', allowance: '0', slabs: [{ upTo: null, ratePercent: '0' }], levyPercent: '0', surchargePercent: '0', reviewAbove: null, reviewNote: '' } : null; })}
        />
        {tax && (
          <>
            <p className="text-xs text-fg-muted">Annual slabs on the projected taxable pay of the tax year, less the allowance. Each month withholds what is still due for the year over the months left.</p>
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Name on payslips">{(p) => <Input {...p} value={tax.name} onChange={(e) => setS((d) => { d.incomeTax!.name = e.target.value; })} />}</Field>
              {num('Allowance', tax.allowance, (v) => setS((d) => { d.incomeTax!.allowance = v; }), 'Per year, before the slabs')}
              {num('Levy on taxable pay %', tax.levyPercent, (v) => setS((d) => { d.incomeTax!.levyPercent = v; }))}
              {num('Surcharge on tax %', tax.surchargePercent, (v) => setS((d) => { d.incomeTax!.surchargePercent = v; }))}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
              {optional('Flag for review above', tax.reviewAbove, (v) => setS((d) => { d.incomeTax!.reviewAbove = v; }), 'Projected taxable pay per year')}
              <Field label="Review note">{(p) => <Input {...p} value={tax.reviewNote} onChange={(e) => setS((d) => { d.incomeTax!.reviewNote = e.target.value; })} />}</Field>
            </div>
            <SlabsEditor label="Taxable pay up to" slabs={tax.slabs} onChange={(slabs) => setS((d) => { d.incomeTax!.slabs = slabs; })} />
          </>
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="text-[0.8125rem] font-semibold">Regional taxes</h3>
        <p className="text-xs text-fg-muted">State, province or canton income tax on top of the national tax. Matched to the region written on the employee’s work location; a region without a table has no regional tax.</p>
        {Object.entries(s.regionalTaxes).map(([region, t]) => (
          <div key={region} className="grid gap-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between"><span className="text-[0.8125rem] font-medium">{region}</span><Button size="sm" variant="ghost" onClick={() => setS((d) => { delete d.regionalTaxes[region]; })}><Trash2 className="size-3.5" /> Remove region</Button></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name on payslips">{(p) => <Input {...p} value={t.name} onChange={(e) => setS((d) => { d.regionalTaxes[region]!.name = e.target.value; })} />}</Field>
              {num('Allowance', t.allowance, (v) => setS((d) => { d.regionalTaxes[region]!.allowance = v; }), 'Per year')}
            </div>
            <SlabsEditor label="Taxable pay up to" slabs={t.slabs} onChange={(slabs) => setS((d) => { d.regionalTaxes[region]!.slabs = slabs; })} />
          </div>
        ))}
        <div className="flex gap-2">
          <Input aria-label="New region" value={newRegion} onChange={(e) => setNewRegion(e.target.value)} placeholder="Region, e.g. California" className="w-64" />
          <Button size="sm" variant="secondary" disabled={newRegion.trim().length < 2 || newRegion.trim() in s.regionalTaxes} onClick={() => { const r = newRegion.trim(); setS((d) => { d.regionalTaxes[r] = { name: `${r} income tax`, allowance: '0', slabs: [{ upTo: null, ratePercent: '0' }] }; }); setNewRegion(''); }}>Add region</Button>
        </div>
      </section>

      <Field label="Notes for reviewers" hint="What this scheme does not calculate">{(p) => <Textarea {...p} rows={3} value={s.notes} onChange={(e) => setS((d) => { d.notes = e.target.value; })} />}</Field>
    </>
  );
}

/** India: Provident Fund, ESI, professional tax by state and TDS under the new regime. */
export function IndiaStatutoryFields({ s, up }: { s: IndiaStatutory; up: (fn: (d: IndiaStatutory) => void) => void }) {
  const [newState, setNewState] = useState('');
  return (
    <>
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
        <SlabsEditor label="Taxable income up to" slabs={s.tds.slabs} onChange={(slabs) => up((d) => { d.tds.slabs = slabs; })} />
      </section>
    </>
  );
}
