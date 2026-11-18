'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, GenericStatutoryFields, IndiaStatutoryFields, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { customStatutory } from '@crew/contracts';
import { useState } from 'react';
import type { LegalEntity } from '@/lib/types';
import { useRunner } from '../../recruitment/use-runner';
import { removeStatutoryAction, saveStatutoryAction } from '../../payroll/actions';
import type { GenericStatutory, IndiaStatutory, StatutoryResponse, StatutorySettings } from '../../payroll/types';

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
        ) : saved.length === 0 ? (
          <Alert tone="warning" title="Not saved yet">{statutory.startingValues.notice}</Alert>
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

            {isGeneric(s) ? <GenericStatutoryFields s={s} setS={(fn) => setS((prev) => { const d = structuredClone(prev) as GenericStatutory; fn(d); return d; })} /> : (
              <IndiaStatutoryFields s={s} up={(fn) => setS((prev) => { const d = structuredClone(prev) as IndiaStatutory; fn(d); return d; })} />
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
