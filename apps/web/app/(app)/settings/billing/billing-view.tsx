'use client';
import { FEATURES, GST_STATES, isCoreFeature, isPlannedFeature } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Select, Stat, Switch, Table, TBody, TD, Textarea, TH, THead, TR, cn } from '@crew/ui';
import { Check, CreditCard, Download, FileText, Lock, Minus, Package } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
  buyAddonAction, cancelScheduledChangeAction, changePlanAction, orderStatusAction, payInvoiceAction, quotePlanAction, removeAddonAction,
  requestPlanAction, saveBillingProfileAction, setAutoRenewAction, startTrialAction, withdrawPlanRequestAction, type ChangeResult,
} from '../actions';

export interface Plan {
  id: string; key: string; name: string; tagline: string; quoteOnly: boolean; minimumSeats: number; offered: boolean;
  prices: { currency: string; monthly: string; annualPerMonth: string }[]; features: string[]; limits: Record<string, number>;
  trialDays: number; trialFeatures: string[];
}
export interface PlanRequest { id: string; planKey: string; planName: string; seats: number; billingCycle: string; message: string | null; status: string; requestedBy: string; createdAt: string; decisionNote: string | null; decidedAt: string | null }
export interface SubscriptionInfo {
  subscription: {
    planKey: string; planName: string; status: string; billingCycle: string; currency: string; seats: number; unitPrice: string; trialEndsOn: string | null;
    currentPeriodStart: string | null; currentPeriodEnd: string | null; periodAmount: string; provider: string; autoRenew: boolean; savedCard: boolean;
    scheduledChange: { planKey?: string; planName?: string; seats?: number; billingCycle?: string; currency?: string; effectiveOn?: string } | null;
    trialReturn: { planKey: string } | null; trialUsed: boolean; pastDueSince: string | null; locked: boolean;
    deal: { unitPrice: string | null; discountPercent: string | null; features: string[]; endsOn: string | null; partner: string | null } | null;
  } | null;
  usage: { members: number; legalEntities: number; aiCreditsThisMonth: number };
  paymentProvider: { connected: boolean; provider: string | null; note: string };
}
export interface Invoice {
  id: string; number: string | null; kind: string; status: string; currency: string; subtotal: string; tax: string; total: string;
  taxLines: { label: string; rate: string; amount: string }[]; periodStart: string | null; periodEnd: string | null; issuedAt: string | null; dueAt: string | null; paidAt: string | null; overdue: boolean;
}
export interface Quote {
  mode: 'now' | 'scheduled' | 'none'; plan: { key: string; name: string }; seats: number; billingCycle: string; currency: string; unitPrice: string; periodAmount: string;
  effectiveOn: string; periodStart: string; periodEnd: string; lines: { kind: string; description: string; amount: string }[]; subtotal: string;
  tax: { lines: { code: string; label: string; rate: string; amount: string }[]; total: string; placeOfSupply: string; note: string | null }; total: string;
  coupon: { code: string; name: string } | null; gateway: string | null; trialConversion: boolean;
}
export interface UsageMetric { key: string; name: string; unit: string; used: number; limit: number | null; percent: number | null; policy: 'block' | 'overage'; overagePrice: string | null }
export interface Addon {
  key: string; name: string; description: string; kind: 'module' | 'limit'; featureKey: string; unitQuantity: number; price: string | null; currency: string; includedInPlan: boolean;
  active: { quantity: number; unitPrice: string; endsAtPeriodEnd: boolean } | null;
}
export interface BillingProfile { legalName: string; gstin: string; addressLine1: string; addressLine2: string; city: string; stateCode: string; postalCode: string; countryCode: string; email: string }

const money = (amount: string | number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount));
const limit = (n: number | undefined) => (n === undefined ? '—' : n === -1 ? 'Unlimited' : n.toLocaleString());
const capacity = (n: number | undefined, one: string, many: string) => (n === undefined ? `No ${many}` : n === -1 ? `Unlimited ${many}` : `Up to ${n.toLocaleString()} ${n === 1 ? one : many}`);
const featureName = (key: string) => (FEATURES as readonly { key: string; name: string }[]).find((f) => f.key === key)?.name ?? key;
const date = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? `${d}T00:00:00Z` : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const GATEWAY: Record<string, string> = { razorpay: 'Razorpay', stripe: 'Stripe' };
const KIND: Record<string, string> = { subscription: 'Subscription', renewal: 'Renewal', upgrade: 'Plan change', addon: 'Add-on', overage: 'Overage', manual: 'Other' };
type Def = { key: string; name: string; module: string; kind: string; unit?: string };
const MODULES = (FEATURES as readonly Def[]).filter((f) => f.kind === 'boolean');
const LIMITS = (FEATURES as readonly Def[]).filter((f) => f.kind === 'limit');

/** Sends the browser to Razorpay or Stripe, or reports what happened when nothing needed paying online. */
function useResult(setNote: (n: string) => void) {
  const router = useRouter();
  return (r: ChangeResult, what: string) => {
    if (r.mode === 'checkout') { window.location.assign(r.url); return; }
    if (r.mode === 'scheduled') setNote(`${what} is scheduled for ${date(r.effectiveOn)}, the end of the period you have paid for.`);
    else if (r.mode === 'applied') setNote(r.invoice ? `${what} applied. Invoice ${r.invoice.number} for ${r.invoice.total} is ${r.invoice.status === 'paid' ? 'paid' : 'open for payment below'}.` : `${what} applied.`);
    else setNote('Nothing changed.');
    router.refresh();
  };
}

export function BillingView(props: {
  plans: Plan[]; info: SubscriptionInfo; invoices: Invoice[]; requests: PlanRequest[]; usage: UsageMetric[]; addons: Addon[]; profile: BillingProfile | null;
  features: string[]; canManage: boolean; orderId: string | null; checkoutCancelled: boolean; upgrade: string | null;
}) {
  const { plans, info, invoices, requests, usage, addons, profile, features, canManage } = props;
  const sub = info.subscription;
  const current = plans.find((p) => p.key === sub?.planKey);
  const [target, setTarget] = useState<Plan | null>(null);
  const [asking, setAsking] = useState<Plan | null>(null);
  const [note, setNote] = useState<string | null>(props.checkoutCancelled ? 'Payment cancelled. Nothing was charged and nothing changed.' : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const done = useResult((n) => setNote(n));
  const open = requests.find((r) => r.status === 'pending');
  const lastAnswered = requests.find((r) => r.status === 'approved' || r.status === 'declined');
  // Modules the plan includes that SAMPLEDGE switched off for this workspace, so the admin knows why they are missing.
  const switchedOff = (current?.features ?? []).filter((k) => !isCoreFeature(k) && !isPlannedFeature(k) && !features.includes(k));
  const overdue = invoices.filter((i) => i.status === 'open' && i.overdue);
  const upgradeTo = props.upgrade && !features.includes(props.upgrade) ? props.upgrade : null;
  const sellsUpgrade = upgradeTo ? addons.find((a) => a.kind === 'module' && a.featureKey === upgradeTo && !a.includedInPlan) : undefined;

  const run = (fn: () => Promise<void>) => { setError(null); start(fn); };

  return (
    <div className="grid gap-6">
      {props.orderId && <OrderReturn id={props.orderId} />}
      {sub?.locked && (
        <Alert tone="danger" title="Your workspace is read-only">
          An invoice is overdue, so people can view everything but cannot make changes. {canManage ? 'Pay the open invoice below to open it again at once.' : 'Ask a billing admin to pay it.'}
        </Alert>
      )}
      {!sub?.locked && overdue.length > 0 && (
        <Alert tone="warning" title={overdue.length === 1 ? 'An invoice is overdue' : `${overdue.length} invoices are overdue`}>
          Pay {overdue.length === 1 ? 'it' : 'them'} below to keep using SampCrew without interruption. The workspace becomes read-only if an invoice stays unpaid after the grace period.
        </Alert>
      )}
      {upgradeTo && (
        <Alert tone="info" title={`${featureName(upgradeTo)} is not in your plan`}>
          {plans.some((p) => p.features.includes(upgradeTo) && p.key !== sub?.planKey) ? `Plans with it are marked below.` : ''}
          {sellsUpgrade ? ` You can also add it to your current plan as an add-on.` : ''}
          {!canManage && ' A billing admin can upgrade.'}
        </Alert>
      )}
      {!info.paymentProvider.connected && <Alert tone="info">{info.paymentProvider.note}</Alert>}
      {note && <Alert tone="success">{note}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {current && !current.offered && <Alert tone="warning">Your plan, {current.name}, is no longer offered to new customers. You keep everything in it until you move to another plan.</Alert>}
      {open && (
        <Alert tone="info" title={`Request for ${open.planName} sent to SAMPLEDGE`}>
          {open.seats} seats, billed {open.billingCycle}, sent by {open.requestedBy} on {new Date(open.createdAt).toLocaleDateString()}. You will get a notification when SAMPLEDGE answers.
          {canManage && <> <button type="button" className="ml-1 text-accent hover:underline" disabled={pending} onClick={() => run(async () => { const r = await withdrawPlanRequestAction(open.id); if (r.ok) { setNote('Request withdrawn.'); router.refresh(); } })}>Withdraw request</button></>}
        </Alert>
      )}
      {!open && lastAnswered?.status === 'declined' && <Alert tone="warning" title={`SAMPLEDGE declined the request for ${lastAnswered.planName}`}>{lastAnswered.decisionNote ?? 'Contact SAMPLEDGE sales to discuss it.'}</Alert>}
      {switchedOff.length > 0 && <Alert tone="warning" title="Switched off by SAMPLEDGE">Your plan includes {switchedOff.map(featureName).join(', ')}, but SAMPLEDGE has switched {switchedOff.length === 1 ? 'it' : 'them'} off for your workspace or for some apps. Contact SAMPLEDGE support to turn {switchedOff.length === 1 ? 'it' : 'them'} back on.</Alert>}

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Plan" value={sub?.planName ?? 'None'} hint={sub ? <Badge tone={sub.status === 'active' ? 'success' : sub.status === 'trialing' ? 'accent' : 'warning'}>{sub.status === 'past_due' ? 'payment overdue' : sub.status}</Badge> : undefined} />
        <Stat label="Seats used" value={`${info.usage.members} / ${sub?.seats ?? 0}`} hint={`Plan limit: ${limit(current?.limits.max_employees)}`} />
        <Stat label="Legal entities" value={info.usage.legalEntities} hint={`Plan limit: ${limit(current?.limits.max_legal_entities)}`} />
        <Stat label={sub?.billingCycle === 'annual' ? 'Per year' : 'Per month'} value={sub ? money(sub.periodAmount, sub.currency) : '—'} hint={sub ? `${money(sub.unitPrice, sub.currency)} per seat per month, before tax${sub.trialEndsOn ? ` · trial ends ${date(sub.trialEndsOn)}` : ''}` : undefined} />
      </div>

      {sub && (
        <Card data-testid="billing-subscription">
          <CardHeader title="Your subscription" description="When the current period ends and what happens then." />
          <CardBody className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2 text-[0.8125rem]">
              <div>
                <span className="text-fg-muted">Current period: </span>
                {date(sub.currentPeriodStart)} to {date(sub.currentPeriodEnd)}
              </div>
              {sub.status === 'trialing' && (
                <div data-testid="billing-trial">
                  <span className="text-fg-muted">Free trial: </span>ends {date(sub.trialEndsOn)}.{' '}
                  {sub.trialReturn ? `Then you go back to ${plans.find((p) => p.key === sub.trialReturn!.planKey)?.name ?? sub.trialReturn.planKey}, unless you buy ${sub.planName}.` : `Then the first ${sub.billingCycle === 'annual' ? 'year' : 'month'} is invoiced.`}
                </div>
              )}
              {sub.scheduledChange && (
                <div className="flex flex-wrap items-center gap-2" data-testid="billing-scheduled">
                  <span><span className="text-fg-muted">Scheduled: </span>{sub.scheduledChange.planName ?? sub.scheduledChange.planKey}, {sub.scheduledChange.seats} seats, billed {sub.scheduledChange.billingCycle}, from {date(sub.scheduledChange.effectiveOn ?? sub.currentPeriodEnd)}.</span>
                  {canManage && <Button size="sm" variant="ghost" loading={pending} onClick={() => run(async () => { const r = await cancelScheduledChangeAction(); if (r.ok) { setNote('The scheduled change was cancelled. Your plan stays as it is.'); router.refresh(); } else setError(r.message); })}>Cancel the change</Button>}
                </div>
              )}
              {sub.deal && (
                <div data-testid="billing-deal">
                  <span className="text-fg-muted">Contract terms: </span>
                  {[sub.deal.unitPrice && `${money(sub.deal.unitPrice, sub.currency)} per seat`, sub.deal.discountPercent && `${sub.deal.discountPercent}% off`, sub.deal.features.length > 0 && `also ${sub.deal.features.map(featureName).join(', ')}`].filter(Boolean).join(', ')}
                  {sub.deal.endsOn ? ` until ${date(sub.deal.endsOn)}` : ''}{sub.deal.partner ? ` (through ${sub.deal.partner})` : ''}.
                </div>
              )}
              <div>
                <span className="text-fg-muted">Payment: </span>
                {sub.savedCard ? 'A saved card is charged automatically at renewal.' : info.paymentProvider.connected ? `Pay each invoice online with ${GATEWAY[info.paymentProvider.provider ?? ''] ?? 'the payment provider'}.` : 'Invoices are paid by bank transfer.'}
              </div>
            </div>
            <div className="grid content-start gap-3">
              <Switch
                checked={sub.autoRenew}
                disabled={!canManage || pending || sub.status === 'trialing'}
                label={sub.autoRenew ? `Renews on ${date(sub.currentPeriodEnd)}` : `Ends on ${date(sub.currentPeriodEnd)}`}
                testId="billing-auto-renew"
                onChange={(next) => run(async () => {
                  const r = await setAutoRenewAction(next);
                  if (!r.ok) setError(r.message);
                  else { setNote(next ? 'Your subscription renews automatically again.' : `Your subscription ends on ${date(r.data!.endsOn)}. You keep everything until then.`); router.refresh(); }
                })}
              />
              <p className="text-xs text-fg-muted">Switch off to stop at the end of this period. The workspace keeps its data, but nobody can use SampCrew until a plan is bought again.</p>
            </div>
          </CardBody>
        </Card>
      )}

      {usage.length > 0 && <UsageCard usage={usage} currency={sub?.currency ?? 'INR'} />}

      <div>
        <h2 className="mb-3 text-sm font-semibold">Plans</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((p) => {
            const price = p.prices.find((x) => x.currency === (sub?.currency ?? 'USD')) ?? p.prices[0];
            const isCurrent = p.key === sub?.planKey;
            const canTry = canManage && !isCurrent && !p.quoteOnly && p.offered && p.trialDays > 0 && sub && !sub.trialUsed && sub.status === 'active';
            const hasUpgrade = upgradeTo && p.features.includes(upgradeTo) && !isCurrent;
            return (
              <Card key={p.key} className={cn('flex flex-col', isCurrent && 'ring-2 ring-accent', hasUpgrade && 'ring-2 ring-success')} data-testid={`billing-plan-${p.key}`} data-current={isCurrent ? 'true' : undefined}>
                <CardHeader title={p.name} description={p.tagline} action={isCurrent ? <Badge tone="accent">Current</Badge> : hasUpgrade ? <Badge tone="success">Includes it</Badge> : undefined} />
                <CardBody className="flex flex-1 flex-col gap-4">
                  <div>
                    {p.quoteOnly || !price ? <div className="text-xl font-semibold">Custom quote</div> : (
                      <>
                        <div className="text-xl font-semibold tabular">{money(price.monthly, price.currency)}</div>
                        <div className="text-xs text-fg-subtle">per seat per month, or {money(price.annualPerMonth, price.currency)} billed annually</div>
                      </>
                    )}
                    {p.minimumSeats > 1 && <div className="mt-1 text-xs text-fg-subtle">Minimum {p.minimumSeats} seats</div>}
                    {p.trialDays > 0 && !p.quoteOnly && <div className="mt-1 text-xs text-fg-muted">{p.trialDays}-day free trial</div>}
                  </div>
                  <ul className="grid gap-1.5 text-[0.8125rem]">
                    <li className="text-fg-muted">{capacity(p.limits.max_employees, 'person', 'people')}, {capacity(p.limits.max_legal_entities, 'legal entity', 'legal entities')}</li>
                    {p.features.slice(0, 8).map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 size-3.5 shrink-0 text-success" />{featureName(f)}</li>)}
                    {p.features.length > 8 && <li className="text-xs text-fg-subtle">and {p.features.length - 8} more</li>}
                  </ul>
                  <div className="mt-auto grid gap-2">
                    {p.quoteOnly ? (
                      isCurrent ? <p className="text-xs text-fg-subtle">Contact SAMPLEDGE to change seats on this plan.</p>
                        : canManage ? <Button className="w-full" variant="secondary" disabled={Boolean(open)} onClick={() => setAsking(p)} data-testid={`plan-request-${p.key}`}>{open?.planKey === p.key ? 'Request sent' : 'Request this plan'}</Button>
                        : <p className="text-xs text-fg-subtle">Sold by quotation. A workspace admin can request it.</p>
                    ) : canManage && (p.offered || isCurrent) ? (
                      <Button className="w-full" variant={isCurrent ? 'secondary' : 'primary'} onClick={() => setTarget(p)} data-testid={`plan-choose-${p.key}`}>
                        {isCurrent ? (sub?.status === 'trialing' && !sub.trialReturn ? 'Buy this plan' : 'Change seats or cycle') : sub?.status === 'trialing' && sub.trialReturn?.planKey !== p.key ? 'Buy this plan' : 'Switch to this plan'}
                      </Button>
                    ) : null}
                    {isCurrent && sub?.status === 'trialing' && sub.trialReturn && canManage && <Button className="w-full" onClick={() => setTarget(p)} data-testid="plan-buy-trial">Buy {p.name} now</Button>}
                    {canTry && (
                      <Button className="w-full" variant="ghost" loading={pending} data-testid={`plan-trial-${p.key}`} onClick={() => run(async () => {
                        const r = await startTrialAction(p.key);
                        if (!r.ok) setError(r.message);
                        else { setNote(`Your ${p.name} trial has started and ends on ${date(r.data!.endsOn)}. Then you go back to ${current?.name ?? 'your plan'} unless you buy it.`); router.refresh(); }
                      })}>Try free for {p.trialDays} days</Button>
                    )}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      </div>

      <AddonsCard addons={addons} canManage={canManage} trialing={sub?.status === 'trialing'} highlight={upgradeTo} onDone={done} onNote={setNote} onError={setError} />

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
        <CardHeader title="Invoices" description={info.paymentProvider.connected ? `Tax invoices from SAMPLEDGE. Pay open ones online with ${GATEWAY[info.paymentProvider.provider ?? ''] ?? 'the payment provider'}.` : 'Tax invoices from SAMPLEDGE. Pay open ones by bank transfer using the details on the PDF.'} />
        {invoices.length === 0 ? <EmptyState icon={<FileText className="size-6" />} title="No invoices yet" /> : (
          <div className="overflow-x-auto">
            <Table aria-label="Invoices">
              <THead><TR><TH>Number</TH><TH>For</TH><TH>Period</TH><TH>Status</TH><TH className="text-right">Total</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
              <TBody>
                {invoices.map((i) => (
                  <TR key={i.id} data-testid={`invoice-${i.number ?? i.id}`}>
                    <TD className="font-mono text-xs">{i.number ?? 'Draft'}</TD>
                    <TD>{KIND[i.kind] ?? i.kind}</TD>
                    <TD className="text-[0.8125rem]">{i.periodStart ? `${date(i.periodStart)} to ${date(i.periodEnd)}` : '—'}</TD>
                    <TD>
                      <Badge tone={i.status === 'paid' ? 'success' : i.status === 'void' ? 'neutral' : i.overdue ? 'danger' : 'warning'}>{i.status === 'open' ? (i.overdue ? 'overdue' : 'open') : i.status}</Badge>
                      {i.status === 'open' && i.dueAt && <div className="mt-0.5 text-xs text-fg-muted">due {date(i.dueAt)}</div>}
                    </TD>
                    <TD className="text-right tabular">
                      {money(i.total, i.currency)}
                      {i.taxLines.length > 0 && <div className="text-xs text-fg-muted">incl. {i.taxLines.map((t) => t.label).join(' + ')}</div>}
                    </TD>
                    <TD className="whitespace-nowrap text-right">
                      <div className="flex justify-end gap-1">
                        {i.status === 'open' && canManage && info.paymentProvider.connected && (
                          <Button size="sm" loading={pending} data-testid="invoice-pay" onClick={() => run(async () => {
                            const r = await payInvoiceAction(i.id);
                            if (r.ok) window.location.assign(r.data!.url);
                            else setError(r.message);
                          })}><CreditCard className="size-3.5" aria-hidden /> Pay now</Button>
                        )}
                        {i.number && <a href={`/billing-invoices/${i.id}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:bg-bg-subtle" data-testid="invoice-pdf"><Download className="size-3.5" aria-hidden /> PDF</a>}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </Card>

      <BillingProfileCard profile={profile} canManage={canManage} />

      {target && sub && <ChangePlanDialog plan={target} sub={sub} members={info.usage.members} onClose={() => setTarget(null)} onDone={(r) => { setTarget(null); done(r, `The move to ${target.name}`); }} />}
      {asking && sub && <RequestPlanDialog plan={asking} sub={sub} members={info.usage.members} onClose={() => setAsking(null)} onSent={(n) => { setNote(n); setAsking(null); router.refresh(); }} />}
    </div>
  );
}

/** After Razorpay or Stripe sends the admin back: waits for the signed confirmation to arrive from the gateway. */
function OrderReturn({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ status: string; description?: string; failureReason?: string | null; amount?: string; currency?: string }>({ status: 'checking' });
  const tries = useRef(0);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const r = await orderStatusAction(id);
      if (stop) return;
      if (!r.ok) { setState({ status: 'unknown' }); return; }
      const o = r.data!;
      setState({ status: o.status, description: o.description, failureReason: o.failureReason, amount: o.amount, currency: o.currency });
      if (o.status === 'paid') { router.replace('/settings/billing'); router.refresh(); return; }
      if (o.status === 'created' && tries.current++ < 30) setTimeout(tick, 2000);
    };
    void tick();
    return () => { stop = true; };
  }, [id, router]);
  if (state.status === 'paid') return <Alert tone="success" title="Payment received">{state.description}: {money(state.amount!, state.currency!)} paid. Thank you.</Alert>;
  if (state.status === 'failed' || state.status === 'cancelled' || state.status === 'expired') return <Alert tone="danger" title="The payment did not go through">{state.failureReason ?? 'Nothing was charged. Try again, or use another card or method.'}</Alert>;
  if (state.status === 'unknown') return <Alert tone="warning">We could not find that payment. If money left your account, it will show here once the payment provider confirms it.</Alert>;
  return <Alert tone="info" title="Confirming your payment" data-testid="order-waiting">Waiting for the payment provider to confirm{state.description ? ` ${state.description}` : ''}. This usually takes a few seconds. You can leave this page; it is applied as soon as the confirmation arrives.</Alert>;
}

function UsageCard({ usage, currency }: { usage: UsageMetric[]; currency: string }) {
  return (
    <Card data-testid="billing-usage">
      <CardHeader title="Usage" description="How much of each plan limit you use. Admins are told at 80% and 100%." />
      <CardBody className="grid gap-5 md:grid-cols-3">
        {usage.map((m) => {
          const unlimited = m.limit === null || m.limit === -1;
          const pct = unlimited ? 0 : Math.min(100, m.percent ?? 0);
          const tone = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent';
          return (
            <div key={m.key} data-testid={`usage-${m.key}`}>
              <div className="flex items-baseline justify-between gap-2 text-[0.8125rem]">
                <span className="font-medium">{m.name}</span>
                <span className="tabular text-fg-muted">{m.used.toLocaleString()}{unlimited ? '' : ` / ${m.limit!.toLocaleString()}`}{m.unit ? ` ${m.unit}` : ''}</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-label={m.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={unlimited ? undefined : pct}>
                {!unlimited && <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />}
              </div>
              <div className="mt-1 text-xs text-fg-muted">
                {unlimited ? 'Unlimited on your plan' : m.policy === 'overage' ? `Beyond the limit: ${m.overagePrice ? money(m.overagePrice, currency) : 'charged'} per extra ${m.unit || 'unit'}, invoiced at renewal` : (m.percent ?? 0) >= 100 ? 'Limit reached: upgrade or buy an add-on for more' : 'Beyond the limit: blocked until you upgrade'}
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}

function AddonsCard({ addons, canManage, trialing, highlight, onDone, onNote, onError }: {
  addons: Addon[]; canManage: boolean; trialing: boolean; highlight: string | null;
  onDone: (r: ChangeResult, what: string) => void; onNote: (n: string) => void; onError: (e: string) => void;
}) {
  const router = useRouter();
  const [buying, setBuying] = useState<Addon | null>(null);
  const [pending, start] = useTransition();
  if (addons.length === 0) return null;
  return (
    <Card data-testid="billing-addons">
      <CardHeader title="Add-ons" description="Modules and extra capacity you can add to your plan. The rest of the current period is charged now; renewals include them." />
      <CardBody className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {addons.map((a) => (
          <div key={a.key} className={cn('flex flex-col gap-2 rounded-lg border border-border p-3', highlight && a.featureKey === highlight && 'ring-2 ring-success')} data-testid={`addon-${a.key}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5 text-[0.8125rem] font-medium"><Package className="size-3.5 text-fg-muted" aria-hidden />{a.name}</div>
                <div className="text-xs text-fg-muted">{a.description || (a.kind === 'module' ? featureName(a.featureKey) : `${a.unitQuantity.toLocaleString()} more ${featureName(a.featureKey).toLowerCase()}`)}</div>
              </div>
              {a.active ? <Badge tone={a.active.endsAtPeriodEnd ? 'warning' : 'success'}>{a.active.endsAtPeriodEnd ? 'ends at renewal' : a.kind === 'limit' ? `× ${a.active.quantity}` : 'active'}</Badge> : a.includedInPlan ? <Badge tone="neutral">in your plan</Badge> : null}
            </div>
            <div className="text-[0.8125rem] tabular">{a.price ? `${money(a.price, a.currency)} per month${a.kind === 'limit' ? ` for each ${a.unitQuantity.toLocaleString()}` : ''}` : `Not sold in ${a.currency}`}</div>
            {canManage && (
              <div className="mt-auto flex flex-wrap gap-2">
                {a.active?.endsAtPeriodEnd ? (
                  <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await removeAddonAction(a.key, true); if (r.ok) { onNote(`${a.name} stays on your plan.`); router.refresh(); } else onError(r.message); })}>Keep it</Button>
                ) : (
                  <>
                    {!a.includedInPlan && a.price && (a.kind === 'limit' || !a.active) && <Button size="sm" disabled={trialing} title={trialing ? 'Add-ons can be bought after the trial' : undefined} onClick={() => setBuying(a)} data-testid={`addon-buy-${a.key}`}>{a.active ? 'Buy more' : 'Add'}</Button>}
                    {a.active && <Button size="sm" variant="ghost" loading={pending} data-testid={`addon-remove-${a.key}`} onClick={() => start(async () => { const r = await removeAddonAction(a.key); if (r.ok) { onNote(`${a.name} ends on ${date(r.data!.endsOn)}. It works until then.`); router.refresh(); } else onError(r.message); })}>Remove at renewal</Button>}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </CardBody>
      {buying && <BuyAddonDialog addon={buying} onClose={() => setBuying(null)} onDone={(r) => { setBuying(null); onDone(r, buying.name); }} />}
    </Card>
  );
}

function BuyAddonDialog({ addon, onClose, onDone }: { addon: Addon; onClose: () => void; onDone: (r: ChangeResult) => void }) {
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const n = Number(qty);
  const bad = !Number.isInteger(n) || n < 1 || n > 1000;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add ${addon.name}`}
      description="You pay now for the days left in this period, plus tax. Each renewal includes it until you remove it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={pending} disabled={bad} data-testid="addon-confirm" onClick={() => start(async () => {
            const r = await buyAddonAction(addon.key, addon.kind === 'module' ? 1 : n);
            if (!r.ok) setError(r.message);
            else onDone(r.data!);
          })}>Buy</Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {addon.kind === 'limit' && (
          <Field label="How many" hint={`Each adds ${addon.unitQuantity.toLocaleString()} ${featureName(addon.featureKey).toLowerCase()}`} error={bad ? 'Enter a whole number from 1 to 1000' : undefined}>
            {(p) => <Input {...p} type="number" min={1} max={1000} value={qty} onChange={(e) => setQty(e.target.value)} />}
          </Field>
        )}
        <div className="rounded-md bg-bg-subtle p-3 text-[0.8125rem]">
          {money(Number(addon.price) * (addon.kind === 'module' ? 1 : bad ? 0 : n), addon.currency)} per month, before tax. The exact amount for the rest of this period is shown by the payment provider, or on the invoice.
        </div>
      </div>
    </Dialog>
  );
}

function ChangePlanDialog({ plan, sub, members, onClose, onDone }: { plan: Plan; sub: NonNullable<SubscriptionInfo['subscription']>; members: number; onClose: () => void; onDone: (r: ChangeResult) => void }) {
  const [cycle, setCycle] = useState(sub.billingCycle);
  const [currency, setCurrency] = useState(plan.prices.some((p) => p.currency === sub.currency) ? sub.currency : plan.prices[0]?.currency ?? 'USD');
  const [seats, setSeats] = useState(String(Math.max(sub.seats, plan.minimumSeats, members)));
  const [coupon, setCoupon] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<string | undefined>(undefined);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [quoting, startQuote] = useTransition();
  const n = Number(seats);
  const seatsError = !Number.isInteger(n) || n < 1 ? 'Enter a whole number of seats' : n < plan.minimumSeats ? `At least ${plan.minimumSeats} seats` : n < members ? `You have ${members} active members` : null;
  const body = { planKey: plan.key, billingCycle: cycle, seats: n, currency, couponCode: appliedCoupon };

  useEffect(() => {
    if (seatsError) { setQuote(null); return; }
    const t = setTimeout(() => startQuote(async () => {
      const r = await quotePlanAction(body);
      if (r.ok) { setQuote(r.data!); setQuoteError(null); } else { setQuote(null); setQuoteError(r.message); if (appliedCoupon) setAppliedCoupon(undefined); }
    }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycle, currency, seats, appliedCoupon, seatsError]);

  const payOnline = quote?.mode === 'now' && quote.gateway && Number(quote.total) > 0;
  const label = !quote ? 'Confirm change' : quote.mode === 'scheduled' ? `Schedule for ${date(quote.effectiveOn)}` : payOnline ? `Pay ${money(quote.total, quote.currency)} with ${GATEWAY[quote.gateway!]}` : quote.mode === 'none' ? 'No change' : 'Confirm change';

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${plan.name} plan`}
      description="An upgrade applies once it is paid, charged only for the days left. Paying less waits for the end of the period you have paid for."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={pending} disabled={Boolean(seatsError) || !quote || quote.mode === 'none' || quoting} data-testid="plan-confirm" onClick={() => start(async () => {
            const r = await changePlanAction(body);
            if (!r.ok) setError(r.message);
            else onDone(r.data!);
          })}>{label}</Button>
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
        <div className="flex items-end gap-2">
          <Field label="Coupon code" className="flex-1">{(p) => <Input {...p} value={coupon} maxLength={40} onChange={(e) => setCoupon(e.target.value.toUpperCase())} data-testid="coupon-input" />}</Field>
          <Button variant="secondary" disabled={!coupon.trim() || quoting} onClick={() => setAppliedCoupon(coupon.trim())} data-testid="coupon-apply">Apply</Button>
        </div>
        {quoteError && <Alert tone="warning">{quoteError}</Alert>}
        {quote && <QuoteSummary quote={quote} />}
      </div>
    </Dialog>
  );
}

function QuoteSummary({ quote }: { quote: Quote }) {
  const m = (v: string) => money(v, quote.currency);
  if (quote.mode === 'none') return <p className="text-[0.8125rem] text-fg-muted">This is your current plan, seats and cycle.</p>;
  if (quote.mode === 'scheduled') {
    return (
      <div className="rounded-md bg-bg-subtle p-3 text-[0.8125rem]" data-testid="quote-summary">
        Starts on <strong>{date(quote.effectiveOn)}</strong>, when your paid period ends. Nothing is charged now. From then: {m(quote.periodAmount)} per {quote.billingCycle === 'annual' ? 'year' : 'month'}, before tax.
      </div>
    );
  }
  return (
    <div className="grid gap-1.5 rounded-md bg-bg-subtle p-3 text-[0.8125rem]" data-testid="quote-summary">
      {quote.lines.map((l, i) => (
        <div key={i} className="flex justify-between gap-3"><span className="text-fg-muted">{l.description}</span><span className="tabular">{m(l.amount)}</span></div>
      ))}
      <div className="flex justify-between gap-3 border-t border-border pt-1.5"><span>Subtotal</span><span className="tabular">{m(quote.subtotal)}</span></div>
      {quote.tax.lines.map((t) => <div key={t.code} className="flex justify-between gap-3"><span className="text-fg-muted">{t.label} {t.rate}%</span><span className="tabular">{m(t.amount)}</span></div>)}
      <div className="flex justify-between gap-3 font-semibold"><span>Due now</span><span className="tabular" data-testid="quote-total">{m(quote.total)}</span></div>
      {quote.tax.note && <div className="text-xs text-fg-muted">{quote.tax.note}</div>}
      {quote.coupon && <div className="text-xs text-success">Coupon {quote.coupon.code}: {quote.coupon.name}</div>}
      <div className="text-xs text-fg-muted">
        Then {m(quote.periodAmount)} per {quote.billingCycle === 'annual' ? 'year' : 'month'} from {date(quote.periodEnd)}, before tax.{' '}
        {quote.gateway ? `You pay on ${GATEWAY[quote.gateway]}'s secure page; the plan changes as soon as the payment is confirmed.` : 'The plan changes now and the invoice is open for payment by bank transfer.'}
      </div>
    </div>
  );
}

function BillingProfileCard({ profile, canManage }: { profile: BillingProfile | null; canManage: boolean }) {
  const router = useRouter();
  // The API sends no body when nothing is saved yet: start from empty fields.
  const [v, setV] = useState<BillingProfile>({ legalName: '', gstin: '', addressLine1: '', addressLine2: '', city: '', stateCode: '', postalCode: '', countryCode: 'IN', email: '', ...(profile?.legalName ? profile : {}) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof BillingProfile) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const india = v.countryCode.toUpperCase() === 'IN';
  return (
    <Card data-testid="billing-profile">
      <CardHeader title="Billing details" description="Printed on your invoices. In India, your GSTIN and state decide CGST and SGST, or IGST, on the next invoices." />
      <CardBody>
        <form
          className="grid gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await saveBillingProfileAction({ ...v, countryCode: v.countryCode.toUpperCase(), gstin: v.gstin.toUpperCase() });
              if (r.ok) { setErrors({}); setMsg({ tone: 'success', text: 'Billing details saved. The next invoices use them.' }); router.refresh(); }
              else { setErrors(r.fieldErrors ?? {}); setMsg({ tone: 'danger', text: r.message }); }
            });
          }}
        >
          {msg && <Alert tone={msg.tone} className="md:col-span-2">{msg.text}</Alert>}
          <Field label="Legal name" required error={errors.legalName}>{(p) => <Input {...p} value={v.legalName} onChange={set('legalName')} disabled={!canManage} maxLength={200} />}</Field>
          <Field label="Invoice email" required error={errors.email}>{(p) => <Input {...p} type="email" value={v.email} onChange={set('email')} disabled={!canManage} />}</Field>
          <Field label="Country" required error={errors.countryCode} hint="Two-letter code, such as IN or US">{(p) => <Input {...p} value={v.countryCode} maxLength={2} onChange={set('countryCode')} disabled={!canManage} />}</Field>
          {india ? (
            <Field label="State" required error={errors.stateCode}>{(p) => (
              <Select {...p} value={v.stateCode} onChange={set('stateCode')} disabled={!canManage}>
                <option value="">Choose a state</option>
                {Object.entries(GST_STATES).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
              </Select>
            )}</Field>
          ) : <div />}
          {india && <Field label="GSTIN" error={errors.gstin} hint="Leave empty if you are not registered for GST">{(p) => <Input {...p} value={v.gstin} maxLength={15} onChange={set('gstin')} disabled={!canManage} className="font-mono uppercase" />}</Field>}
          <Field label="Address" required error={errors.addressLine1} className={india ? '' : 'md:col-span-2'}>{(p) => <Input {...p} value={v.addressLine1} onChange={set('addressLine1')} disabled={!canManage} maxLength={200} />}</Field>
          <Field label="Address line 2" error={errors.addressLine2}>{(p) => <Input {...p} value={v.addressLine2} onChange={set('addressLine2')} disabled={!canManage} maxLength={200} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City" required error={errors.city}>{(p) => <Input {...p} value={v.city} onChange={set('city')} disabled={!canManage} maxLength={100} />}</Field>
            <Field label="Postal code" required error={errors.postalCode}>{(p) => <Input {...p} value={v.postalCode} onChange={set('postalCode')} disabled={!canManage} maxLength={20} />}</Field>
          </div>
          {canManage ? <div className="md:col-span-2"><Button type="submit" loading={pending} data-testid="billing-profile-save">Save billing details</Button></div>
            : <p className="flex items-center gap-1.5 text-xs text-fg-muted md:col-span-2"><Lock className="size-3" aria-hidden /> A billing admin can change these.</p>}
        </form>
      </CardBody>
    </Card>
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
