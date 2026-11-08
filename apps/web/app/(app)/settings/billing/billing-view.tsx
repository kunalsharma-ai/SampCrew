'use client';
import { FEATURES, isCoreFeature, isPlannedFeature } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Select, Stat, Table, TBody, TD, Textarea, TH, THead, TR, cn } from '@crew/ui';
import { Check, FileText, Minus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { changePlanAction, requestPlanAction, withdrawPlanRequestAction } from '../actions';

export interface Plan { id: string; key: string; name: string; tagline: string; quoteOnly: boolean; minimumSeats: number; offered: boolean; prices: { currency: string; monthly: string; annualPerMonth: string }[]; features: string[]; limits: Record<string, number> }
export interface PlanRequest { id: string; planKey: string; planName: string; seats: number; billingCycle: string; message: string | null; status: string; requestedBy: string; createdAt: string; decisionNote: string | null; decidedAt: string | null }
export interface SubscriptionInfo {
  subscription: { planKey: string; planName: string; status: string; billingCycle: string; currency: string; seats: number; unitPrice: string; trialEndsOn: string | null; currentPeriodEnd: string | null; periodAmount: string; provider: string } | null;
  usage: { members: number; legalEntities: number; aiCreditsThisMonth: number };
  paymentProvider: { connected: boolean; note: string };
}
export interface Invoice { id: string; number: string | null; status: string; currency: string; subtotal: string; tax: string; total: string; periodStart: string; periodEnd: string; issuedAt: string | null; dueAt: string | null; paidAt: string | null }

const money = (amount: string | number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount));
const limit = (n: number | undefined) => (n === undefined ? '—' : n === -1 ? 'Unlimited' : n.toLocaleString());
const capacity = (n: number | undefined, one: string, many: string) => (n === undefined ? `No ${many}` : n === -1 ? `Unlimited ${many}` : `Up to ${n.toLocaleString()} ${n === 1 ? one : many}`);
const featureName = (key: string) => (FEATURES as readonly { key: string; name: string }[]).find((f) => f.key === key)?.name ?? key;
type Def = { key: string; name: string; module: string; kind: string; unit?: string };
const MODULES = (FEATURES as readonly Def[]).filter((f) => f.kind === 'boolean');
const LIMITS = (FEATURES as readonly Def[]).filter((f) => f.kind === 'limit');

export function BillingView({ plans, info, invoices, requests, features, canManage }: { plans: Plan[]; info: SubscriptionInfo; invoices: Invoice[]; requests: PlanRequest[]; features: string[]; canManage: boolean }) {
  const sub = info.subscription;
  const current = plans.find((p) => p.key === sub?.planKey);
  const [target, setTarget] = useState<Plan | null>(null);
  const [asking, setAsking] = useState<Plan | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const open = requests.find((r) => r.status === 'pending');
  const lastAnswered = requests.find((r) => r.status === 'approved' || r.status === 'declined');
  // Modules the plan includes that SAMPLEDGE switched off for this workspace, so the admin knows why they are missing.
  const switchedOff = (current?.features ?? []).filter((k) => !isCoreFeature(k) && !isPlannedFeature(k) && !features.includes(k));

  return (
    <div className="grid gap-6">
      {!info.paymentProvider.connected && <Alert tone="info">{info.paymentProvider.note}</Alert>}
      {note && <Alert tone="success">{note}</Alert>}
      {current && !current.offered && <Alert tone="warning">Your plan, {current.name}, is no longer offered to new customers. You keep everything in it until you move to another plan.</Alert>}
      {open && (
        <Alert tone="info" title={`Request for ${open.planName} sent to SAMPLEDGE`}>
          {open.seats} seats, billed {open.billingCycle}, sent by {open.requestedBy} on {new Date(open.createdAt).toLocaleDateString()}. You will get a notification when SAMPLEDGE answers.
          {canManage && <> <button type="button" className="ml-1 text-accent hover:underline" disabled={pending} onClick={() => start(async () => { const r = await withdrawPlanRequestAction(open.id); if (r.ok) { setNote('Request withdrawn.'); router.refresh(); } })}>Withdraw request</button></>}
        </Alert>
      )}
      {!open && lastAnswered?.status === 'declined' && <Alert tone="warning" title={`SAMPLEDGE declined the request for ${lastAnswered.planName}`}>{lastAnswered.decisionNote ?? 'Contact SAMPLEDGE sales to discuss it.'}</Alert>}
      {switchedOff.length > 0 && <Alert tone="warning" title="Switched off by SAMPLEDGE">Your plan includes {switchedOff.map(featureName).join(', ')}, but SAMPLEDGE has switched {switchedOff.length === 1 ? 'it' : 'them'} off for your workspace or for some apps. Contact SAMPLEDGE support to turn {switchedOff.length === 1 ? 'it' : 'them'} back on.</Alert>}
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Plan" value={sub?.planName ?? 'None'} hint={sub ? <Badge tone={sub.status === 'active' ? 'success' : sub.status === 'trialing' ? 'accent' : 'warning'}>{sub.status}</Badge> : undefined} />
        <Stat label="Seats used" value={`${info.usage.members} / ${sub?.seats ?? 0}`} hint={`Plan limit: ${limit(current?.limits.max_employees)}`} />
        <Stat label="Legal entities" value={info.usage.legalEntities} hint={`Plan limit: ${limit(current?.limits.max_legal_entities)}`} />
        <Stat label={sub?.billingCycle === 'annual' ? 'Per year' : 'Per month'} value={sub ? money(sub.periodAmount, sub.currency) : '—'} hint={sub ? `${money(sub.unitPrice, sub.currency)} per seat per month${sub.trialEndsOn ? ` · trial ends ${sub.trialEndsOn}` : ''}` : undefined} />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold">Plans</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((p) => {
            const price = p.prices.find((x) => x.currency === (sub?.currency ?? 'USD')) ?? p.prices[0];
            const isCurrent = p.key === sub?.planKey;
            return (
              <Card key={p.key} className={cn('flex flex-col', isCurrent && 'ring-2 ring-accent')} data-testid={`billing-plan-${p.key}`} data-current={isCurrent ? 'true' : undefined}>
                <CardHeader title={p.name} description={p.tagline} action={isCurrent ? <Badge tone="accent">Current</Badge> : undefined} />
                <CardBody className="flex flex-1 flex-col gap-4">
                  <div>
                    {p.quoteOnly || !price ? <div className="text-xl font-semibold">Custom quote</div> : (
                      <>
                        <div className="text-xl font-semibold tabular">{money(price.monthly, price.currency)}</div>
                        <div className="text-xs text-fg-subtle">per seat per month, or {money(price.annualPerMonth, price.currency)} billed annually</div>
                      </>
                    )}
                    {p.minimumSeats > 1 && <div className="mt-1 text-xs text-fg-subtle">Minimum {p.minimumSeats} seats</div>}
                  </div>
                  <ul className="grid gap-1.5 text-[0.8125rem]">
                    <li className="text-fg-muted">{capacity(p.limits.max_employees, 'person', 'people')}, {capacity(p.limits.max_legal_entities, 'legal entity', 'legal entities')}</li>
                    {p.features.slice(0, 8).map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 size-3.5 shrink-0 text-success" />{featureName(f)}</li>)}
                    {p.features.length > 8 && <li className="text-xs text-fg-subtle">and {p.features.length - 8} more</li>}
                  </ul>
                  <div className="mt-auto">
                    {p.quoteOnly ? (
                      isCurrent ? <p className="text-xs text-fg-subtle">Contact SAMPLEDGE to change seats on this plan.</p>
                        : canManage ? <Button className="w-full" variant="secondary" disabled={Boolean(open)} onClick={() => setAsking(p)} data-testid={`plan-request-${p.key}`}>{open?.planKey === p.key ? 'Request sent' : 'Request this plan'}</Button>
                        : <p className="text-xs text-fg-subtle">Sold by quotation. A workspace admin can request it.</p>
                    ) : canManage && (p.offered || isCurrent) ? <Button className="w-full" variant={isCurrent ? 'secondary' : 'primary'} onClick={() => setTarget(p)} data-testid={`plan-choose-${p.key}`}>{isCurrent ? 'Change seats or cycle' : 'Switch to this plan'}</Button>
                      : null}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      </div>

      <Card>
        <CardHeader title="Compare plans" description="Every module and limit in each plan. Your workspace can use only what your plan includes." />
        <div className="overflow-x-auto">
          <Table aria-label="Compare plans">
            <THead>
              <TR>
                <TH>Module</TH>
                {plans.map((p) => <TH key={p.key} className={cn('text-center', p.key === sub?.planKey && 'text-accent')}>{p.name}{p.key === sub?.planKey ? ' (yours)' : ''}</TH>)}
              </TR>
            </THead>
            <TBody>
              {MODULES.map((f) => (
                <TR key={f.key} data-testid={`compare-${f.key}`}>
                  <TD><div className="text-[0.8125rem] text-fg">{f.name}</div><div className="text-xs text-fg-subtle">{f.module}{isPlannedFeature(f.key) ? ' · agreed with SAMPLEDGE' : ''}</div></TD>
                  {plans.map((p) => (
                    <TD key={p.key} className={cn('text-center', p.key === sub?.planKey && 'bg-accent-subtle/40')}>
                      {p.features.includes(f.key)
                        ? <Check className="mx-auto size-4 text-success" aria-label={`Included in ${p.name}`} />
                        : <Minus className="mx-auto size-4 text-fg-subtle" aria-label={`Not in ${p.name}`} />}
                    </TD>
                  ))}
                </TR>
              ))}
              {LIMITS.map((l) => (
                <TR key={l.key}>
                  <TD className="text-[0.8125rem] text-fg">{l.name}</TD>
                  {plans.map((p) => <TD key={p.key} className={cn('text-center tabular text-[0.8125rem]', p.key === sub?.planKey && 'bg-accent-subtle/40')}>{limit(p.limits[l.key])}</TD>)}
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Invoices" description="Invoices are prepared and issued by SAMPLEDGE finance." />
        {invoices.length === 0 ? <EmptyState icon={<FileText className="size-6" />} title="No invoices yet" /> : (
          <Table>
            <THead><TR><TH>Number</TH><TH>Period</TH><TH>Status</TH><TH className="text-right">Total</TH></TR></THead>
            <TBody>
              {invoices.map((i) => (
                <TR key={i.id}>
                  <TD className="font-mono text-xs">{i.number ?? 'Draft'}</TD>
                  <TD>{i.periodStart} to {i.periodEnd}</TD>
                  <TD><Badge tone={i.status === 'paid' ? 'success' : i.status === 'draft' ? 'neutral' : 'warning'}>{i.status}</Badge></TD>
                  <TD className="text-right tabular">{money(i.total, i.currency)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {target && sub && <ChangePlanDialog plan={target} sub={sub} members={info.usage.members} onClose={() => setTarget(null)} />}
      {asking && sub && <RequestPlanDialog plan={asking} sub={sub} members={info.usage.members} onClose={() => setAsking(null)} onSent={(n) => { setNote(n); setAsking(null); router.refresh(); }} />}
    </div>
  );
}

function ChangePlanDialog({ plan, sub, members, onClose }: { plan: Plan; sub: NonNullable<SubscriptionInfo['subscription']>; members: number; onClose: () => void }) {
  const router = useRouter();
  const [cycle, setCycle] = useState(sub.billingCycle);
  const [currency, setCurrency] = useState(plan.prices.some((p) => p.currency === sub.currency) ? sub.currency : plan.prices[0]?.currency ?? 'USD');
  const [seats, setSeats] = useState(String(Math.max(sub.seats, plan.minimumSeats, members)));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const price = plan.prices.find((p) => p.currency === currency);
  const unit = price ? Number(cycle === 'annual' ? price.annualPerMonth : price.monthly) : 0;
  const n = Number(seats);
  const seatsError = !Number.isInteger(n) || n < 1 ? 'Enter a whole number of seats' : n < plan.minimumSeats ? `At least ${plan.minimumSeats} seats` : n < members ? `You have ${members} active members` : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${plan.name} plan`}
      description="Upgrades apply immediately. A downgrade is only allowed when your current usage fits the new plan."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={pending} disabled={Boolean(seatsError)} onClick={() => start(async () => {
            const r = await changePlanAction({ planKey: plan.key, billingCycle: cycle, seats: n, currency });
            if (!r.ok) setError(r.message);
            else { onClose(); router.refresh(); }
          })}>Confirm change</Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Billing cycle">{(p) => <Select {...p} value={cycle} onChange={(e) => setCycle(e.target.value)}><option value="monthly">Monthly</option><option value="annual">Annual</option></Select>}</Field>
          <Field label="Currency">{(p) => <Select {...p} value={currency} onChange={(e) => setCurrency(e.target.value)}>{plan.prices.map((x) => <option key={x.currency}>{x.currency}</option>)}</Select>}</Field>
        </div>
        <Field label="Seats" error={seatsError ?? undefined} required>{(p) => <Input {...p} type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} />}</Field>
        {!seatsError && price && (
          <div className="rounded-md bg-bg-subtle p-3 text-[0.8125rem]">
            {n} seats × {money(unit, currency)} per month = <strong className="tabular">{money(n * unit * (cycle === 'annual' ? 12 : 1), currency)}</strong> per {cycle === 'annual' ? 'year' : 'month'}, before tax. No card is charged here; SAMPLEDGE finance issues the invoice.
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Quote-only plans (such as Enterprise) are bought through SAMPLEDGE: the request appears in the Console, where it is approved. */
function RequestPlanDialog({ plan, sub, members, onClose, onSent }: { plan: Plan; sub: NonNullable<SubscriptionInfo['subscription']>; members: number; onClose: () => void; onSent: (note: string) => void }) {
  const [cycle, setCycle] = useState<'monthly' | 'annual'>(sub.billingCycle === 'monthly' ? 'monthly' : 'annual');
  const [seats, setSeats] = useState(String(Math.max(sub.seats, plan.minimumSeats, members)));
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const n = Number(seats);
  const seatsError = !Number.isInteger(n) || n < 1 ? 'Enter a whole number of seats' : n < plan.minimumSeats ? `At least ${plan.minimumSeats} seats` : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Request the ${plan.name} plan`}
      description={`${plan.name} is priced by quotation. SAMPLEDGE reviews your request, agrees the price with you and moves your workspace onto the plan.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={pending} disabled={Boolean(seatsError)} data-testid="plan-request-send" onClick={() => start(async () => {
            const r = await requestPlanAction({ planKey: plan.key, seats: n, billingCycle: cycle, message: message.trim() || undefined });
            if (!r.ok) setError(r.message);
            else onSent(r.data!.note);
          })}>Send request</Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Seats" error={seatsError ?? undefined} required>{(p) => <Input {...p} type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} />}</Field>
          <Field label="Billing cycle">{(p) => <Select {...p} value={cycle} onChange={(e) => setCycle(e.target.value as 'monthly' | 'annual')}><option value="annual">Annual</option><option value="monthly">Monthly</option></Select>}</Field>
        </div>
        <Field label="Message to SAMPLEDGE" hint="For example, the modules you need most or when you want to start">{(p) => <Textarea {...p} rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}
