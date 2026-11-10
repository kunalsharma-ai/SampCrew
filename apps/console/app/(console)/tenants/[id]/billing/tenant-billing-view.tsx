'use client';
import { BILLING_CURRENCIES, FEATURES } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { InvoiceTable, day, money, type ConsoleInvoice } from '@/components/invoice-table';
import { manualInvoiceAction, runBillingAction, setDealAction, unlockTenantAction } from '../../../actions';

export interface TenantBilling {
  plan: { key: string; name: string }; status: string; currency: string; billingCycle: string; seats: number; unitPrice: string;
  periodStart: string | null; periodEnd: string | null; autoRenew: boolean; provider: string; savedCard: boolean; mrr: string;
  scheduledChange: { planName?: string; planKey?: string; seats?: number; billingCycle?: string; effectiveOn?: string } | null;
  trialEndsOn: string | null; trialReturn: string | null; pastDueSince: string | null; lockedAt: string | null;
  deal: { unitPrice: string | null; discountPercent: string | null; features: string[]; endsOn: string | null; partner: string | null; note: string | null } | null; dealActive: boolean;
  coupon: { code: string; name: string; cyclesLeft: number | null } | null;
  addons: { key: string; name: string; quantity: number; unitPrice: string; endsAtPeriodEnd: boolean }[];
  profile: { legalName: string; gstin: string | null; stateCode: string | null; countryCode: string; email: string } | null;
  invoices: ConsoleInvoice[];
  orders: { id: string; provider: string; purpose: string; status: string; amount: string; currency: string; description: string; createdAt: string; paidAt: string | null; failureReason: string | null }[];
  usage: { key: string; name: string; unit: string; used: number; limit: number | null; percent: number | null; policy: string }[];
}

const MODULES = (FEATURES as readonly { key: string; name: string; kind: string }[]).filter((f) => f.kind === 'boolean');
const nameOf = (k: string) => MODULES.find((f) => f.key === k)?.name ?? k;

export function TenantBillingView({ tenantId, b, canManage }: { tenantId: string; b: TenantBilling; canManage: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [dialog, setDialog] = useState<'deal' | 'invoice' | 'unlock' | null>(null);
  const [pending, start] = useTransition();
  const done = (r: { ok: boolean; message?: string }) => {
    setNote(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message ?? 'Something went wrong' });
    if (r.ok) { setDialog(null); router.refresh(); }
  };
  const m = (v: string) => money(v, b.currency);
  return (
    <div className="grid gap-5">
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      {b.lockedAt && (
        <Alert tone="danger" title="Read-only for an overdue invoice" data-testid="tenant-locked">
          Since {day(b.lockedAt)}. People can view and pay but not make changes. {canManage && <button type="button" className="ml-1 font-medium underline" onClick={() => setDialog('unlock')}>Lift for 7 days</button>}
        </Alert>
      )}
      {!b.lockedAt && b.pastDueSince && <Alert tone="warning">Payment overdue since {day(b.pastDueSince)}. Reminders are being sent.</Alert>}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Subscription" description="What this workspace pays and when." action={canManage ? <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => { const r = await runBillingAction(tenantId); done({ ok: r.ok, message: r.ok ? 'Billing checked for this workspace.' : r.message }); })}>Run billing now</Button> : undefined} />
          <CardBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.8125rem]">
              <dt className="text-fg-muted">Plan</dt><dd>{b.plan.name} <Badge tone={b.status === 'active' ? 'success' : b.status === 'trialing' ? 'accent' : 'warning'}>{b.status}</Badge></dd>
              <dt className="text-fg-muted">Seats</dt><dd className="tabular">{b.seats} × {m(b.unitPrice)} per month, billed {b.billingCycle}</dd>
              <dt className="text-fg-muted">MRR</dt><dd className="tabular" data-testid="tenant-mrr">{m(b.mrr)}</dd>
              <dt className="text-fg-muted">Period</dt><dd>{day(b.periodStart)} to {day(b.periodEnd)} · {b.autoRenew ? 'renews' : 'ends then'}</dd>
              {b.trialEndsOn && <><dt className="text-fg-muted">Trial</dt><dd>ends {day(b.trialEndsOn)}{b.trialReturn ? `, then back to ${b.trialReturn}` : ''}</dd></>}
              {b.scheduledChange && <><dt className="text-fg-muted">Scheduled</dt><dd>{b.scheduledChange.planName ?? b.scheduledChange.planKey}, {b.scheduledChange.seats} seats from {day(b.scheduledChange.effectiveOn ?? b.periodEnd)}</dd></>}
              <dt className="text-fg-muted">Payment</dt><dd>{b.savedCard ? 'Saved card (Stripe), charged at renewal' : b.provider === 'manual' ? 'Bank transfer' : b.provider}</dd>
              {b.coupon && <><dt className="text-fg-muted">Coupon</dt><dd>{b.coupon.code} ({b.coupon.name}){b.coupon.cyclesLeft !== null ? `, ${b.coupon.cyclesLeft} invoice(s) left` : ''}</dd></>}
              <dt className="text-fg-muted">Bills to</dt><dd>{b.profile ? `${b.profile.legalName}${b.profile.gstin ? ` · GSTIN ${b.profile.gstin}` : ''} · ${b.profile.email}` : 'No billing details yet'}</dd>
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Contract terms" description="A price per seat, a discount or extra modules agreed with this workspace, until an end date." action={canManage ? <Button size="sm" onClick={() => setDialog('deal')} data-testid="deal-edit">Edit terms</Button> : undefined} />
          <CardBody className="text-[0.8125rem]">
            {!b.deal ? <p className="text-fg-muted">List prices. No contract terms.</p> : (
              <div className="grid gap-1" data-testid="deal-summary">
                {!b.dealActive && <Badge tone="warning">Ended</Badge>}
                {b.deal.unitPrice && <div>{m(b.deal.unitPrice)} per seat per month</div>}
                {b.deal.discountPercent && <div>{b.deal.discountPercent}% off every invoice</div>}
                {b.deal.features.length > 0 && <div>Also includes {b.deal.features.map(nameOf).join(', ')}</div>}
                <div className="text-fg-muted">{b.deal.endsOn ? `Until ${day(b.deal.endsOn)}` : 'No end date'}{b.deal.partner ? ` · through ${b.deal.partner}` : ''}</div>
                {b.deal.note && <div className="text-fg-muted">{b.deal.note}</div>}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Usage" description="Against each limit of the plan, add-ons and contract." />
          <Table aria-label="Usage">
            <THead><TR><TH>Limit</TH><TH className="text-right">Used</TH><TH>Beyond it</TH></TR></THead>
            <TBody>
              {b.usage.map((u) => (
                <TR key={u.key}><TD>{u.name}</TD><TD className="text-right tabular">{u.used.toLocaleString()}{u.limit !== null && u.limit !== -1 ? ` / ${u.limit.toLocaleString()} (${u.percent ?? 0}%)` : ''}</TD><TD>{u.policy === 'overage' ? 'Billed' : 'Blocked'}</TD></TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Add-ons" description="Bought by the workspace on Plan & billing." />
          {b.addons.length === 0 ? <CardBody><p className="text-[0.8125rem] text-fg-muted">None.</p></CardBody> : (
            <Table aria-label="Add-ons">
              <THead><TR><TH>Add-on</TH><TH className="text-right">Quantity</TH><TH className="text-right">Per month</TH></TR></THead>
              <TBody>{b.addons.map((a) => <TR key={a.key}><TD>{a.name}{a.endsAtPeriodEnd && <Badge tone="warning" className="ml-2">ends at renewal</Badge>}</TD><TD className="text-right tabular">{a.quantity}</TD><TD className="text-right tabular">{m(a.unitPrice)}</TD></TR>)}</TBody>
            </Table>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Invoices" description="Everything SampCrew has invoiced this workspace." action={canManage ? <Button size="sm" onClick={() => setDialog('invoice')} data-testid="manual-invoice">Issue an invoice</Button> : undefined} />
        <CardBody><InvoiceTable invoices={b.invoices} canManage={canManage} showWorkspace={false} /></CardBody>
      </Card>

      <Card>
        <CardHeader title="Online payments" description="Checkouts sent to Razorpay or Stripe and whether they were confirmed." />
        {b.orders.length === 0 ? <CardBody><p className="text-[0.8125rem] text-fg-muted">None yet.</p></CardBody> : (
          <Table aria-label="Online payments">
            <THead><TR><TH>Started</TH><TH>For</TH><TH>Through</TH><TH>Status</TH><TH className="text-right">Amount</TH></TR></THead>
            <TBody>
              {b.orders.map((o) => (
                <TR key={o.id}>
                  <TD className="text-[0.8125rem]">{day(o.createdAt)}</TD>
                  <TD className="text-[0.8125rem]">{o.description}</TD>
                  <TD>{o.provider === 'razorpay' ? 'Razorpay' : 'Stripe'}</TD>
                  <TD><Badge tone={o.status === 'paid' ? 'success' : o.status === 'created' ? 'neutral' : 'danger'}>{o.status}</Badge>{o.failureReason && <div className="mt-0.5 text-xs text-fg-muted">{o.failureReason}</div>}</TD>
                  <TD className="text-right tabular">{money(o.amount, o.currency)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {dialog === 'deal' && <DealDialog tenantId={tenantId} b={b} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'invoice' && <ManualInvoiceDialog tenantId={tenantId} currency={b.currency} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'unlock' && <UnlockDialog tenantId={tenantId} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

function DealDialog({ tenantId, b, onClose, onDone }: { tenantId: string; b: TenantBilling; onClose: () => void; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const d = b.deal;
  const [v, setV] = useState({ unitPrice: d?.unitPrice ?? '', discountPercent: d?.discountPercent ?? '', endsOn: d?.endsOn ?? '', partner: d?.partner ?? '', note: d?.note ?? '', features: new Set(d?.features ?? []) });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const r = await setDealAction(tenantId, {
      unitPrice: v.unitPrice.trim() || null, discountPercent: v.discountPercent.trim() || null, endsOn: v.endsOn || null,
      features: [...v.features], partner: v.partner.trim() || undefined, note: v.note.trim() || undefined,
    });
    if (!r.ok) { setError(r.message); setErrors(r.fieldErrors ?? {}); } else onDone(r);
  });
  return (
    <Dialog open onClose={onClose} size="lg" title="Contract terms" description={`Applies to the ${b.plan.name} plan from the next invoice. Leave everything empty to go back to list prices.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save} data-testid="deal-save">Save terms</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={`Price per seat per month (${b.currency})`} error={errors.unitPrice} hint={`List price ${money(b.unitPrice, b.currency)}`}>{(p) => <Input {...p} inputMode="decimal" value={v.unitPrice} onChange={(e) => setV({ ...v, unitPrice: e.target.value })} data-testid="deal-price" />}</Field>
          <Field label="Discount (%)" error={errors.discountPercent}>{(p) => <Input {...p} inputMode="decimal" value={v.discountPercent} onChange={(e) => setV({ ...v, discountPercent: e.target.value })} data-testid="deal-discount" />}</Field>
          <Field label="Ends on" error={errors.endsOn}>{(p) => <Input {...p} type="date" value={v.endsOn} onChange={(e) => setV({ ...v, endsOn: e.target.value })} />}</Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Partner or reseller">{(p) => <Input {...p} value={v.partner} maxLength={80} onChange={(e) => setV({ ...v, partner: e.target.value })} />}</Field>
          <Field label="Note">{(p) => <Input {...p} value={v.note} maxLength={500} onChange={(e) => setV({ ...v, note: e.target.value })} />}</Field>
        </div>
        <div>
          <div className="mb-1.5 text-[0.8125rem] font-medium">Extra modules while the terms run</div>
          <div className="grid max-h-56 gap-1.5 overflow-y-auto sm:grid-cols-2">
            {MODULES.map((f) => <Checkbox key={f.key} label={f.name} checked={v.features.has(f.key)} onChange={(e) => { const n = new Set(v.features); if (e.target.checked) n.add(f.key); else n.delete(f.key); setV({ ...v, features: n }); }} />)}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function ManualInvoiceDialog({ tenantId, currency, onClose, onDone }: { tenantId: string; currency: string; onClose: () => void; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [v, setV] = useState({ description: '', amount: '', currency });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title="Issue an invoice" description="A one-off charge, such as onboarding or consulting. Tax is added from the billing settings; the workspace's billing admins are notified."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} data-testid="manual-invoice-save" onClick={() => start(async () => {
        const r = await manualInvoiceAction(tenantId, { description: v.description.trim(), amount: v.amount.trim(), currency: v.currency });
        if (!r.ok) { setError(r.message); setErrors(r.fieldErrors ?? {}); } else onDone({ ok: true, message: `Invoice ${r.data!.number} issued.` });
      })}>Issue invoice</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Description" required error={errors.description}>{(p) => <Input {...p} value={v.description} maxLength={200} onChange={(e) => setV({ ...v, description: e.target.value })} data-testid="manual-invoice-description" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount before tax" required error={errors.amount}>{(p) => <Input {...p} inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} data-testid="manual-invoice-amount" />}</Field>
          <Field label="Currency">{(p) => <Select {...p} value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })}>{BILLING_CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
        </div>
      </div>
    </Dialog>
  );
}

function UnlockDialog({ tenantId, onClose, onDone }: { tenantId: string; onClose: () => void; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title="Lift the read-only lock" description="For 7 days, for example while a bank transfer is on its way. Reminders continue; the lock comes back if the invoice is still unpaid."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={reason.trim().length < 5} data-testid="unlock-confirm" onClick={() => start(async () => {
        const r = await unlockTenantAction(tenantId, reason.trim());
        if (!r.ok) setError(r.message); else onDone(r);
      })}>Lift for 7 days</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Reason" required hint="Recorded in both audit trails">{(p) => <Input {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="unlock-reason" />}</Field>
      </div>
    </Dialog>
  );
}
