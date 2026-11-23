'use client';
import { customStatutory, isGenericStatutory, type AnyStatutory, type GenericStatutory, type StatutorySettings } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, GenericStatutoryFields, IndiaStatutoryFields, Input, Switch, Table, TBody, TD, TH, THead, TR, Textarea, cn } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { StatutoryPackView } from '@/lib/types';
import { removeStatutoryPackAction, resetStatutoryPackAction, saveStatutoryPackAction } from '../actions';

type Flash = { tone: 'success' | 'danger'; text: string } | null;
interface Draft { countryCode: string; country: string; currency: string; basis: string; summary: string; active: boolean; settings: AnyStatutory }

const toDraft = (p: StatutoryPackView): Draft => ({ countryCode: p.countryCode, country: p.country, currency: p.currency, basis: p.basis, summary: p.summary, active: p.active, settings: structuredClone(p.settings) });

/** Every payroll country pack, with an editor for one at a time. Packs live in the database; nothing here comes from the server's settings file. */
export function StatutoryPacksView({ packs: listed, canManage }: { packs: StatutoryPackView[]; canManage: boolean }) {
  const router = useRouter();
  // Packs removed here leave the list at once, not only when the page refresh that follows has finished.
  const [removed, setRemoved] = useState<string[]>([]);
  const packs = listed.filter((p) => !removed.includes(p.countryCode));
  const [pending, start] = useTransition();
  const [flash, setFlash] = useState<Flash>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newCurrency, setNewCurrency] = useState('');
  const current = draft && packs.find((p) => p.countryCode === draft.countryCode);

  const open = (p: StatutoryPackView) => { setFlash(null); setIsNew(false); setDraft(toDraft(p)); };
  const startNew = () => {
    const code = newCode.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return setFlash({ tone: 'danger', text: 'Enter the two-letter country code, such as DE for Germany.' });
    const existing = packs.find((p) => p.countryCode === code);
    if (existing) return open(existing);
    let country = code;
    try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code; } catch { /* keep the code */ }
    const currency = newCurrency.trim().toUpperCase() || 'USD';
    setFlash(null);
    setIsNew(true);
    setDraft({ countryCode: code, country, currency, basis: '', summary: '', active: true, settings: customStatutory(code, { currency }) });
  };
  const done = (r: { ok: boolean; message?: string }, ok: string, after?: () => void) => {
    setFlash({ tone: r.ok ? 'success' : 'danger', text: r.ok ? ok : (r.message ?? 'That did not work.') });
    if (r.ok) { after?.(); router.refresh(); }
  };
  const save = () => draft && start(async () => {
    const { countryCode, ...body } = draft;
    done(await saveStatutoryPackAction(countryCode, body), `${draft.country} saved. Legal entities in ${draft.country} that have not saved their settings now start from these values.`, () => { setIsNew(false); setRemoved((g) => g.filter((c) => c !== countryCode)); });
  });
  const reset = () => draft && confirm(`Put ${draft.country} back to the values that come with SampCrew?`) && start(async () => {
    done(await resetStatutoryPackAction(draft.countryCode), `${draft.country} is back to SampCrew's values.`, () => setDraft(null));
  });
  const remove = () => draft && confirm(`Remove the ${draft.country} pack? Workspaces keep the settings they already saved.`) && start(async () => {
    done(await removeStatutoryPackAction(draft.countryCode), `${draft.country} removed. New legal entities there start from a blank custom scheme.`, () => { setRemoved((g) => [...g, draft.countryCode]); setDraft(null); });
  });
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setSettings = (fn: (s: AnyStatutory) => void) => setDraft((d) => { if (!d) return d; const s = structuredClone(d.settings); fn(s); return { ...d, settings: s }; });

  return (
    <div className="grid gap-5">
      {flash && <div data-testid="packs-flash"><Alert tone={flash.tone}>{flash.text}</Alert></div>}
      {!canManage && <Alert tone="info">You can see the country packs but not change them. Only Super admins can edit, add or switch off a pack.</Alert>}
      <Card>
        <CardHeader title="Country packs" description="Starting values per country. A country without a pack starts from a blank custom scheme the workspace fills in." />
        <CardBody className="grid gap-4">
          <Table>
            <THead><tr><TH>Country</TH><TH>Currency</TH><TH>Basis</TH><TH>Status</TH><TH>Changed</TH><TH /></tr></THead>
            <TBody>
              {packs.map((p) => (
                <TR key={p.countryCode} className={cn(draft?.countryCode === p.countryCode && 'bg-surface-2')} data-testid={`pack-${p.countryCode}`}>
                  <TD className="font-medium">{p.country} ({p.countryCode})</TD>
                  <TD>{p.currency}</TD>
                  <TD className="text-fg-muted">{p.basis}</TD>
                  <TD className="flex flex-wrap gap-1">
                    {p.active ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
                    {p.builtIn ? (p.customisedAt ? <Badge tone="warning">Changed in Console</Badge> : <Badge tone="accent">SampCrew values</Badge>) : <Badge tone="accent">Added in Console</Badge>}
                  </TD>
                  <TD className="text-fg-muted">{p.customisedAt ? `${new Date(p.customisedAt).toLocaleDateString()}${p.customisedBy ? ` by ${p.customisedBy}` : ''}` : '—'}</TD>
                  <TD className="text-right"><Button size="sm" variant="ghost" onClick={() => open(p)}>{canManage ? 'Edit' : 'View'}</Button></TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {canManage && (
            <div className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
              <Field label="Country code" hint="Two letters, such as DE">{(p) => <Input {...p} value={newCode} maxLength={2} onChange={(e) => setNewCode(e.target.value)} className="w-28 uppercase" />}</Field>
              <Field label="Currency" hint="Three letters, such as EUR">{(p) => <Input {...p} value={newCurrency} maxLength={3} onChange={(e) => setNewCurrency(e.target.value)} className="w-28 uppercase" />}</Field>
              <Button variant="secondary" onClick={startNew}>Add a country</Button>
            </div>
          )}
        </CardBody>
      </Card>

      {draft && (
        <Card data-testid="pack-editor">
          <CardHeader title="Pack settings" description={`${isNew ? 'New pack' : draft.country} (${draft.countryCode}). Rates and thresholds change every year: save new values when the law changes.`} />
          <CardBody className="grid gap-5">
            <fieldset disabled={!canManage || pending} className="grid gap-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Country name" required>{(p) => <Input {...p} value={draft.country} onChange={(e) => set({ country: e.target.value })} />}</Field>
                <Field label="Currency" required>{(p) => <Input {...p} value={draft.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />}</Field>
                <Field label="Basis" required hint="The law or tax year the values follow">{(p) => <Input {...p} value={draft.basis} onChange={(e) => set({ basis: e.target.value })} />}</Field>
              </div>
              <Field label="Summary" hint="Shown to workspaces next to the country">{(p) => <Textarea {...p} rows={2} value={draft.summary} onChange={(e) => set({ summary: e.target.value })} />}</Field>
              <Switch checked={draft.active} onChange={(active) => set({ active })} label="Offer this pack to workspaces" testId="pack-active" />
              {isGenericStatutory(draft.settings)
                ? <GenericStatutoryFields s={draft.settings} setS={(fn) => setSettings((s) => fn(s as GenericStatutory))} />
                : <IndiaStatutoryFields s={draft.settings} up={(fn) => setSettings((s) => fn(s as StatutorySettings))} />}
            </fieldset>
            {canManage && (
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button loading={pending} onClick={save}>Save pack</Button>
                {current?.builtIn && current.customisedAt && <Button variant="secondary" loading={pending} onClick={reset}>Reset to SampCrew&apos;s values</Button>}
                {current && !current.builtIn && <Button data-delete-area="console" data-delete={`${current.country} payroll pack`} variant="ghost" loading={pending} onClick={remove}>Remove pack</Button>}
                <Button variant="ghost" onClick={() => { setDraft(null); setIsNew(false); }}>Close</Button>
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
