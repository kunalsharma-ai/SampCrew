'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { customStatutory, type ContributionRule } from '@crew/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { LegalEntity } from '@/lib/types';
import { useRunner } from '../../recruitment/use-runner';
import { removeStatutoryAction, saveStatutoryAction } from '../../payroll/actions';
import type { GenericStatutory, IndiaStatutory, StatutoryResponse, StatutorySettings } from '../../payroll/types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const isGeneric = (s: StatutorySettings): s is GenericStatutory => (s as { kind?: string }).kind === 'generic';
const schemeCountry = (s: StatutorySettings) => (isGeneric(s) ? s.countryCode : 'IN');
const taxYearMonth = (s: StatutorySettings) => (isGeneric(s) ? s.taxYearStartMonth : 4);
const countryName = (code: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};
/** The first day of the current tax year for a tax year starting in `month`. */
const taxYearStartDate = (month: number) => {
  const now = new Date();
  const y = now.getMonth() + 1 >= month ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String(month).padStart(2, '0')}-01`;
};

const num = (label: string, value: string, onChange: (v: string) => void, hint?: string) => (
  <Field label={label} hint={hint}>{(p) => <Input {...p} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />}</Field>
);
const optional = (label: string, value: string | null, onChange: (v: string | null) => void, hint?: string) =>
  num(label, value ?? '', (v) => onChange(v.trim() === '' ? null : v), hint);

/** Review and save statutory settings for one legal entity, in its country's scheme. Nothing applies until a person saves them. */
export function StatutoryEditor({ statutory, entities }: { statutory: StatutoryResponse; entities: LegalEntity[] }) {
  const { pending, notice, run } = useRunner();
  const [entityId, setEntityId] = useState(entities[0]?.id ?? '');
  const startOf = (id: string) => statutory.entities?.find((e) => e.legalEntityId === id);
  /** The newest saved settings if they are for the entity's current country, else its starting values. */
  const initial = (id: string): StatutorySettings => {
    const start = startOf(id);
    const country = start?.countryCode ?? entities.find((e) => e.id === id)?.countryCode ?? 'IN';
    const latest = statutory.settings.find((x) => x.legalEntityId === id);
    if (latest && schemeCountry(latest.settings) === country) return structuredClone(latest.settings);
    return structuredClone(start?.settings ?? statutory.startingValues.settings);
  };
  const saved = statutory.settings.filter((s) => s.legalEntityId === entityId);
  const start = startOf(entityId);
  const entity = entities.find((e) => e.id === entityId);
  const [s, setS] = useState<StatutorySettings>(() => initial(entityId));
  const [effectiveFrom, setEffectiveFrom] = useState(() => (saved.length ? new Date().toISOString().slice(0, 10) : taxYearStartDate(taxYearMonth(initial(entityId)))));
  const [lopSource, setLopSource] = useState(saved[0]?.lopSource ?? 'attendance_and_leave');
  const pick = (id: string) => {
    setEntityId(id);
    const next = initial(id);
    setS(next);
    const latest = statutory.settings.find((x) => x.legalEntityId === id);
    setLopSource(latest?.lopSource ?? 'attendance_and_leave');
    setEffectiveFrom(latest ? new Date().toISOString().slice(0, 10) : taxYearStartDate(taxYearMonth(next)));
  };
  const country = start?.countryCode ?? entity?.countryCode ?? 'IN';
  const savedForOtherCountry = saved.length > 0 && schemeCountry(saved[0]!.settings) !== country;

  return (
    <Card>
      <CardHeader
        title="Statutory settings"
        description="Social security, pension and income tax for each legal entity, in the rules of its country, effective from a date."
        action={entities.length > 1 && <Select aria-label="Legal entity" value={entityId} onChange={(e) => pick(e.target.value)} className="w-56">{entities.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.countryCode})</option>)}</Select>}
      />
      <CardBody className="grid gap-5">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {entities.length === 0 ? (
          <Alert tone="warning" title="Add a legal entity first">Statutory settings belong to a legal entity (the company that employs people). Add one under <a className="font-medium underline" href="/organization">Organization</a>, then come back here.</Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]" data-testid="statutory-country">
              <Badge tone="accent">{countryName(country)} ({country})</Badge>
              {entity && <Badge>{entity.currency}</Badge>}
              {start?.pack ? <span className="text-fg-muted">Country pack: {start.pack.basis}. {start.pack.summary}</span> : !isGeneric(s) ? null : <span className="text-fg-muted">Custom scheme: no ready-made pack for this country.</span>}
            </div>

            {saved.length === 0 ? (
              <Alert tone="warning" title="Not saved yet">{start?.notice ?? statutory.startingValues.notice}</Alert>
            ) : (
              <>
                {savedForOtherCountry && <Alert tone="danger" title="The legal entity has changed country">The saved settings are for {schemeCountry(saved[0]!.settings)}, but this entity is now in {country}. Payroll will not run until settings for {country} are saved. The form below starts from the {country} starting values.</Alert>}
                <Alert tone="info">Rates and thresholds change every year. Have a local payroll advisor check these settings whenever the law changes, and save a new version from the date it applies.</Alert>
                <Table>
                  <THead><tr><TH>Effective from</TH><TH>Country</TH><TH>Loss of pay from</TH><TH>Saved</TH><TH /></tr></THead>
                  <TBody>
                    {saved.map((x) => (
                      <TR key={x.id}>
                        <TD className="font-medium">{x.effectiveFrom}</TD>
                        <TD>{x.countryCode ?? schemeCountry(x.settings)}</TD>
                        <TD>{x.lopSource === 'leave_only' ? 'Unpaid leave only' : 'Attendance and unpaid leave'}</TD>
                        <TD className="text-fg-muted">{new Date(x.savedAt).toLocaleDateString()}{x.savedBy ? ` by ${x.savedBy}` : ''}</TD>
                        <TD className="text-right">{x.usedByRun ? <span className="text-xs text-fg-subtle">Used by payroll</span> : <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Remove these settings?') && run(() => removeStatutoryAction(x.id))}>Remove</Button>}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Effective from" required>{(p) => <Input {...p} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />}</Field>
              <Field label="Loss-of-pay days come from" hint="Use unpaid leave only if this entity does not record attendance in SampCrew">
                {(p) => (
                  <Select {...p} value={lopSource} onChange={(e) => setLopSource(e.target.value)}>
                    <option value="attendance_and_leave">Attendance (absences, half days) and unpaid leave</option>
                    <option value="leave_only">Unpaid leave only</option>
                  </Select>
                )}
              </Field>
            </div>

            <div className="flex flex-wrap gap-2">
              {start && <Button size="sm" variant="secondary" onClick={() => setS(structuredClone(start.settings))}>Reset to the starting values</Button>}
              {isGeneric(s) && start?.pack && (
                <Button size="sm" variant="ghost" onClick={() => setS(customStatutory(country, { taxYearStartMonth: s.taxYearStartMonth, currency: entity?.currency }))}>Start from a blank custom scheme</Button>
              )}
            </div>

            {isGeneric(s) ? <GenericFields s={s} setS={(fn) => setS((prev) => { const d = structuredClone(prev) as GenericStatutory; fn(d); return d; })} /> : (
              <IndiaFields s={s} up={(fn) => setS((prev) => { const d = structuredClone(prev) as IndiaStatutory; fn(d); return d; })} />
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button loading={pending} disabled={!entityId} onClick={() => run(() => saveStatutoryAction({ legalEntityId: entityId, effectiveFrom, lopSource, settings: s }))}>I have checked these values. Save.</Button>
              {saved.length === 0 && <span className="text-xs text-fg-muted">Starting values are filled in; SampCrew does not certify them as current law.</span>}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SlabsEditor({ slabs, onChange, label }: { slabs: { upTo: string | null; ratePercent: string }[]; onChange: (s: { upTo: string | null; ratePercent: string }[]) => void; label: string }) {
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
function GenericFields({ s, setS }: { s: GenericStatutory; setS: (fn: (d: GenericStatutory) => void) => void }) {
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
function IndiaFields({ s, up }: { s: IndiaStatutory; up: (fn: (d: IndiaStatutory) => void) => void }) {
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
