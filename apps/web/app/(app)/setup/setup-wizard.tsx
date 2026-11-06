'use client';
import { COMPANY_SIZES, INDUSTRIES, INDUSTRY_LABELS, SETUP_STEPS } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, Checkbox, Field, Input, Select, Textarea, cn } from '@crew/ui';
import { Building2, Check, MapPin, Network, Pencil, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Location } from '@/lib/types';
import type { SetupState } from './page';
import { addLocationAction, addStructureAction, completeSetupAction, finishLaterAction, progressAction, removeAction, renameAction, saveCompanyAction } from './actions';

const COUNTRIES = [['IN', 'India'], ['AE', 'United Arab Emirates'], ['GB', 'United Kingdom'], ['US', 'United States'], ['SG', 'Singapore'], ['DE', 'Germany'], ['AU', 'Australia'], ['SA', 'Saudi Arabia'], ['CA', 'Canada'], ['FR', 'France'], ['NL', 'Netherlands'], ['PH', 'Philippines'], ['MY', 'Malaysia'], ['ZA', 'South Africa'], ['KE', 'Kenya'], ['NG', 'Nigeria']] as const;
const CURRENCIES = ['INR', 'AED', 'GBP', 'USD', 'SGD', 'EUR', 'AUD', 'SAR', 'CAD', 'PHP', 'MYR', 'ZAR', 'KES', 'NGN'];
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Singapore', 'Europe/Berlin', 'Australia/Sydney', 'Asia/Riyadh', 'America/Toronto', 'Europe/Paris', 'Europe/Amsterdam', 'Asia/Manila', 'Asia/Kuala_Lumpur', 'Africa/Johannesburg', 'Africa/Nairobi', 'Africa/Lagos', 'UTC'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KINDS = ['office', 'branch', 'factory', 'warehouse', 'store', 'hospital', 'site', 'remote_hub'];
const ICONS = [Building2, MapPin, Network, Network, UserPlus];

interface Props { initialStep: number; setup: SetupState; locations: Location[]; canManage: boolean }

export function SetupWizard({ initialStep, setup, locations, canManage }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(initialStep);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const go = (to: number) => {
    setMessage(null);
    setStep(to);
    if (canManage) void progressAction(to);
    window.scrollTo({ top: 0 });
  };

  if (!canManage) {
    return <Alert tone="info">Company setup is done by your workspace administrator. You can see the structure under Organization.</Alert>;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
      <ol className="flex gap-2 overflow-x-auto lg:flex-col" aria-label="Setup steps">
        {SETUP_STEPS.map((label, i) => {
          const Icon = ICONS[i]!;
          return (
            <li key={label}>
              <button
                type="button"
                onClick={() => go(i)}
                aria-current={i === step ? 'step' : undefined}
                className={cn('flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg border px-3 py-2 text-left text-[0.8125rem] transition-colors',
                  i === step ? 'border-accent bg-accent/10 font-medium text-fg' : 'border-border text-fg-muted hover:bg-bg-subtle')}
              >
                <span className={cn('flex size-6 items-center justify-center rounded-full text-[0.6875rem]', i < step ? 'bg-success/15 text-success' : 'bg-bg-subtle')}>
                  {i < step ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
                </span>
                {i + 1}. {label}
              </button>
            </li>
          );
        })}
        <li className="hidden pt-2 lg:block">
          {!setup.company.setupCompletedAt && (
            <form action={finishLaterAction}><button type="submit" className="px-3 text-xs text-fg-subtle hover:text-fg">Finish later</button></form>
          )}
        </li>
      </ol>
      <div className="min-w-0 space-y-4">
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        {step === 0 && <CompanyStep setup={setup} pending={pending} onSave={(values) => start(async () => {
          const r = await saveCompanyAction(values);
          if (!r.ok) { setMessage({ tone: 'danger', text: Object.values(r.fieldErrors ?? {})[0] ? `${r.message}: ${Object.values(r.fieldErrors ?? {})[0]}` : r.message }); return; }
          router.refresh();
          go(1);
        })} />}
        {step === 1 && <LocationsStep setup={setup} locations={locations} onNext={() => go(2)} onBack={() => go(0)} />}
        {step === 2 && (
          <StructureStep
            kind="department"
            existing={setup.departments.map((d) => ({ id: d.id, name: d.name, detail: d.code }))}
            suggestions={setup.suggestions.departments.map((d) => ({ name: d.name, code: d.code }))}
            onNext={() => go(3)}
            onBack={() => go(1)}
          />
        )}
        {step === 3 && (
          <StructureStep
            kind="designation"
            existing={setup.designations.map((d) => ({ id: d.id, name: d.name, detail: d.level !== null ? `Level ${d.level}` : d.code }))}
            suggestions={setup.suggestions.designations.map((d) => ({ name: d.name, code: d.code, level: d.level }))}
            onNext={() => go(4)}
            onBack={() => go(2)}
          />
        )}
        {step === 4 && (
          <Card>
            <CardBody className="space-y-4">
              <h2 className="text-lg font-semibold">You are ready to add employees</h2>
              <ul className="grid gap-2 text-[0.8125rem] sm:grid-cols-2">
                <Summary ok label="Company details" value={setup.company.name} onEdit={() => go(0)} />
                <Summary ok={setup.counts.locations > 0} label="Locations" value={`${setup.counts.locations} added`} onEdit={() => go(1)} />
                <Summary ok={setup.counts.departments > 0} label="Departments" value={`${setup.counts.departments} added`} onEdit={() => go(2)} />
                <Summary ok={setup.counts.designations > 0} label="Designations" value={`${setup.counts.designations} added`} onEdit={() => go(3)} />
              </ul>
              <p className="text-[0.8125rem] text-fg-muted">You can change all of this later under Organization structure. Next, the guided hire takes you through the first employee: photo, job, attendance registration and their CREW login.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => go(3)}>Back</Button>
                <Button
                  loading={pending}
                  onClick={() => start(async () => {
                    const r = await completeSetupAction();
                    if (r && !r.ok) setMessage({ tone: 'danger', text: r.message });
                  })}
                >
                  <UserPlus className="size-4" /> {setup.company.setupCompletedAt ? 'Done, add an employee' : 'Finish setup and add the first employee'}
                </Button>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function Summary({ ok, label, value, onEdit }: { ok: boolean; label: string; value: string; onEdit: () => void }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
      <span className={cn('flex size-5 items-center justify-center rounded-full', ok ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>{ok ? <Check className="size-3" /> : '!'}</span>
      <span className="flex-1"><span className="block text-xs text-fg-subtle">{label}</span>{value}</span>
      <button type="button" className="text-xs text-accent hover:underline" onClick={onEdit} aria-label={`Edit ${label.toLowerCase()}`}>Edit</button>
    </li>
  );
}

function CompanyStep({ setup, pending, onSave }: { setup: SetupState; pending: boolean; onSave: (v: Record<string, unknown>) => void }) {
  const c = setup.company;
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Card>
      <CardBody>
        <form
          noValidate
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const v: Record<string, unknown> = {};
            for (const [k, val] of f.entries()) { const s = String(val).trim(); if (s) v[k] = s; }
            const errs: Record<string, string> = {};
            if (!v.name) errs.name = 'Enter the company name';
            if (!v.industry) errs.industry = 'Choose your industry';
            if (!v.companySize) errs.companySize = 'Choose the company size';
            if (v.website && !/^https?:\/\/\S+$/.test(String(v.website))) errs.website = 'Start the website with https://';
            setErrors(errs);
            if (Object.keys(errs).length) return;
            v.fiscalYearStartMonth = Number(v.fiscalYearStartMonth);
            onSave(v);
          }}
        >
          <h2 className="text-lg font-semibold sm:col-span-2">Tell us about your company</h2>
          <Field label="Company name" required error={errors.name}>{(p) => <Input {...p} name="name" defaultValue={c.name} maxLength={160} />}</Field>
          <Field label="Registered legal name" hint="As on your registration certificate">{(p) => <Input {...p} name="legalName" defaultValue={c.legalName ?? ''} maxLength={200} />}</Field>
          <Field label="Industry" required error={errors.industry}>
            {(p) => <Select {...p} name="industry" defaultValue={c.industry ?? ''}><option value="">Choose…</option>{INDUSTRIES.map((i) => <option key={i} value={i}>{INDUSTRY_LABELS[i]}</option>)}</Select>}
          </Field>
          <Field label="Number of employees" required error={errors.companySize}>
            {(p) => <Select {...p} name="companySize" defaultValue={c.companySize ?? ''}><option value="">Choose…</option>{COMPANY_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}</Select>}
          </Field>
          <Field label="Website" error={errors.website}>{(p) => <Input {...p} name="website" type="url" placeholder="https://" defaultValue={c.website ?? ''} />}</Field>
          <Field label="HR contact email" hint="Shown to employees for HR questions">{(p) => <Input {...p} name="contactEmail" type="email" defaultValue={c.contactEmail ?? ''} />}</Field>
          <Field label="Company phone">{(p) => <Input {...p} name="contactPhone" type="tel" defaultValue={c.contactPhone ?? ''} />}</Field>
          <Field label="Country" required>{(p) => <Select {...p} name="countryCode" defaultValue={c.countryCode}>{COUNTRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
          <Field label="Currency" required>{(p) => <Select {...p} name="currency" defaultValue={c.currency}>{CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}</Select>}</Field>
          <Field label="Time zone" required>{(p) => <Select {...p} name="timezone" defaultValue={c.timezone}>{[...new Set([c.timezone, ...TIMEZONES])].map((x) => <option key={x} value={x}>{x}</option>)}</Select>}</Field>
          <Field label="Financial year starts" required>{(p) => <Select {...p} name="fiscalYearStartMonth" defaultValue={String(c.fiscalYearStartMonth)}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select>}</Field>
          <Field label="Registration number" hint="For example CIN or company number">{(p) => <Input {...p} name="registrationNumber" defaultValue={c.registrationNumber ?? ''} maxLength={64} />}</Field>
          <Field label="Tax ID" hint="For example GSTIN, VAT or EIN">{(p) => <Input {...p} name="taxId" defaultValue={c.taxId ?? ''} maxLength={64} />}</Field>
          <Field label="Registered address" className="sm:col-span-2">{(p) => <Textarea {...p} name="address" rows={2} defaultValue={c.address ?? ''} maxLength={500} />}</Field>
          <div className="flex justify-end sm:col-span-2"><Button type="submit" loading={pending}>Save and continue</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}

function LocationsStep({ setup, locations, onNext, onBack }: { setup: SetupState; locations: Location[]; onNext: () => void; onBack: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  return (
    <Card>
      <CardBody className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Where do your people work?</h2>
          <p className="text-[0.8125rem] text-fg-muted">Add your offices, plants, stores or sites. Attendance rules, holidays and geofences follow the location. You can skip this and add them later.</p>
        </div>
        {locations.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Locations added">
            {locations.map((l) => <li key={l.id}><Badge><MapPin className="mr-1 inline size-3" />{l.name}{l.city ? `, ${l.city}` : ''}</Badge></li>)}
          </ul>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <form
          key={formKey}
          className="grid grid-cols-1 gap-3 rounded-lg border border-border p-4 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const v: Record<string, unknown> = { legalEntityId: setup.company.legalEntityId, countryCode: setup.company.countryCode, timezone: setup.company.timezone };
            for (const k of ['name', 'kind', 'city']) { const s = String(f.get(k) ?? '').trim(); if (s) v[k] = s; }
            if (!v.name) { setError('Enter a name for the location'); return; }
            setError(null);
            start(async () => {
              const r = await addLocationAction(v);
              if (!r.ok) { setError(r.message); return; }
              setFormKey((k) => k + 1);
              router.refresh();
            });
          }}
        >
          <Field label="Location name" className="sm:col-span-2">{(p) => <Input {...p} name="name" placeholder="Head office" maxLength={160} />}</Field>
          <Field label="Type">{(p) => <Select {...p} name="kind" defaultValue="office">{KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ').replace(/^\w/, (x) => x.toUpperCase())}</option>)}</Select>}</Field>
          <Field label="City">{(p) => <Input {...p} name="city" maxLength={100} />}</Field>
          <div className="sm:col-span-4"><Button type="submit" variant="secondary" size="sm" loading={pending}><Plus className="size-3.5" /> Add location</Button></div>
        </form>
        <div className="flex justify-between">
          <Button variant="secondary" onClick={onBack}>Back</Button>
          <Button onClick={onNext}>{locations.length ? 'Continue' : 'Skip for now'}</Button>
        </div>
      </CardBody>
    </Card>
  );
}

type Suggestion = { name: string; code?: string; level?: number };

/**
 * Departments or designations: what exists (rename or remove), ready-made suggestions for the industry to tick, and
 * your own to type in. Saving adds the ticked and typed ones together.
 */
function StructureStep({ kind, existing, suggestions, onNext, onBack }: {
  kind: 'department' | 'designation';
  existing: { id: string; name: string; detail: string | null }[];
  suggestions: Suggestion[];
  onNext: () => void;
  onBack: () => void;
}) {
  const router = useRouter();
  const plural = kind === 'department' ? 'departments' : 'designations';
  const have = new Set(existing.map((x) => x.name.toLowerCase()));
  const open = suggestions.filter((s) => !have.has(s.name.toLowerCase()));
  // A new workspace starts with every suggestion ticked; untick what does not apply.
  const [picked, setPicked] = useState<Set<string>>(() => new Set(existing.length ? [] : open.map((s) => s.name)));
  const [custom, setCustom] = useState<Suggestion[]>([]);
  const [draft, setDraft] = useState('');
  const [level, setLevel] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const toAdd = [...open.filter((s) => picked.has(s.name)), ...custom];
  const save = (thenNext: boolean) => start(async () => {
    setMessage(null);
    if (toAdd.length) {
      const items = toAdd.map((s) => (kind === 'department' ? { name: s.name, ...(s.code ? { code: s.code } : {}) } : { name: s.name, ...(s.code ? { code: s.code } : {}), ...(s.level !== undefined ? { level: s.level } : {}) }));
      const r = await addStructureAction(kind === 'department' ? { departments: items } : { designations: items });
      if (!r.ok) { setMessage({ tone: 'danger', text: r.message }); return; }
      const n = kind === 'department' ? r.data!.created.departments.length : r.data!.created.designations.length;
      setMessage({ tone: 'success', text: `${n} ${n === 1 ? kind : plural} added.` });
      setPicked(new Set());
      setCustom([]);
      router.refresh();
    }
    if (thenNext) onNext();
  });
  const addCustom = () => {
    const name = draft.trim();
    if (!name) return;
    if (have.has(name.toLowerCase()) || toAdd.some((s) => s.name.toLowerCase() === name.toLowerCase())) { setMessage({ tone: 'danger', text: `${name} is already on the list.` }); return; }
    const lv = level.trim() === '' ? undefined : Math.max(0, Math.min(100, Number(level)));
    setCustom((c) => [...c, { name, ...(kind === 'designation' && lv !== undefined && !Number.isNaN(lv) ? { level: lv } : {}) }]);
    setDraft('');
    setLevel('');
  };

  return (
    <Card>
      <CardBody className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold">{kind === 'department' ? 'Your departments' : 'Your designations'}</h2>
          <p className="text-[0.8125rem] text-fg-muted">
            {kind === 'department'
              ? 'Teams people belong to. Department managers see and approve for their department.'
              : 'Job titles, from most senior down. The level orders them in reports and the org chart.'}{' '}
            We picked common ones for your industry: untick what you do not use and add your own.
          </p>
        </div>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}

        {existing.length > 0 && (
          <section aria-label={`${plural} already added`}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Added ({existing.length})</h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {existing.map((x) => (
                <li key={x.id} className="flex items-center gap-2 px-3 py-2 text-[0.8125rem]">
                  {editing?.id === x.id ? (
                    <>
                      <Input aria-label={`New name for ${x.name}`} value={editing.name} onChange={(e) => setEditing({ id: x.id, name: e.target.value })} className="h-8 flex-1" autoFocus maxLength={160} />
                      <Button size="sm" loading={pending} onClick={() => start(async () => {
                        const r = await renameAction(kind, x.id, editing.name.trim());
                        setMessage(r.ok ? { tone: 'success', text: `Renamed to ${editing.name.trim()}.` } : { tone: 'danger', text: r.message });
                        if (r.ok) { setEditing(null); router.refresh(); }
                      })}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)} aria-label="Cancel rename"><X className="size-3.5" /></Button>
                    </>
                  ) : (
                    <>
                      <Check className="size-3.5 text-success" />
                      <span className="flex-1">{x.name}</span>
                      {x.detail && <span className="text-xs text-fg-subtle">{x.detail}</span>}
                      <Button size="sm" variant="ghost" aria-label={`Rename ${x.name}`} onClick={() => setEditing({ id: x.id, name: x.name })}><Pencil className="size-3.5" /></Button>
                      <Button size="sm" variant="ghost" aria-label={`Remove ${x.name}`} disabled={pending} onClick={() => start(async () => {
                        const r = await removeAction(kind, x.id);
                        setMessage(r.ok ? { tone: 'success', text: `${x.name} removed.` } : { tone: 'danger', text: r.message });
                        router.refresh();
                      })}><Trash2 className="size-3.5" /></Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {open.length > 0 && (
          <section aria-label={`Suggested ${plural}`}>
            <div className="mb-2 flex items-center gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Suggested for your industry</h3>
              <button type="button" className="text-xs text-accent hover:underline" onClick={() => setPicked(new Set(open.map((s) => s.name)))}>Select all</button>
              <button type="button" className="text-xs text-accent hover:underline" onClick={() => setPicked(new Set())}>Clear</button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {open.map((s) => (
                <Checkbox
                  key={s.name}
                  label={s.name}
                  description={kind === 'designation' && s.level !== undefined ? `Level ${s.level}` : s.code}
                  checked={picked.has(s.name)}
                  onChange={(e) => setPicked((cur) => { const n = new Set(cur); if (e.target.checked) n.add(s.name); else n.delete(s.name); return n; })}
                />
              ))}
            </div>
          </section>
        )}

        <section aria-label={`Add your own ${plural}`} className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Add your own</h3>
          <div className="flex flex-wrap items-end gap-2">
            <Field label={kind === 'department' ? 'Department name' : 'Designation name'} className="min-w-48 flex-1">
              {(p) => <Input {...p} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={120} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />}
            </Field>
            {kind === 'designation' && <Field label="Level (0 to 100)" className="w-36">{(p) => <Input {...p} type="number" min={0} max={100} value={level} onChange={(e) => setLevel(e.target.value)} />}</Field>}
            <Button variant="secondary" onClick={addCustom}><Plus className="size-3.5" /> Add to list</Button>
          </div>
          {custom.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {custom.map((c) => (
                <li key={c.name}><Badge tone="info">{c.name}{c.level !== undefined ? ` · L${c.level}` : ''} <button type="button" aria-label={`Remove ${c.name}`} className="ml-1" onClick={() => setCustom((all) => all.filter((x) => x !== c))}><X className="inline size-3" /></button></Badge></li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
          <Button variant="secondary" onClick={onBack}>Back</Button>
          <span className="flex gap-2">
            {toAdd.length > 0 && <Button variant="secondary" loading={pending} onClick={() => save(false)}>Add {toAdd.length} {toAdd.length === 1 ? kind : plural}</Button>}
            <Button loading={pending} onClick={() => save(true)}>{toAdd.length ? `Add ${toAdd.length} and continue` : 'Continue'}</Button>
          </span>
        </div>
      </CardBody>
    </Card>
  );
}
