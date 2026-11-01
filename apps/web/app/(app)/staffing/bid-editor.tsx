'use client';
import { type BidInput, type BidPricing, formatAmount, priceBid } from '@crew/contracts';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Select, Textarea, cn } from '@crew/ui';
import { AlertTriangle, Plus, Trash2, Zap, SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { Designation, LegalEntity } from '@/lib/types';
import { saveBidAction, saveClientAction } from './actions';
import type { Bid, BidTemplate, Client } from './types';

type Line = { roleTitle: string; designationId: string; headcount: string; location: string; payMonthly: string; billMonthly: string; notes: string };
type Values = {
  clientId: string; legalEntityId: string; title: string; titleTouched: boolean; mode: 'quick' | 'advanced'; currency: string; startDate: string; durationMonths: string;
  onCostPct: string; overheadPct: string; targetMarginPct: string; templateId: string; coverNote: string; terms: string; validUntil: string; lines: Line[];
};

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const PCT = /^\d{1,3}(\.\d{1,2})?$/;
const blankLine = (): Line => ({ roleTitle: '', designationId: '', headcount: '1', location: '', payMonthly: '', billMonthly: '', notes: '' });

function nextMonthStart() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** Turns the form into the API shape, or explains the first thing that is missing. */
function toInput(v: Values): { input: BidInput | null; problem: string | null } {
  if (!v.clientId) return { input: null, problem: 'Choose a client' };
  if (!v.lines.length) return { input: null, problem: 'Add at least one role' };
  for (const [i, l] of v.lines.entries()) {
    const n = v.lines.length > 1 ? ` on role ${i + 1}` : '';
    if (l.roleTitle.trim().length < 2) return { input: null, problem: `Enter the role${n}` };
    if (!/^\d+$/.test(l.headcount) || Number(l.headcount) < 1) return { input: null, problem: `Enter how many people${n}` };
    if (!MONEY.test(l.payMonthly.replace(/,/g, '')) || Number(l.payMonthly.replace(/,/g, '')) <= 0) return { input: null, problem: `Enter the monthly pay per person${n}` };
    if (l.billMonthly && (!MONEY.test(l.billMonthly.replace(/,/g, '')) || Number(l.billMonthly.replace(/,/g, '')) <= 0)) return { input: null, problem: `Check the bill rate${n}` };
  }
  for (const [k, label] of [['onCostPct', 'on-costs'], ['overheadPct', 'overhead'], ['targetMarginPct', 'target margin']] as const) {
    if (!PCT.test(v[k])) return { input: null, problem: `Enter the ${label} as a percentage` };
  }
  if (Number(v.targetMarginPct) >= 100) return { input: null, problem: 'The target margin must be below 100%' };
  if (!/^\d+$/.test(v.durationMonths) || Number(v.durationMonths) < 1 || Number(v.durationMonths) > 120) return { input: null, problem: 'Enter a duration of 1 to 120 months' };
  if (!v.startDate) return { input: null, problem: 'Choose a start date' };
  const title = v.title.trim();
  return {
    problem: title.length < 3 ? 'Enter a title' : null,
    input: {
      clientId: v.clientId, legalEntityId: v.legalEntityId, title: title || 'Untitled bid', mode: v.mode, currency: v.currency, startDate: v.startDate,
      durationMonths: Number(v.durationMonths), onCostPct: v.onCostPct, overheadPct: v.overheadPct, targetMarginPct: v.targetMarginPct,
      templateId: v.templateId || null, coverNote: v.coverNote, terms: v.terms, validUntil: v.validUntil || undefined,
      lines: v.lines.map((l) => ({
        roleTitle: l.roleTitle.trim(), designationId: l.designationId || null, headcount: Number(l.headcount), location: l.location.trim() || undefined,
        payMonthly: l.payMonthly.replace(/,/g, ''), billMonthly: l.billMonthly.replace(/,/g, '') || undefined, notes: l.notes.trim() || undefined,
      })),
    },
  };
}

/**
 * Quick Bid and Advanced Bid share one editor. Quick Bid asks only for the client, one role, people, pay, location
 * and term, takes on-costs, overhead, margin and wording from the default template, and works out the bill rate.
 * Advanced Bid adds several roles, bill rates per role, pricing assumptions and the proposal text. Pricing is
 * shown live with the same exact maths the server uses.
 */
export function BidEditor({ bid, initialMode, initialClientId, initialLine, clients: initialClients, templates, entities, designations }: {
  bid: Bid | null;
  initialMode: 'quick' | 'advanced';
  initialClientId?: string;
  /** A first role to start from, for example from CREW IQ. Nothing is saved until the person saves the bid. */
  initialLine?: { roleTitle?: string; headcount?: number };
  clients: Client[];
  templates: BidTemplate[];
  entities: LegalEntity[];
  designations: Designation[];
}) {
  const router = useRouter();
  const [clients, setClients] = useState(initialClients);
  const def = templates.find((t) => t.isDefault) ?? templates[0];
  const [v, setV] = useState<Values>(() => bid
    ? {
      clientId: bid.clientId, legalEntityId: bid.legalEntityId, title: bid.title, titleTouched: true, mode: bid.mode, currency: bid.currency, startDate: bid.startDate,
      durationMonths: String(bid.durationMonths), onCostPct: bid.onCostPct, overheadPct: bid.overheadPct, targetMarginPct: bid.targetMarginPct, templateId: bid.templateId ?? '',
      coverNote: bid.coverNote, terms: bid.terms, validUntil: bid.validUntil ?? '',
      lines: bid.lines.map((l) => ({ roleTitle: l.roleTitle, designationId: l.designationId ?? '', headcount: String(l.headcount), location: l.location ?? '', payMonthly: l.payMonthly, billMonthly: l.billMonthly ?? '', notes: l.notes ?? '' })),
    }
    : {
      clientId: initialClients.some((c) => c.id === initialClientId) ? initialClientId! : '', legalEntityId: entities[0]?.id ?? '', title: '', titleTouched: false, mode: initialMode, currency: initialClients.find((c) => c.id === initialClientId)?.currency ?? 'INR', startDate: nextMonthStart(), durationMonths: '12',
      onCostPct: def?.onCostPct ?? '13', overheadPct: def?.overheadPct ?? '5', targetMarginPct: def?.targetMarginPct ?? '18', templateId: def?.id ?? '',
      coverNote: def?.coverNote ?? '', terms: def?.terms ?? '', validUntil: '', lines: [{ ...blankLine(), roleTitle: initialLine?.roleTitle?.slice(0, 120) ?? '', headcount: initialLine?.headcount ? String(initialLine.headcount) : '1' }],
    });
  const [error, setError] = useState<string | null>(null);
  const [showProblem, setShowProblem] = useState(false);
  const [clientOpen, setClientOpen] = useState(false);
  const [pending, start] = useTransition();
  const client = clients.find((c) => c.id === v.clientId);

  // A title that follows the first role and client until the person types their own.
  const autoTitle = (x: Values) => {
    if (x.titleTouched) return x.title;
    const l = x.lines[0];
    const c = clients.find((cl) => cl.id === x.clientId);
    if (!l?.roleTitle.trim()) return x.title;
    const n = Number(l.headcount) || 1;
    return `${n} ${l.roleTitle.trim()}${n > 1 && !/s$/i.test(l.roleTitle.trim()) ? 's' : ''}${c ? ` for ${c.name}` : ''}`;
  };
  const set = (patch: Partial<Values>) => setV((cur) => { const next = { ...cur, ...patch }; return { ...next, title: autoTitle(next) }; });
  const setLine = (i: number, patch: Partial<Line>) => set({ lines: v.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  const { input, problem } = useMemo(() => toInput(v), [v]);
  const pricing: BidPricing | null = useMemo(() => {
    if (!input) return null;
    try { return priceBid(input); } catch { return null; }
  }, [input]);
  const money = (x: string) => `${v.currency} ${formatAmount(x, v.currency)}`;

  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) { set({ templateId: '' }); return; }
    set({ templateId: id, onCostPct: t.onCostPct, overheadPct: t.overheadPct, targetMarginPct: t.targetMarginPct, coverNote: t.coverNote, terms: t.terms });
  };

  const save = (submit: boolean) => {
    setShowProblem(true);
    if (!input || problem) return;
    setError(null);
    start(async () => {
      const r = await saveBidAction(bid?.id ?? null, input, submit);
      if (r.ok) router.push(`/staffing/bids/${r.data!.id}`);
      else if ('data' in r && r.data?.id) router.push(`/staffing/bids/${r.data.id}?notice=${encodeURIComponent(r.message)}`);
      else setError(r.message);
    });
  };

  const quick = v.mode === 'quick';
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_22rem]">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Bid mode">
          {(['quick', 'advanced'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={v.mode === m}
              onClick={() => set({ mode: m })}
              className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[0.8125rem]', v.mode === m ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface text-fg-muted hover:text-fg')}
            >
              {m === 'quick' ? <Zap className="size-3.5" /> : <SlidersHorizontal className="size-3.5" />} {m === 'quick' ? 'Quick Bid' : 'Advanced Bid'}
            </button>
          ))}
          <span className="text-xs text-fg-subtle">{quick ? 'One role, defaults from the template. Switch to Advanced for more roles, rates and wording.' : 'Several roles, your own bill rates, pricing assumptions and proposal text.'}</span>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Client and term</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Client" required>
              {(f) => (
                <div className="flex gap-2">
                  <Select {...f} name="clientId" value={v.clientId} onChange={(e) => { const c = clients.find((x) => x.id === e.target.value); set({ clientId: e.target.value, currency: c?.currency ?? v.currency }); }} className="flex-1">
                    <option value="">Choose a client</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                  <Button type="button" variant="secondary" onClick={() => setClientOpen(true)} aria-label="Add a new client"><Plus className="size-4" /></Button>
                </div>
              )}
            </Field>
            {!quick || entities.length > 1 ? (
              <Field label="Bidding entity" hint="The company that signs the contract">
                {(f) => <Select {...f} name="legalEntityId" value={v.legalEntityId} onChange={(e) => set({ legalEntityId: e.target.value })}>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>}
              </Field>
            ) : <div />}
            <Field label="Start date" required>{(f) => <Input {...f} name="startDate" type="date" value={v.startDate} onChange={(e) => set({ startDate: e.target.value })} />}</Field>
            <Field label="Contract length (months)" required>{(f) => <Input {...f} name="durationMonths" type="number" min={1} max={120} value={v.durationMonths} onChange={(e) => set({ durationMonths: e.target.value })} />}</Field>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{quick ? 'Role' : 'Roles'}</h2>
            {!quick && <Button size="sm" variant="secondary" type="button" onClick={() => set({ lines: [...v.lines, blankLine()] })} disabled={v.lines.length >= 50}><Plus className="size-3.5" /> Add role</Button>}
          </div>
          <div className="space-y-4">
            {(quick ? v.lines.slice(0, 1) : v.lines).map((l, i) => {
              const priced = pricing?.lines[i];
              return (
                <fieldset key={i} className={cn('grid grid-cols-2 gap-3 sm:grid-cols-6', !quick && 'rounded-lg border border-border p-3')} aria-label={`Role ${i + 1}`}>
                  <Field label="Role" required className="col-span-2 sm:col-span-3">{(f) => <Input {...f} name={`lines.${i}.roleTitle`} value={l.roleTitle} onChange={(e) => setLine(i, { roleTitle: e.target.value })} placeholder="Recruiter" maxLength={120} />}</Field>
                  <Field label="People" required>{(f) => <Input {...f} name={`lines.${i}.headcount`} type="number" min={1} value={l.headcount} onChange={(e) => setLine(i, { headcount: e.target.value })} />}</Field>
                  <Field label="Location" className="col-span-2">{(f) => <Input {...f} name={`lines.${i}.location`} value={l.location} onChange={(e) => setLine(i, { location: e.target.value })} placeholder="Bengaluru" maxLength={120} />}</Field>
                  <Field label="Monthly pay per person" required className="col-span-2" hint="What each person costs before on-costs">{(f) => <Input {...f} name={`lines.${i}.payMonthly`} inputMode="decimal" value={l.payMonthly} onChange={(e) => setLine(i, { payMonthly: e.target.value })} placeholder="40000" />}</Field>
                  {!quick && (
                    <>
                      <Field label="Bill rate per person" className="col-span-2" hint={priced?.billDerived ? `From target margin: ${money(priced.billMonthly)}` : 'Leave empty to use the target margin'}>
                        {(f) => <Input {...f} name={`lines.${i}.billMonthly`} inputMode="decimal" value={l.billMonthly} onChange={(e) => setLine(i, { billMonthly: e.target.value })} />}
                      </Field>
                      <Field label="Designation" className="col-span-2">
                        {(f) => <Select {...f} value={l.designationId} onChange={(e) => setLine(i, { designationId: e.target.value })}><option value="">None</option>{designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}
                      </Field>
                    </>
                  )}
                  {priced && (
                    <p className={cn('col-span-2 flex items-center gap-1.5 text-xs sm:col-span-6', priced.belowTarget ? 'text-warning' : 'text-fg-muted')}>
                      {priced.belowTarget && <AlertTriangle className="size-3.5" />}
                      Bill {money(priced.billMonthly)} per person, cost {money(priced.loadedCostMonthly)}, margin {priced.marginPct}%{priced.belowTarget ? `, below the ${v.targetMarginPct}% target` : ''}
                    </p>
                  )}
                  {!quick && v.lines.length > 1 && (
                    <div className="col-span-2 flex justify-end sm:col-span-6">
                      <Button size="sm" variant="ghost" type="button" onClick={() => set({ lines: v.lines.filter((_, j) => j !== i) })} aria-label={`Remove role ${i + 1}`}><Trash2 className="size-3.5" /> Remove</Button>
                    </div>
                  )}
                </fieldset>
              );
            })}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Pricing assumptions</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Template" className="sm:col-span-4">
              {(f) => <Select {...f} name="templateId" value={v.templateId} onChange={(e) => applyTemplate(e.target.value)}><option value="">No template</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}</option>)}</Select>}
            </Field>
            <Field label="Target margin %" required hint="Margin on revenue">{(f) => <Input {...f} name="targetMarginPct" inputMode="decimal" value={v.targetMarginPct} onChange={(e) => set({ targetMarginPct: e.target.value })} />}</Field>
            {!quick && (
              <>
                <Field label="On-costs %" hint="Statutory and benefits on pay">{(f) => <Input {...f} name="onCostPct" inputMode="decimal" value={v.onCostPct} onChange={(e) => set({ onCostPct: e.target.value })} />}</Field>
                <Field label="Overhead %" hint="Delivery and management">{(f) => <Input {...f} name="overheadPct" inputMode="decimal" value={v.overheadPct} onChange={(e) => set({ overheadPct: e.target.value })} />}</Field>
                <Field label="Currency">{(f) => <Input {...f} name="currency" value={v.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />}</Field>
              </>
            )}
            {quick && <p className="self-end text-xs text-fg-subtle sm:col-span-3">On-costs {v.onCostPct}% and overhead {v.overheadPct}% from the template.</p>}
          </div>
        </Card>

        {!quick && (
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold">Proposal</h2>
            <div className="grid grid-cols-1 gap-4">
              <Field label="Title" required>{(f) => <Input {...f} name="title" value={v.title} onChange={(e) => setV((cur) => ({ ...cur, title: e.target.value, titleTouched: true }))} maxLength={160} />}</Field>
              <Field label="Cover note">{(f) => <Textarea {...f} name="coverNote" rows={4} value={v.coverNote} onChange={(e) => set({ coverNote: e.target.value })} maxLength={4000} />}</Field>
              <Field label="Terms">{(f) => <Textarea {...f} name="terms" rows={5} value={v.terms} onChange={(e) => set({ terms: e.target.value })} maxLength={4000} />}</Field>
              <Field label="Valid until" hint="Left empty, set from the template when the proposal is sent">{(f) => <Input {...f} name="validUntil" type="date" value={v.validUntil} onChange={(e) => set({ validUntil: e.target.value })} className="sm:w-56" />}</Field>
            </div>
          </Card>
        )}
      </div>

      <aside className="xl:sticky xl:top-4 xl:self-start" aria-label="Bid summary">
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{v.title || 'New bid'}</h2>
          <p className="mt-0.5 text-xs text-fg-subtle">{client ? client.name : 'No client yet'} · {v.durationMonths || '?'} months from {v.startDate || '?'}</p>
          {pricing ? (
            <dl className="mt-4 space-y-2 text-[0.8125rem]">
              <Row label="People" value={String(pricing.headcount)} />
              <Row label="Monthly billing" value={money(pricing.monthlyRevenue)} />
              <Row label="Monthly cost" value={money(pricing.monthlyCost)} />
              <Row label="Monthly margin" value={money(pricing.monthlyMargin)} />
              <div className="border-t border-border pt-2" />
              <Row label="Contract value" value={money(pricing.contractRevenue)} strong />
              <Row label="Contract margin" value={money(pricing.contractMargin)} />
              <div className="flex items-center justify-between pt-1">
                <dt className="text-fg-muted">Margin</dt>
                <dd><Badge tone={pricing.lossMaking ? 'danger' : pricing.belowTarget ? 'warning' : 'success'}>{pricing.marginPct}% (target {v.targetMarginPct}%)</Badge></dd>
              </div>
            </dl>
          ) : (
            <p className="mt-4 text-[0.8125rem] text-fg-muted">{problem ?? 'Enter the role and pay to see the price.'}</p>
          )}
          {pricing?.lossMaking && <Alert tone="danger" className="mt-3">This bid costs more than it earns.</Alert>}
          <p className="mt-4 text-xs text-fg-subtle">Costs and margins stay inside CREW. The client&apos;s proposal shows roles, rates and totals only. Every bid is approved by Finance before it can be sent.</p>
          {showProblem && problem && <p className="mt-3 text-xs text-danger" role="alert">{problem}</p>}
          <div className="mt-4 flex flex-col gap-2">
            <Button onClick={() => save(true)} loading={pending}>Save and submit for approval</Button>
            <Button variant="secondary" onClick={() => save(false)} disabled={pending}>Save draft</Button>
          </div>
        </Card>
      </aside>
      <NewClientDialog open={clientOpen} onClose={() => setClientOpen(false)} onCreated={(c) => { setClients((all) => [...all, c].sort((a, b) => a.name.localeCompare(b.name))); set({ clientId: c.id, currency: c.currency }); }} />
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-fg-muted">{label}</dt>
      <dd className={cn('tabular-nums', strong && 'text-base font-semibold')}>{value}</dd>
    </div>
  );
}

export function NewClientDialog({ open, onClose, onCreated, client }: { open: boolean; onClose: () => void; onCreated: (c: Client) => void; client?: Client | null }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={client ? `Edit ${client.name}` : 'New client'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="client-form" loading={pending}>{client ? 'Save client' : 'Add client'}</Button></>}
    >
      <form
        key={client?.id ?? 'new'}
        id="client-form"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const body: Record<string, string> = {};
          for (const k of ['name', 'legalName', 'industry', 'contactName', 'contactEmail', 'contactPhone', 'address', 'currency', 'notes']) {
            const x = String(f.get(k) ?? '').trim();
            if (x) body[k] = x;
          }
          setError(null);
          start(async () => {
            const r = await saveClientAction(client?.id ?? null, body as never);
            if (r.ok && r.data) { onCreated(r.data); onClose(); } else if (!r.ok) { setError(r.message); setFe(r.fieldErrors ?? {}); }
          });
        }}
      >
        {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}
        <Field label="Client name" required error={fe.name}>{(f) => <Input {...f} name="name" defaultValue={client?.name} required maxLength={120} />}</Field>
        <Field label="Legal name" error={fe.legalName}>{(f) => <Input {...f} name="legalName" defaultValue={client?.legalName ?? ''} maxLength={200} />}</Field>
        <Field label="Contact person" error={fe.contactName}>{(f) => <Input {...f} name="contactName" defaultValue={client?.contactName ?? ''} maxLength={120} />}</Field>
        <Field label="Contact email" error={fe.contactEmail}>{(f) => <Input {...f} name="contactEmail" type="email" defaultValue={client?.contactEmail ?? ''} />}</Field>
        <Field label="Phone" error={fe.contactPhone}>{(f) => <Input {...f} name="contactPhone" defaultValue={client?.contactPhone ?? ''} maxLength={30} />}</Field>
        <Field label="Industry" error={fe.industry}>{(f) => <Input {...f} name="industry" defaultValue={client?.industry ?? ''} maxLength={80} />}</Field>
        <Field label="Currency" error={fe.currency}>{(f) => <Input {...f} name="currency" defaultValue={client?.currency ?? 'INR'} maxLength={3} />}</Field>
        <Field label="Address" error={fe.address} className="sm:col-span-2">{(f) => <Textarea {...f} name="address" rows={2} defaultValue={client?.address ?? ''} maxLength={500} />}</Field>
        <Field label="Notes" error={fe.notes} className="sm:col-span-2">{(f) => <Textarea {...f} name="notes" rows={2} defaultValue={client?.notes ?? ''} maxLength={1000} />}</Field>
      </form>
    </Dialog>
  );
}
