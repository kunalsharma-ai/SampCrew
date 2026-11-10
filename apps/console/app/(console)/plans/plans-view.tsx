'use client';
import { FEATURES, isCoreFeature, isPlannedFeature, PLAN_KEY_PATTERN, planPriceUpdate } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Switch, Table, TBody, TD, Textarea, TH, THead, TR, cn } from '@crew/ui';
import { Archive, Hourglass, Inbox, Layers, Pencil, Plus, RotateCcw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { archivePlanAction, createPlanAction, decidePlanRequestAction, deletePlanAction, setPlanBillingAction, setPlanEntitlementsAction, setPriceAction, updatePlanAction } from '../actions';

export interface PlatformPlan {
  id: string; key: string; name: string; tagline: string; quoteOnly: boolean; minimumSeats: number; isPublic: boolean; sortOrder: number;
  tenants: number; activeTenants: number; pendingRequests: number; customisedAt: string | null; customisedBy: string | null; archivedAt: string | null;
  prices: { currency: string; monthly: string; annualPerMonth: string }[];
  features: { key: string; limitValue: number | null }[];
  trialDays: number; trialFeatures: string[]; overage: Record<string, { policy: string; prices: Record<string, string> }>;
}
export interface PlanRequest {
  id: string; tenantId: string; tenantName: string; planKey: string; planName: string; currentPlanKey: string | null; currentPlanName: string | null;
  seats: number; billingCycle: string; message: string | null; status: string; requestedBy: string; createdAt: string;
  decisionNote: string | null; decidedAt: string | null; decidedBy: string | null;
}

type Def = { key: string; name: string; module: string; kind: 'boolean' | 'limit'; unit?: string };
const DEFS = FEATURES as readonly Def[];
const MODULES = DEFS.filter((f) => f.kind === 'boolean');
const LIMITS = DEFS.filter((f) => f.kind === 'limit');
const LAUNCH = new Set(['starter', 'professional', 'business', 'enterprise']);
const nameOf = (key: string) => DEFS.find((f) => f.key === key)?.name ?? key;
const limitText = (v: number | null | undefined, unit?: string) => (v === null || v === undefined ? 'Not set' : v === -1 ? 'Unlimited' : `${v.toLocaleString()}${unit ? ` ${unit}` : ''}`);
const groups = () => {
  const out = new Map<string, Def[]>();
  for (const f of MODULES) out.set(f.module, [...(out.get(f.module) ?? []), f]);
  return [...out.entries()];
};

export function PlansView({ plans, requests, canEdit }: { plans: PlatformPlan[]; requests: PlanRequest[]; canEdit: boolean }) {
  const router = useRouter();
  const [price, setPrice] = useState<{ plan: PlatformPlan; currency: 'USD' | 'INR' } | null>(null);
  const [contents, setContents] = useState<PlatformPlan | null>(null);
  const [details, setDetails] = useState<PlatformPlan | null>(null);
  const [billing, setBilling] = useState<PlatformPlan | null>(null);
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const done = (r: { ok: boolean; message?: string }, fallback?: string) => {
    setNote(r.ok ? { tone: 'success', text: r.message ?? fallback ?? 'Saved.' } : { tone: 'danger', text: r.message ?? 'Something went wrong' });
    if (r.ok) router.refresh();
  };

  return (
    <div className="grid gap-4">
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <RequestsCard requests={requests} canEdit={canEdit} onDone={done} />
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Plans</h2>
        {canEdit && <Button size="sm" onClick={() => setCreating(true)} data-testid="plan-create"><Plus className="size-3.5" />New plan</Button>}
      </div>
      {plans.map((p) => {
        const included = new Set(p.features.filter((f) => f.limitValue === null).map((f) => f.key));
        return (
          <Card key={p.key} data-testid={`plan-${p.key}`}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {p.name}
                  <code className="text-xs font-normal text-fg-subtle">{p.key}</code>
                  {p.quoteOnly && <Badge>Quote only</Badge>}
                  {!p.isPublic && <Badge tone="warning">Hidden from workspaces</Badge>}
                  {p.archivedAt && <Badge tone="danger">Archived</Badge>}
                  {p.pendingRequests > 0 && <Badge tone="accent">{p.pendingRequests} request(s)</Badge>}
                </span>
              }
              description={`${p.tagline ? `${p.tagline} · ` : ''}minimum ${p.minimumSeats} seats · ${p.trialDays > 0 ? `${p.trialDays}-day trial · ` : ''}${Object.values(p.overage).some((o) => o.policy === 'overage') ? 'bills overage · ' : ''}${p.tenants} workspace(s)${p.customisedAt ? ` · contents set in the Console${p.customisedBy ? ` by ${p.customisedBy}` : ''}` : ' · launch defaults'}`}
              action={canEdit ? (
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={() => setContents(p)} data-testid={`plan-edit-contents-${p.key}`}><SlidersHorizontal className="size-3.5" />Modules & limits</Button>
                  <Button size="sm" variant="secondary" onClick={() => setDetails(p)} data-testid={`plan-edit-details-${p.key}`}><Pencil className="size-3.5" />Details</Button>
                  <Button size="sm" variant="secondary" onClick={() => setBilling(p)} data-testid={`plan-edit-billing-${p.key}`}><Hourglass className="size-3.5" />Trial & overage</Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
                    if (!p.archivedAt && !confirm(`Stop offering ${p.name}? The ${p.tenants} workspace(s) on it keep it until they change plan, and open requests for it are declined.`)) return;
                    start(async () => { const r = await archivePlanAction(p.key, !p.archivedAt); done(r, r.ok ? r.data?.note : undefined); });
                  }} data-testid={`plan-archive-${p.key}`}>{p.archivedAt ? <><RotateCcw className="size-3.5" />Restore</> : <><Archive className="size-3.5" />Archive</>}</Button>
                  {!LAUNCH.has(p.key) && p.tenants === 0 && (
                    <Button size="sm" variant="ghost" aria-label={`Delete ${p.name}`} disabled={pending} onClick={() => {
                      if (!confirm(`Delete ${p.name}? This cannot be undone.`)) return;
                      start(async () => done(await deletePlanAction(p.key)));
                    }}><Trash2 className="size-3.5" /></Button>
                  )}
                </div>
              ) : undefined}
            />
            <CardBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="grid content-start gap-3">
                <Table aria-label={`${p.name} prices`}>
                  <THead><TR><TH>Currency</TH><TH className="text-right">Monthly / seat</TH><TH className="text-right">Annual / seat / month</TH>{canEdit && <TH />}</TR></THead>
                  <TBody>
                    {(['USD', 'INR'] as const).map((c) => {
                      const pr = p.prices.find((x) => x.currency === c);
                      return (
                        <TR key={c}>
                          <TD>{c}</TD>
                          <TD className="text-right tabular">{pr?.monthly ?? '—'}</TD>
                          <TD className="text-right tabular">{pr?.annualPerMonth ?? '—'}</TD>
                          {canEdit && <TD className="text-right"><Button size="sm" variant="ghost" aria-label={`Edit ${p.name} ${c} price`} onClick={() => setPrice({ plan: p, currency: c })}><Pencil className="size-3.5" /></Button></TD>}
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem]">
                  {LIMITS.map((l) => (
                    <div key={l.key} className="contents">
                      <dt className="text-fg-subtle">{l.name}</dt>
                      <dd className="text-right tabular" data-testid={`plan-${p.key}-limit-${l.key}`}>{limitText(p.features.find((f) => f.key === l.key)?.limitValue, l.unit)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div>
                <div className="mb-2 text-xs text-fg-subtle">{included.size} of {MODULES.length} modules included</div>
                <div className="flex flex-wrap content-start gap-1.5" data-testid={`plan-${p.key}-modules`}>
                  {MODULES.map((f) => (
                    <Badge key={f.key} tone={included.has(f.key) ? 'accent' : 'neutral'} className={cn(!included.has(f.key) && 'line-through')}>
                      {f.name}
                    </Badge>
                  ))}
                </div>
              </div>
            </CardBody>
          </Card>
        );
      })}
      {price && <PriceDialog {...price} onClose={() => setPrice(null)} onSaved={(n) => { setNote({ tone: 'success', text: n }); setPrice(null); }} />}
      {contents && <ContentsDialog plan={contents} onClose={() => setContents(null)} onSaved={(t) => { setNote({ tone: 'success', text: t }); setContents(null); router.refresh(); }} />}
      {billing && <BillingDialog plan={billing} onClose={() => setBilling(null)} onSaved={(t) => { setNote({ tone: 'success', text: t }); setBilling(null); router.refresh(); }} />}
      {details && <DetailsDialog plan={details} onClose={() => setDetails(null)} onSaved={(t) => { setNote({ tone: 'success', text: t }); setDetails(null); router.refresh(); }} />}
      {creating && <CreateDialog plans={plans} onClose={() => setCreating(false)} onSaved={(t, key) => { setNote({ tone: 'success', text: t }); setCreating(false); router.refresh(); const p = plans.find((x) => x.key === key); if (p) setContents(p); }} />}
    </div>
  );
}

/** Workspace admins ask for a quote-only plan from Plan & billing; approving applies it to their subscription. */
function RequestsCard({ requests, canEdit, onDone }: { requests: PlanRequest[]; canEdit: boolean; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [pending, start] = useTransition();
  const open = requests.filter((r) => r.status === 'pending');
  const recent = requests.filter((r) => r.status !== 'pending').slice(0, 5);
  return (
    <Card data-testid="plan-requests">
      <CardHeader title="Plan requests" description="Workspace admins ask here for a plan they cannot buy themselves, such as Enterprise. Approving moves the workspace onto the plan." />
      {open.length === 0 && recent.length === 0 ? (
        <EmptyState icon={<Inbox className="size-6" />} title="No plan requests" />
      ) : (
        <Table aria-label="Plan requests">
          <THead><TR><TH>Workspace</TH><TH>Request</TH><TH>Message</TH><TH>Status</TH>{canEdit && <TH />}</TR></THead>
          <TBody>
            {[...open, ...recent].map((r) => (
              <TR key={r.id} data-testid={`plan-request-${r.id}`}>
                <TD><div className="font-medium text-fg">{r.tenantName}</div><div className="text-xs text-fg-subtle">by {r.requestedBy} · {new Date(r.createdAt).toLocaleDateString()}</div></TD>
                <TD>{r.currentPlanName ?? '—'} → <strong>{r.planName}</strong><div className="text-xs text-fg-subtle">{r.seats} seats · {r.billingCycle}</div></TD>
                <TD className="max-w-xs whitespace-pre-wrap text-xs">{r.message ?? '—'}</TD>
                <TD><Badge tone={r.status === 'pending' ? 'accent' : r.status === 'approved' ? 'success' : 'neutral'}>{r.status}</Badge>{r.decisionNote && <div className="mt-1 text-xs text-fg-subtle">{r.decisionNote}</div>}</TD>
                {canEdit && (
                  <TD className="text-right">
                    {r.status === 'pending' && (
                      <span className="inline-flex gap-1.5">
                        <Button size="sm" disabled={pending} onClick={() => {
                          if (!confirm(`Move ${r.tenantName} to ${r.planName} with ${r.seats} seats now?`)) return;
                          start(async () => onDone(await decidePlanRequestAction(r.id, 'approved')));
                        }} data-testid={`plan-request-approve-${r.id}`}>Approve</Button>
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
                          const why = prompt('Reason shown to the workspace admin (optional)') ?? undefined;
                          start(async () => onDone(await decidePlanRequestAction(r.id, 'declined', why)));
                        }}>Decline</Button>
                      </span>
                    )}
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

/** The plan builder: which modules a plan includes and its limits. */
function ContentsDialog({ plan, onClose, onSaved }: { plan: PlatformPlan; onClose: () => void; onSaved: (text: string) => void }) {
  const [on, setOn] = useState<Set<string>>(() => new Set(plan.features.filter((f) => f.limitValue === null).map((f) => f.key)));
  const [limits, setLimits] = useState<Record<string, string>>(() => Object.fromEntries(LIMITS.map((l) => [l.key, String(plan.features.find((f) => f.key === l.key)?.limitValue ?? 0)])));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const before = useMemo(() => new Set(plan.features.filter((f) => f.limitValue === null).map((f) => f.key)), [plan]);
  const removed = [...before].filter((k) => !on.has(k));
  const added = [...on].filter((k) => !before.has(k));
  const toggle = (key: string, next: boolean) => setOn((s) => { const n = new Set(s); if (next) n.add(key); else n.delete(key); return n; });
  const limitErrors = Object.fromEntries(Object.entries(limits).filter(([, v]) => !/^-?\d+$/.test(v.trim()) || Number(v) < -1).map(([k]) => [k, 'A whole number, or -1 for unlimited']));

  const save = () => {
    if (Object.keys(limitErrors).length) return;
    if (removed.length && plan.activeTenants > 0 && !confirm(`${removed.map(nameOf).join(', ')} will stop working at once for the ${plan.activeTenants} workspace(s) on ${plan.name}. Their data is kept. Continue?`)) return;
    start(async () => {
      const r = await setPlanEntitlementsAction(plan.key, { features: [...on], limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, Number(v)])) });
      if (!r.ok) { setError(r.message ?? 'Could not save'); return; }
      const d = r.data!;
      const parts = [d.added.length ? `added ${d.added.map(nameOf).join(', ')}` : '', d.removed.length ? `removed ${d.removed.map(nameOf).join(', ')}` : ''].filter(Boolean);
      onSaved(`${plan.name} saved${parts.length ? `: ${parts.join('; ')}` : ''}. Applies now to ${d.workspaces} workspace(s).`);
    });
  };

  return (
    <Dialog open onClose={onClose} size="lg" title={`${plan.name}: modules and limits`}
      description="Switch on what this plan includes. Workspaces on the plan get the change on their next page load; data in a module that is switched off is kept."
      footer={<><span className="mr-auto text-xs text-fg-subtle">{added.length} added · {removed.length} removed</span><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save} data-testid="plan-contents-save">Save plan</Button></>}>
      <div className="grid gap-5">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setOn(new Set(MODULES.map((f) => f.key)))}>Include all</Button>
          <Button size="sm" variant="ghost" onClick={() => setOn(new Set(MODULES.filter((f) => isCoreFeature(f.key)).map((f) => f.key)))}>Foundation only</Button>
        </div>
        {groups().map(([group, defs]) => (
          <section key={group}>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{group}</h3>
            <ul className="grid gap-1">
              {defs.map((f) => {
                const core = isCoreFeature(f.key);
                return (
                  <li key={f.key} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-bg-subtle" data-testid={`plan-module-${f.key}`}>
                    <span>
                      <span className="text-[0.8125rem] font-medium text-fg">{f.name}</span>
                      <span className="ml-2 text-xs text-fg-subtle"><code>{f.key}</code>{core && ' · always included'}{isPlannedFeature(f.key) && ' · commercial entitlement, no in-app function yet'}</span>
                    </span>
                    <Switch checked={core || on.has(f.key)} disabled={core} label={`${f.name} included in ${plan.name}`} testId={`plan-switch-${f.key}`} onChange={(next) => toggle(f.key, next)} />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <section>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Limits</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {LIMITS.map((l) => (
              <Field key={l.key} label={`${l.name}${l.unit ? ` (${l.unit})` : ''}`} hint="-1 means unlimited" error={limitErrors[l.key]}>
                {(p) => (
                  <div className="flex items-center gap-2">
                    <Input {...p} inputMode="numeric" value={limits[l.key]} onChange={(e) => setLimits((s) => ({ ...s, [l.key]: e.target.value }))} data-testid={`plan-limit-${l.key}`} />
                    <Checkbox label="Unlimited" checked={limits[l.key] === '-1'} onChange={(e) => setLimits((s) => ({ ...s, [l.key]: e.target.checked ? '-1' : '0' }))} />
                  </div>
                )}
              </Field>
            ))}
          </div>
        </section>
      </div>
    </Dialog>
  );
}

function DetailsDialog({ plan, onClose, onSaved }: { plan: PlatformPlan; onClose: () => void; onSaved: (text: string) => void }) {
  const [name, setName] = useState(plan.name);
  const [tagline, setTagline] = useState(plan.tagline);
  const [seats, setSeats] = useState(String(plan.minimumSeats));
  const [order, setOrder] = useState(String(plan.sortOrder));
  const [quoteOnly, setQuoteOnly] = useState(plan.quoteOnly);
  const [isPublic, setIsPublic] = useState(plan.isPublic);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={`${plan.name}: details`} description="How the plan is shown to workspace admins on Plan & billing."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => start(async () => {
        const r = await updatePlanAction(plan.key, { name: name.trim(), tagline: tagline.trim(), minimumSeats: Number(seats), sortOrder: Number(order), quoteOnly, isPublic });
        if (!r.ok) setError(r.message ?? 'Could not save'); else onSaved(r.message ?? 'Saved.');
      })}>Save details</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name" required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Tagline">{(p) => <Textarea {...p} rows={2} value={tagline} onChange={(e) => setTagline(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum seats">{(p) => <Input {...p} type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} />}</Field>
          <Field label="Order on Plan & billing">{(p) => <Input {...p} type="number" min={0} value={order} onChange={(e) => setOrder(e.target.value)} />}</Field>
        </div>
        <Checkbox label="Quote only" description="Workspace admins send SAMPLEDGE a request instead of buying it straight away." checked={quoteOnly} onChange={(e) => setQuoteOnly(e.target.checked)} />
        <Checkbox label="Visible to workspace admins" description="Hidden plans can only be given to a workspace from the Console." checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
      </div>
    </Dialog>
  );
}

function CreateDialog({ plans, onClose, onSaved }: { plans: PlatformPlan[]; onClose: () => void; onSaved: (text: string, key: string) => void }) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [copyFrom, setCopyFrom] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const slug = (keyTouched ? key : name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'p_$1')).slice(0, 40);
  const keyError = slug && !PLAN_KEY_PATTERN.test(slug) ? 'Lower-case letters, digits and underscores, starting with a letter' : plans.some((p) => p.key === slug) ? 'A plan with this key exists' : undefined;
  return (
    <Dialog open onClose={onClose} title="New plan" description="Start from a copy of a plan (its modules, limits and prices) or from the foundation only. New plans are hidden until you make them visible."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!name.trim() || !slug || Boolean(keyError)} onClick={() => start(async () => {
        const r = await createPlanAction({ key: slug, name: name.trim(), copyFrom: copyFrom || undefined, isPublic });
        if (!r.ok) setError(r.message ?? 'Could not create the plan'); else onSaved(r.message ?? 'Plan created.', slug);
      })} data-testid="plan-create-save">Create plan</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name" required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Retail Growth" data-testid="plan-create-name" />}</Field>
        <Field label="Key" hint="Used by the API; cannot be changed later" error={keyError}>{(p) => <Input {...p} value={slug} onChange={(e) => { setKeyTouched(true); setKey(e.target.value); }} />}</Field>
        <Field label="Start from">{(p) => (
          <Select {...p} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} data-testid="plan-create-copy">
            <option value="">Foundation only (Core HR, every limit 0)</option>
            {plans.filter((x) => !x.archivedAt).map((x) => <option key={x.key} value={x.key}>A copy of {x.name}</option>)}
          </Select>
        )}</Field>
        <Checkbox label="Visible to workspace admins now" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
        <p className="flex items-center gap-2 text-xs text-fg-subtle"><Layers className="size-3.5" />After creating it, choose its modules and limits.</p>
      </div>
    </Dialog>
  );
}

function PriceDialog({ plan, currency, onClose, onSaved }: { plan: PlatformPlan; currency: 'USD' | 'INR'; onClose: () => void; onSaved: (note: string) => void }) {
  const router = useRouter();
  const cur = plan.prices.find((x) => x.currency === currency);
  const [monthly, setMonthly] = useState(cur?.monthly ?? '');
  const [annual, setAnnual] = useState(cur?.annualPerMonth ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={`${plan.name} price in ${currency}`} description="Applies to new subscriptions and plan changes. Existing customers keep their price until renewal."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => {
        const parsed = planPriceUpdate.safeParse({ currency, monthly: monthly.trim(), annualPerMonth: annual.trim() });
        if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), 'Use a number with up to 2 decimals']))); return; }
        start(async () => {
          const r = await setPriceAction(plan.key, parsed.data);
          if (!r.ok) setError(r.message);
          else { onSaved(r.data!.note); router.refresh(); }
        });
      }}>Save price</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}
        <Field label="Monthly, per seat" error={errors.monthly}>{(p) => <Input {...p} inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} />}</Field>
        <Field label="Annual, per seat per month" error={errors.annualPerMonth}>{(p) => <Input {...p} inputMode="decimal" value={annual} onChange={(e) => setAnnual(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

const OVERAGE_LIMITS = [
  { key: 'max_employees', name: 'Employees', unit: 'person' },
  { key: 'ai_credits_monthly', name: 'AI credits per month', unit: 'credit' },
  { key: 'storage_gb', name: 'Storage', unit: 'GB' },
] as const;

/** A plan's free trial and what happens beyond each limit: stop the workspace, or let it go on and bill the extra. */
function BillingDialog({ plan, onClose, onSaved }: { plan: PlatformPlan; onClose: () => void; onSaved: (text: string) => void }) {
  const included = MODULES.filter((m) => plan.features.some((f) => f.key === m.key && f.limitValue === null) && !isCoreFeature(m.key));
  const [days, setDays] = useState(String(plan.trialDays));
  const [whole, setWhole] = useState(plan.trialFeatures.length === 0);
  const [trialFeatures, setTrialFeatures] = useState<Set<string>>(new Set(plan.trialFeatures));
  const [overage, setOverage] = useState(() => Object.fromEntries(OVERAGE_LIMITS.map((l) => {
    const o = plan.overage[l.key];
    return [l.key, { policy: o?.policy ?? 'block', INR: o?.prices?.INR ?? '', USD: o?.prices?.USD ?? '' }];
  })) as Record<string, { policy: string; INR: string; USD: string }>);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const body = {
      trialDays: Number(days),
      trialFeatures: whole ? [] : [...trialFeatures],
      overage: Object.fromEntries(OVERAGE_LIMITS.map((l) => {
        const o = overage[l.key]!;
        const prices = Object.fromEntries((['INR', 'USD'] as const).filter((c) => o[c].trim()).map((c) => [c, o[c].trim()]));
        return [l.key, { policy: o.policy, prices }];
      })),
    };
    const r = await setPlanBillingAction(plan.key, body);
    if (!r.ok) { setError(r.message); setErrors(r.fieldErrors ?? {}); } else onSaved(r.message ?? 'Saved.');
  });
  return (
    <Dialog open onClose={onClose} size="lg" title={`${plan.name}: trial and overage`} description="A workspace can try this plan free once. Beyond a limit, the workspace is either stopped or billed for the extra at the end of its period."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save} data-testid="plan-billing-save">Save</Button></>}>
      <div className="grid gap-5">
        {error && <Alert tone="danger">{error}</Alert>}
        <section className="grid gap-3">
          <h3 className="text-[0.8125rem] font-semibold">Free trial</h3>
          <Field label="Trial days" hint="0 means no trial. Up to 90." error={errors.trialDays}>{(p) => <Input {...p} type="number" min={0} max={90} value={days} onChange={(e) => setDays(e.target.value)} data-testid="plan-trial-days" />}</Field>
          {Number(days) > 0 && (
            <>
              <Checkbox label="The whole plan during the trial" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
              {!whole && (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {included.map((m) => (
                    <Checkbox key={m.key} label={m.name} checked={trialFeatures.has(m.key)} onChange={(e) => setTrialFeatures((prev) => { const n = new Set(prev); if (e.target.checked) n.add(m.key); else n.delete(m.key); return n; })} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
        <section className="grid gap-3">
          <h3 className="text-[0.8125rem] font-semibold">Beyond a limit</h3>
          {OVERAGE_LIMITS.map((l) => {
            const o = overage[l.key]!;
            const set = (patch: Partial<typeof o>) => setOverage({ ...overage, [l.key]: { ...o, ...patch } });
            return (
              <div key={l.key} className="grid items-end gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
                <Field label={l.name} error={errors[`overage.${l.key}.prices`]}>{(p) => (
                  <Select {...p} value={o.policy} onChange={(e) => set({ policy: e.target.value })} data-testid={`overage-${l.key}`}>
                    <option value="block">Stop at the limit</option>
                    <option value="overage">Go on and bill the extra</option>
                  </Select>
                )}</Field>
                {o.policy === 'overage' && (['INR', 'USD'] as const).map((c) => (
                  <Field key={c} label={`${c} per extra ${l.unit}`}>{(p) => <Input {...p} inputMode="decimal" value={o[c]} onChange={(e) => set({ [c]: e.target.value })} data-testid={`overage-${l.key}-${c}`} />}</Field>
                ))}
              </div>
            );
          })}
        </section>
      </div>
    </Dialog>
  );
}
