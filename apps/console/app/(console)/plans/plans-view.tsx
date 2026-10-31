'use client';
import { planPriceUpdate } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Pencil } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setPriceAction } from '../actions';

export interface PlatformPlan {
  id: string; key: string; name: string; tagline: string; quoteOnly: boolean; minimumSeats: number; isPublic: boolean; tenants: number;
  prices: { currency: string; monthly: string; annualPerMonth: string }[];
  features: { key: string; limitValue: number | null }[];
}

export function PlansView({ plans, canEdit }: { plans: PlatformPlan[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<{ plan: PlatformPlan; currency: 'USD' | 'INR' } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      {note && <Alert tone="success">{note}</Alert>}
      {plans.map((p) => (
        <Card key={p.key}>
          <CardHeader
            title={<span className="flex items-center gap-2">{p.name}{p.quoteOnly && <Badge>Quote only</Badge>}{!p.isPublic && <Badge tone="warning">Hidden</Badge>}</span>}
            description={`${p.tagline} · minimum ${p.minimumSeats} seats · ${p.tenants} workspace(s)`}
          />
          <CardBody className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <Table>
              <THead><TR><TH>Currency</TH><TH className="text-right">Monthly / seat</TH><TH className="text-right">Annual / seat / month</TH>{canEdit && <TH />}</TR></THead>
              <TBody>
                {(['USD', 'INR'] as const).map((c) => {
                  const pr = p.prices.find((x) => x.currency === c);
                  return (
                    <TR key={c}>
                      <TD>{c}</TD>
                      <TD className="text-right tabular">{pr?.monthly ?? '—'}</TD>
                      <TD className="text-right tabular">{pr?.annualPerMonth ?? '—'}</TD>
                      {canEdit && <TD className="text-right"><Button size="sm" variant="ghost" aria-label={`Edit ${p.name} ${c} price`} onClick={() => setEditing({ plan: p, currency: c })}><Pencil className="size-3.5" /></Button></TD>}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <div className="flex flex-wrap content-start gap-1.5">
              {p.features.map((f) => <Badge key={f.key} tone={f.limitValue === null ? 'accent' : 'neutral'}>{f.key}{f.limitValue !== null ? `: ${f.limitValue === -1 ? 'unlimited' : f.limitValue}` : ''}</Badge>)}
            </div>
          </CardBody>
        </Card>
      ))}
      {editing && <PriceDialog {...editing} onClose={() => setEditing(null)} onSaved={(n) => { setNote(n); setEditing(null); }} />}
    </div>
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
