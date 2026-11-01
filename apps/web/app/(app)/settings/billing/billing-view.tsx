'use client';
import { FEATURES } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import { Check, FileText } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { changePlanAction } from '../actions';

export interface Plan { id: string; key: string; name: string; tagline: string; quoteOnly: boolean; minimumSeats: number; prices: { currency: string; monthly: string; annualPerMonth: string }[]; features: string[]; limits: Record<string, number> }
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

export function BillingView({ plans, info, invoices, canManage }: { plans: Plan[]; info: SubscriptionInfo; invoices: Invoice[]; canManage: boolean }) {
  const sub = info.subscription;
  const current = plans.find((p) => p.key === sub?.planKey);
  const [target, setTarget] = useState<Plan | null>(null);

  return (
    <div className="grid gap-6">
      {!info.paymentProvider.connected && <Alert tone="info">{info.paymentProvider.note}</Alert>}
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
              <Card key={p.key} className={cn('flex flex-col', isCurrent && 'ring-2 ring-accent')}>
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
                    {p.quoteOnly ? <p className="text-xs text-fg-subtle">Contact SAMPLEDGE sales for Enterprise pricing.</p>
                      : canManage ? <Button className="w-full" variant={isCurrent ? 'secondary' : 'primary'} onClick={() => setTarget(p)}>{isCurrent ? 'Change seats or cycle' : 'Switch to this plan'}</Button>
                      : null}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      </div>

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
