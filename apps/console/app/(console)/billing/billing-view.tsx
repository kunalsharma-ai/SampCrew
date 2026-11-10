'use client';
import { BILLING_CURRENCIES, FEATURES, GATEWAY_CHOICES, GST_STATES, type BillingSettingsInput } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Switch, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { InvoiceTable, day, money, type ConsoleInvoice } from '@/components/invoice-table';
import { createAddonAction, createCouponAction, runBillingAction, saveBillingSettingsAction, setCouponActiveAction, updateAddonAction } from '../actions';

type Money = Record<string, string>;
export interface Revenue {
  mrr: Money; arr: Money;
  subscriptions: Record<string, number>;
  last30Days: { new: { count: number; mrr: Money }; upgrades: { count: number; mrr: Money }; downgrades: { count: number; mrr: Money }; cancellations: { count: number; mrr: Money }; trialConversions: { count: number; mrr: Money }; addons: { count: number; mrr: Money }; paymentsFailed: number; churnRate: number };
  trialConversion90Days: { converted: number; expired: number; rate: number | null };
  collected: { month: string; amounts: Money }[];
  outstanding: Record<string, { total: string; overdue: string; count: number }>;
  plans: { key: string; name: string; workspaces: number; paying: number; trialing: number; mrr: Money }[];
  addons: { name: string; workspaces: number; units: number }[];
}
export interface ConsoleAddon { key: string; name: string; description: string; kind: 'module' | 'limit'; featureKey: string; unitQuantity: number; prices: { currency: string; monthly: string; annualPerMonth: string }[]; planKeys: string[]; isPublic: boolean; archived: boolean; workspaces: number }
export interface ConsoleCoupon { id: string; code: string; name: string; kind: 'percent' | 'amount'; value: string; currency: string | null; duration: string; cycles: number | null; planKeys: string[]; maxRedemptions: number | null; redeemed: number; validUntil: string | null; active: boolean; partner: string | null }
export interface PaymentEvent { provider: string; eventId: string; type: string; status: string; detail: string | null; receivedAt: string }

type Def = { key: string; name: string; kind: string };
const DEFS = FEATURES as readonly Def[];
const nameOf = (k: string) => DEFS.find((f) => f.key === k)?.name ?? k;
const amounts = (m: Money) => (Object.keys(m).length ? Object.entries(m).map(([c, v]) => money(v, c)).join(' + ') : '0');
type Note = { tone: 'success' | 'danger'; text: string } | null;

function useDone() {
  const router = useRouter();
  const [note, setNote] = useState<Note>(null);
  const done = (r: { ok: boolean; message?: string }) => {
    setNote(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message ?? 'Something went wrong' });
    if (r.ok) router.refresh();
  };
  return { note, done, setNote };
}

// -----------------------------------------------------------------------------------------------------------------

export function RevenuePanel({ revenue: r, canManage }: { revenue: Revenue; canManage: boolean }) {
  const { note, done } = useDone();
  const [pending, start] = useTransition();
  const s = r.subscriptions;
  const l = r.last30Days;
  return (
    <div className="grid gap-5">
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Monthly recurring revenue" value={amounts(r.mrr)} hint={`ARR ${amounts(r.arr)}`} testId="revenue-mrr" />
        <Stat label="Paying workspaces" value={String((s.active ?? 0) + (s.past_due ?? 0))} hint={`${s.trialing ?? 0} on trial · ${s.trialsEndingIn7Days ?? 0} ending in 7 days`} />
        <Stat label="Outstanding" value={Object.keys(r.outstanding).length ? Object.entries(r.outstanding).map(([c, o]) => money(o.total, c)).join(' + ') : '0'} hint={Object.entries(r.outstanding).map(([c, o]) => `${money(o.overdue, c)} overdue`).join(' · ') || 'Nothing open'} />
        <Stat label="Churn, last 30 days" value={`${l.churnRate}%`} hint={`${s.past_due ?? 0} past due · ${s.locked ?? 0} read-only`} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Last 30 days" description="Movements in monthly recurring revenue." />
          <Table aria-label="Last 30 days">
            <THead><TR><TH>Movement</TH><TH className="text-right">Workspaces</TH><TH className="text-right">MRR change</TH></TR></THead>
            <TBody>
              {([['New', l.new], ['Trials converted', l.trialConversions], ['Upgrades', l.upgrades], ['Add-ons', l.addons], ['Downgrades', l.downgrades], ['Cancellations', l.cancellations]] as const).map(([label, m]) => (
                <TR key={label}><TD>{label}</TD><TD className="text-right tabular">{m.count}</TD><TD className="text-right tabular">{amounts(m.mrr)}</TD></TR>
              ))}
              <TR><TD>Failed payments</TD><TD className="text-right tabular">{l.paymentsFailed}</TD><TD /></TR>
            </TBody>
          </Table>
          <CardBody className="text-[0.8125rem] text-fg-muted">
            Trials in the last 90 days: {r.trialConversion90Days.converted} bought, {r.trialConversion90Days.expired} ended without buying{r.trialConversion90Days.rate !== null ? ` (${r.trialConversion90Days.rate}% conversion)` : ''}. Demo workspaces are left out.
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Money collected" description="Paid invoices per month, last 12 months." />
          {r.collected.length === 0 ? <CardBody><p className="text-[0.8125rem] text-fg-muted">Nothing collected yet.</p></CardBody> : (
            <Table aria-label="Money collected">
              <THead><TR><TH>Month</TH><TH className="text-right">Collected</TH></TR></THead>
              <TBody>{r.collected.map((c) => <TR key={c.month}><TD>{c.month}</TD><TD className="text-right tabular">{amounts(c.amounts)}</TD></TR>)}</TBody>
            </Table>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader title="Revenue by plan" description="Workspaces on each plan and their monthly recurring revenue, with contract prices, discounts and add-ons." />
        <Table aria-label="Revenue by plan">
          <THead><TR><TH>Plan</TH><TH className="text-right">Workspaces</TH><TH className="text-right">Paying</TH><TH className="text-right">On trial</TH><TH className="text-right">MRR</TH></TR></THead>
          <TBody>{r.plans.map((p) => <TR key={p.key}><TD>{p.name}</TD><TD className="text-right tabular">{p.workspaces}</TD><TD className="text-right tabular">{p.paying}</TD><TD className="text-right tabular">{p.trialing}</TD><TD className="text-right tabular">{amounts(p.mrr)}</TD></TR>)}</TBody>
        </Table>
        {r.addons.length > 0 && (
          <CardBody className="text-[0.8125rem] text-fg-muted">Add-ons in use: {r.addons.map((a) => `${a.name} (${a.workspaces} workspace${a.workspaces === 1 ? '' : 's'})`).join(', ')}.</CardBody>
        )}
      </Card>
      {canManage && (
        <Card>
          <CardHeader title="Billing clock" description="Renewals, trial ends, reminders, the read-only lock and usage warnings run every hour on their own. Run them now to see a change straight away." />
          <CardBody><Button variant="secondary" loading={pending} onClick={() => start(async () => { const x = await runBillingAction(); done({ ok: x.ok, message: x.ok ? `Checked ${x.data!.length} workspace(s).` : x.message }); })} data-testid="billing-run">Run now</Button></CardBody>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="crew-card rounded-xl border border-border bg-surface p-4">
      <div className="text-[0.8125rem] font-medium text-fg-muted">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums" data-testid={testId}>{value}</div>
      {hint && <div className="mt-1 text-xs text-fg-muted">{hint}</div>}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------------------------

export function InvoicesPanel({ invoices, status, canManage }: { invoices: ConsoleInvoice[]; status: string; canManage: boolean }) {
  return (
    <Card>
      <CardHeader title="Invoices" description="Every invoice SampCrew issued. Record a bank transfer with Mark paid; online payments are marked paid by Razorpay or Stripe." />
      <CardBody className="grid gap-3">
        <div className="flex flex-wrap gap-1.5">
          {['', 'open', 'overdue', 'paid', 'void'].map((s) => (
            <Link key={s || 'all'} href={`/billing?tab=invoices${s ? `&status=${s}` : ''}`} aria-current={s === status ? 'page' : undefined} className={s === status ? 'rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-fg' : 'rounded-full border border-border px-3 py-1 text-xs text-fg-muted hover:bg-bg-subtle'}>
              {s ? s[0]!.toUpperCase() + s.slice(1) : 'All'}
            </Link>
          ))}
        </div>
        <InvoiceTable invoices={invoices} canManage={canManage} showWorkspace />
      </CardBody>
    </Card>
  );
}

// -----------------------------------------------------------------------------------------------------------------

export function AddonsPanel({ addons, plans, canManage }: { addons: ConsoleAddon[]; plans: { key: string; name: string }[]; canManage: boolean }) {
  const { note, done } = useDone();
  const [editing, setEditing] = useState<ConsoleAddon | 'new' | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-4">
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <Card>
        <CardHeader title="Add-on catalogue" description="What workspaces can buy on top of their plan: a module, or more of a limit. Workspaces buy them on Plan & billing; the rest of the period is charged at once." action={canManage ? <Button size="sm" onClick={() => setEditing('new')} data-testid="addon-new"><Plus className="size-3.5" />New add-on</Button> : undefined} />
        {addons.length === 0 ? <CardBody><EmptyState title="No add-ons yet" description="Create one to sell a module or extra capacity separately." /></CardBody> : (
          <Table aria-label="Add-ons">
            <THead><TR><TH>Add-on</TH><TH>Gives</TH><TH>Price per month</TH><TH>Plans</TH><TH className="text-right">Workspaces</TH><TH /></TR></THead>
            <TBody>
              {addons.map((a) => (
                <TR key={a.key} data-testid={`console-addon-${a.key}`}>
                  <TD><div className="font-medium">{a.name}</div><code className="text-xs text-fg-subtle">{a.key}</code>{a.archived && <Badge tone="danger" className="ml-2">Archived</Badge>}{!a.isPublic && !a.archived && <Badge tone="warning" className="ml-2">Hidden</Badge>}</TD>
                  <TD className="text-[0.8125rem]">{a.kind === 'module' ? nameOf(a.featureKey) : `+${a.unitQuantity.toLocaleString()} ${nameOf(a.featureKey)}`}</TD>
                  <TD className="text-[0.8125rem] tabular">{a.prices.map((p) => money(p.monthly, p.currency)).join(' · ')}</TD>
                  <TD className="text-[0.8125rem]">{a.planKeys.length ? a.planKeys.map((k) => plans.find((p) => p.key === k)?.name ?? k).join(', ') : 'All plans'}</TD>
                  <TD className="text-right tabular">{a.workspaces}</TD>
                  <TD className="whitespace-nowrap text-right">
                    {canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>Edit</Button>}
                    {canManage && <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => done(await updateAddonAction(a.key, { archived: !a.archived })))}>{a.archived ? 'Restore' : 'Archive'}</Button>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {editing && <AddonDialog addon={editing === 'new' ? null : editing} plans={plans} onClose={() => setEditing(null)} onDone={(r) => { done(r); if (r.ok) setEditing(null); }} />}
    </div>
  );
}

function AddonDialog({ addon, plans, onClose, onDone }: { addon: ConsoleAddon | null; plans: { key: string; name: string }[]; onClose: () => void; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [v, setV] = useState({
    key: addon?.key ?? '', name: addon?.name ?? '', description: addon?.description ?? '', kind: addon?.kind ?? 'module', featureKey: addon?.featureKey ?? '',
    unitQuantity: String(addon?.unitQuantity ?? 1), isPublic: addon?.isPublic ?? true, planKeys: new Set(addon?.planKeys ?? []),
    prices: Object.fromEntries(BILLING_CURRENCIES.map((c) => { const p = addon?.prices.find((x) => x.currency === c); return [c, { monthly: p?.monthly ?? '', annualPerMonth: p?.annualPerMonth ?? '' }]; })) as Record<string, { monthly: string; annualPerMonth: string }>,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const options = DEFS.filter((f) => (v.kind === 'module' ? f.kind === 'boolean' : f.kind === 'limit'));
  const save = () => start(async () => {
    const prices = BILLING_CURRENCIES.filter((c) => v.prices[c]!.monthly.trim()).map((c) => ({ currency: c, monthly: v.prices[c]!.monthly.trim(), annualPerMonth: v.prices[c]!.annualPerMonth.trim() || v.prices[c]!.monthly.trim() }));
    const common = { name: v.name.trim(), description: v.description.trim() || undefined, unitQuantity: Number(v.unitQuantity), prices, planKeys: [...v.planKeys], isPublic: v.isPublic };
    const r = addon ? await updateAddonAction(addon.key, common) : await createAddonAction({ ...common, key: v.key.trim(), kind: v.kind, featureKey: v.featureKey });
    if (!r.ok) { setError(r.message); setErrors(r.fieldErrors ?? {}); } else onDone(r);
  });
  return (
    <Dialog open onClose={onClose} size="lg" title={addon ? `Edit ${addon.name}` : 'New add-on'} description="Price changes apply to new purchases; workspaces that have it keep their price until they remove it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save} data-testid="addon-save">Save add-on</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required error={errors.name}>{(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} data-testid="addon-name" />}</Field>
          <Field label="Key" required error={errors.key} hint="Lower-case, for example extra_ai">{(p) => <Input {...p} value={v.key} disabled={Boolean(addon)} onChange={(e) => setV({ ...v, key: e.target.value })} data-testid="addon-key" />}</Field>
        </div>
        <Field label="Description">{(p) => <Input {...p} value={v.description} maxLength={300} onChange={(e) => setV({ ...v, description: e.target.value })} />}</Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Kind">{(p) => <Select {...p} value={v.kind} disabled={Boolean(addon)} onChange={(e) => setV({ ...v, kind: e.target.value as 'module' | 'limit', featureKey: '' })}><option value="module">A module</option><option value="limit">More of a limit</option></Select>}</Field>
          <Field label={v.kind === 'module' ? 'Module' : 'Limit'} required error={errors.featureKey}>{(p) => (
            <Select {...p} value={v.featureKey} disabled={Boolean(addon)} onChange={(e) => setV({ ...v, featureKey: e.target.value })} data-testid="addon-feature">
              <option value="">Choose</option>
              {options.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
            </Select>
          )}</Field>
          {v.kind === 'limit' && <Field label="Each unit adds" error={errors.unitQuantity}>{(p) => <Input {...p} type="number" min={1} value={v.unitQuantity} onChange={(e) => setV({ ...v, unitQuantity: e.target.value })} data-testid="addon-unit" />}</Field>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {BILLING_CURRENCIES.map((c) => (
            <div key={c} className="grid grid-cols-2 gap-2">
              <Field label={`${c} per month`} error={errors.prices}>{(p) => <Input {...p} inputMode="decimal" value={v.prices[c]!.monthly} onChange={(e) => setV({ ...v, prices: { ...v.prices, [c]: { ...v.prices[c]!, monthly: e.target.value } } })} data-testid={`addon-price-${c}`} />}</Field>
              <Field label={`${c} annual / month`}>{(p) => <Input {...p} inputMode="decimal" value={v.prices[c]!.annualPerMonth} placeholder="Same" onChange={(e) => setV({ ...v, prices: { ...v.prices, [c]: { ...v.prices[c]!, annualPerMonth: e.target.value } } })} />}</Field>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1.5 text-[0.8125rem] font-medium">Plans it can be bought on (none ticked means all)</div>
          <div className="flex flex-wrap gap-3">
            {plans.map((p) => <Checkbox key={p.key} label={p.name} checked={v.planKeys.has(p.key)} onChange={(e) => { const n = new Set(v.planKeys); if (e.target.checked) n.add(p.key); else n.delete(p.key); setV({ ...v, planKeys: n }); }} />)}
          </div>
        </div>
        <Checkbox label="Shown to workspace admins" checked={v.isPublic} onChange={(e) => setV({ ...v, isPublic: e.target.checked })} />
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------------------------------------------

export function CouponsPanel({ coupons, plans, canManage }: { coupons: ConsoleCoupon[]; plans: { key: string; name: string }[]; canManage: boolean }) {
  const { note, done } = useDone();
  const [creating, setCreating] = useState(false);
  const [pending, start] = useTransition();
  const describe = (c: ConsoleCoupon) => `${c.kind === 'percent' ? `${c.value}% off` : `${money(c.value, c.currency ?? 'INR')} off`} ${c.duration === 'once' ? 'the first invoice' : c.duration === 'forever' ? 'every invoice' : `${c.cycles} invoices`}`;
  return (
    <div className="grid gap-4">
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <Card>
        <CardHeader title="Coupon codes" description="Workspace admins type a code when they change plan. Each workspace can use a code once." action={canManage ? <Button size="sm" onClick={() => setCreating(true)} data-testid="coupon-new"><Plus className="size-3.5" />New coupon</Button> : undefined} />
        {coupons.length === 0 ? <CardBody><EmptyState title="No coupons yet" /></CardBody> : (
          <Table aria-label="Coupons">
            <THead><TR><TH>Code</TH><TH>Gives</TH><TH>Plans</TH><TH className="text-right">Used</TH><TH>Valid until</TH><TH>On</TH></TR></THead>
            <TBody>
              {coupons.map((c) => (
                <TR key={c.id} data-testid={`coupon-${c.code}`}>
                  <TD><code className="text-xs font-semibold">{c.code}</code><div className="text-xs text-fg-muted">{c.name}{c.partner ? ` · ${c.partner}` : ''}</div></TD>
                  <TD className="text-[0.8125rem]">{describe(c)}</TD>
                  <TD className="text-[0.8125rem]">{c.planKeys.length ? c.planKeys.map((k) => plans.find((p) => p.key === k)?.name ?? k).join(', ') : 'All plans'}</TD>
                  <TD className="text-right tabular">{c.redeemed}{c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}</TD>
                  <TD className="text-[0.8125rem]">{c.validUntil ? day(c.validUntil) : 'No end'}</TD>
                  <TD><Switch checked={c.active} disabled={!canManage || pending} label={`${c.code} on`} onChange={(next) => start(async () => done(await setCouponActiveAction(c.id, next)))} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {creating && <CouponDialog plans={plans} onClose={() => setCreating(false)} onDone={(r) => { done(r); if (r.ok) setCreating(false); }} />}
    </div>
  );
}

function CouponDialog({ plans, onClose, onDone }: { plans: { key: string; name: string }[]; onClose: () => void; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [v, setV] = useState({ code: '', name: '', kind: 'percent', value: '', currency: 'INR', duration: 'once', cycles: '3', maxRedemptions: '', validUntil: '', partner: '', planKeys: new Set<string>() });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const r = await createCouponAction({
      code: v.code.trim(), name: v.name.trim(), kind: v.kind, value: v.value.trim(), ...(v.kind === 'amount' ? { currency: v.currency } : {}), duration: v.duration,
      ...(v.duration === 'repeating' ? { cycles: Number(v.cycles) } : {}), planKeys: [...v.planKeys],
      ...(v.maxRedemptions ? { maxRedemptions: Number(v.maxRedemptions) } : {}), ...(v.validUntil ? { validUntil: v.validUntil } : {}), ...(v.partner.trim() ? { partner: v.partner.trim() } : {}),
    });
    if (!r.ok) { setError(r.message); setErrors(r.fieldErrors ?? {}); } else onDone(r);
  });
  return (
    <Dialog open onClose={onClose} size="lg" title="New coupon" description="A discount on subscription invoices. Partner codes show up in the revenue report under the partner's name."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save} data-testid="coupon-save">Create coupon</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" required error={errors.code}>{(p) => <Input {...p} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} data-testid="coupon-code" />}</Field>
          <Field label="Name" required error={errors.name}>{(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} data-testid="coupon-name" />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Discount">{(p) => <Select {...p} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}><option value="percent">Percent off</option><option value="amount">Amount off</option></Select>}</Field>
          <Field label={v.kind === 'percent' ? 'Percent' : 'Amount'} required error={errors.value}>{(p) => <Input {...p} inputMode="decimal" value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} data-testid="coupon-value" />}</Field>
          {v.kind === 'amount' && <Field label="Currency" error={errors.currency}>{(p) => <Select {...p} value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })}>{BILLING_CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>}</Field>}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Applies to">{(p) => <Select {...p} value={v.duration} onChange={(e) => setV({ ...v, duration: e.target.value })}><option value="once">The first invoice</option><option value="repeating">Several invoices</option><option value="forever">Every invoice</option></Select>}</Field>
          {v.duration === 'repeating' && <Field label="How many invoices" error={errors.cycles}>{(p) => <Input {...p} type="number" min={1} max={36} value={v.cycles} onChange={(e) => setV({ ...v, cycles: e.target.value })} />}</Field>}
          <Field label="Most uses" hint="Empty means no limit" error={errors.maxRedemptions}>{(p) => <Input {...p} type="number" min={1} value={v.maxRedemptions} onChange={(e) => setV({ ...v, maxRedemptions: e.target.value })} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Valid until" error={errors.validUntil}>{(p) => <Input {...p} type="date" value={v.validUntil} onChange={(e) => setV({ ...v, validUntil: e.target.value })} />}</Field>
          <Field label="Partner or reseller">{(p) => <Input {...p} value={v.partner} maxLength={80} onChange={(e) => setV({ ...v, partner: e.target.value })} />}</Field>
        </div>
        <div>
          <div className="mb-1.5 text-[0.8125rem] font-medium">Plans (none ticked means all)</div>
          <div className="flex flex-wrap gap-3">
            {plans.map((p) => <Checkbox key={p.key} label={p.name} checked={v.planKeys.has(p.key)} onChange={(e) => { const n = new Set(v.planKeys); if (e.target.checked) n.add(p.key); else n.delete(p.key); setV({ ...v, planKeys: n }); }} />)}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------------------------------------------

const days = (s: string) => s.split(/[\s,]+/).filter(Boolean).map(Number);

export function SettingsPanel({ settings, canManage }: { settings: BillingSettingsInput; canManage: boolean }) {
  const { note, done } = useDone();
  const [v, setV] = useState(() => ({ ...settings, seller: { ...settings.seller }, reminderText: settings.reminderDays.join(', '), trialText: settings.trialReminderDays.join(', ') }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const seller = (k: keyof BillingSettingsInput['seller']) => (e: { target: { value: string } }) => setV({ ...v, seller: { ...v.seller, [k]: e.target.value } });
  const save = () => start(async () => {
    const { reminderText, trialText, ...rest } = v;
    const r = await saveBillingSettingsAction({ ...rest, reminderDays: days(reminderText), trialReminderDays: days(trialText), paymentTermsDays: Number(v.paymentTermsDays), graceDays: Number(v.graceDays) });
    setErrors(r.ok ? {} : r.fieldErrors ?? {});
    done(r);
  });
  const dis = !canManage;
  return (
    <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      {!canManage && <Alert tone="info">Only Super admins and billing operations can change these.</Alert>}
      <Card>
        <CardHeader title="Seller" description="SAMPLEDGE as printed on every invoice. With a GSTIN, invoices are GST tax invoices." />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label="Legal name" required error={errors['seller.legalName']}>{(p) => <Input {...p} value={v.seller.legalName} disabled={dis} onChange={seller('legalName')} />}</Field>
          <Field label="Billing email" required error={errors['seller.email']}>{(p) => <Input {...p} type="email" value={v.seller.email} disabled={dis} onChange={seller('email')} />}</Field>
          <Field label="Address" required error={errors['seller.addressLine1']}>{(p) => <Input {...p} value={v.seller.addressLine1} disabled={dis} onChange={seller('addressLine1')} />}</Field>
          <Field label="Address line 2">{(p) => <Input {...p} value={v.seller.addressLine2 ?? ''} disabled={dis} onChange={seller('addressLine2')} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City" required error={errors['seller.city']}>{(p) => <Input {...p} value={v.seller.city} disabled={dis} onChange={seller('city')} />}</Field>
            <Field label="Postal code" required error={errors['seller.postalCode']}>{(p) => <Input {...p} value={v.seller.postalCode} disabled={dis} onChange={seller('postalCode')} />}</Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Country" required error={errors['seller.countryCode']}>{(p) => <Input {...p} value={v.seller.countryCode} maxLength={2} disabled={dis} onChange={(e) => setV({ ...v, seller: { ...v.seller, countryCode: e.target.value.toUpperCase() } })} />}</Field>
            <Field label="State" error={errors['seller.stateCode']}>{(p) => (
              <Select {...p} value={v.seller.stateCode ?? ''} disabled={dis} onChange={seller('stateCode')}>
                <option value="">None</option>
                {Object.entries(GST_STATES).sort((a, b) => a[1].localeCompare(b[1])).map(([c, n]) => <option key={c} value={c}>{n} ({c})</option>)}
              </Select>
            )}</Field>
          </div>
          <Field label="GSTIN" error={errors['seller.gstin']}>{(p) => <Input {...p} className="font-mono uppercase" maxLength={15} value={v.seller.gstin ?? ''} disabled={dis} onChange={seller('gstin')} data-testid="seller-gstin" />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="PAN" error={errors['seller.pan']}>{(p) => <Input {...p} className="font-mono uppercase" maxLength={10} value={v.seller.pan ?? ''} disabled={dis} onChange={seller('pan')} />}</Field>
            <Field label="SAC code" error={errors['seller.sac']}>{(p) => <Input {...p} value={v.seller.sac} disabled={dis} onChange={seller('sac')} />}</Field>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Tax and invoice numbers" description="GST applies to Indian customers: CGST and SGST in the seller's state, IGST elsewhere in India. Other countries get the other tax, or none." />
        <CardBody className="grid gap-4 md:grid-cols-3">
          <Field label="Invoice prefix" error={errors.invoicePrefix} hint="Numbers look like SC2627-000123">{(p) => <Input {...p} value={v.invoicePrefix} maxLength={5} disabled={dis} onChange={(e) => setV({ ...v, invoicePrefix: e.target.value.toUpperCase() })} />}</Field>
          <Field label="GST rate (%)" error={errors.gstRate}>{(p) => <Input {...p} value={v.gstRate} disabled={dis} onChange={(e) => setV({ ...v, gstRate: e.target.value })} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Other tax (%)" error={errors.otherTaxRate}>{(p) => <Input {...p} value={v.otherTaxRate} disabled={dis} onChange={(e) => setV({ ...v, otherTaxRate: e.target.value })} />}</Field>
            <Field label="Its name" error={errors.otherTaxLabel}>{(p) => <Input {...p} value={v.otherTaxLabel} disabled={dis} onChange={(e) => setV({ ...v, otherTaxLabel: e.target.value })} />}</Field>
          </div>
          <Checkbox className="md:col-span-3" label="Exports from India are zero-rated under LUT" description="Customers outside India pay no GST; the invoice carries the export declaration." checked={v.exportZeroRated} disabled={dis} onChange={(e) => setV({ ...v, exportZeroRated: e.target.checked })} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Payment and reminders" description="When invoices are due, when admins are reminded, and when an unpaid workspace becomes read-only." />
        <CardBody className="grid gap-4 md:grid-cols-3">
          <Field label="Days to pay" error={errors.paymentTermsDays}>{(p) => <Input {...p} type="number" min={0} max={90} value={String(v.paymentTermsDays)} disabled={dis} onChange={(e) => setV({ ...v, paymentTermsDays: Number(e.target.value) })} />}</Field>
          <Field label="Reminders, days after the due date" error={errors.reminderDays} hint="For example 1, 3, 7">{(p) => <Input {...p} value={v.reminderText} disabled={dis} onChange={(e) => setV({ ...v, reminderText: e.target.value })} />}</Field>
          <Field label="Read-only after (days overdue)" error={errors.graceDays}>{(p) => <Input {...p} type="number" min={1} max={120} value={String(v.graceDays)} disabled={dis} onChange={(e) => setV({ ...v, graceDays: Number(e.target.value) })} />}</Field>
          <Checkbox label="Make unpaid workspaces read-only" description="People can still view and pay; nothing can be changed." checked={v.lockAfterGrace} disabled={dis} onChange={(e) => setV({ ...v, lockAfterGrace: e.target.checked })} />
          <Field label="Trial reminders, days before the end" error={errors.trialReminderDays}>{(p) => <Input {...p} value={v.trialText} disabled={dis} onChange={(e) => setV({ ...v, trialText: e.target.value })} />}</Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Payment gateway per currency" description="Which service collects online payments. Its keys are set in Integrations; without them, invoices are paid by bank transfer." />
        <CardBody className="grid gap-4 md:grid-cols-2">
          {BILLING_CURRENCIES.map((c) => (
            <Field key={c} label={c}>{(p) => (
              <Select {...p} value={v.gateways[c] ?? 'none'} disabled={dis} onChange={(e) => setV({ ...v, gateways: { ...v.gateways, [c]: e.target.value as (typeof GATEWAY_CHOICES)[number] } })} data-testid={`gateway-${c}`}>
                <option value="razorpay">Razorpay</option><option value="stripe">Stripe</option><option value="none">None (bank transfer)</option>
              </Select>
            )}</Field>
          ))}
          <p className="text-xs text-fg-muted md:col-span-2"><Link href="/integrations" className="text-accent hover:underline">Open Integrations</Link> to add the Razorpay or Stripe keys and webhook secret.</p>
        </CardBody>
      </Card>
      {canManage && <div><Button type="submit" loading={pending} data-testid="billing-settings-save">Save billing settings</Button></div>}
    </form>
  );
}

// -----------------------------------------------------------------------------------------------------------------

export function EventsPanel({ events }: { events: PaymentEvent[] }) {
  return (
    <Card>
      <CardHeader title="Payment events" description="The latest notifications from Razorpay and Stripe and what SampCrew did with each. Notifications with a wrong signature are refused and listed in Platform audit." />
      {events.length === 0 ? <CardBody><EmptyState title="No payment events yet" description="They appear once a workspace pays online." /></CardBody> : (
        <Table aria-label="Payment events">
          <THead><TR><TH>Received</TH><TH>From</TH><TH>Event</TH><TH>Result</TH></TR></THead>
          <TBody>
            {events.map((e) => (
              <TR key={`${e.provider}-${e.eventId}`}>
                <TD className="text-[0.8125rem]">{new Date(e.receivedAt).toLocaleString('en-GB')}</TD>
                <TD>{e.provider === 'razorpay' ? 'Razorpay' : 'Stripe'}</TD>
                <TD><code className="text-xs">{e.type}</code></TD>
                <TD><Badge tone={e.status === 'processed' ? 'success' : e.status === 'ignored' ? 'neutral' : 'danger'}>{e.status}</Badge>{e.detail && <div className="mt-0.5 text-xs text-fg-muted">{e.detail}</div>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
