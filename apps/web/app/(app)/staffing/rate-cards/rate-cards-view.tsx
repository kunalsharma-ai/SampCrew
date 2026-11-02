'use client';
import { formatAmount, type RateCardInput } from '@crew/contracts';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { archiveRateCardAction, saveRateCardAction } from '../actions';
import type { Client, RateCard } from '../types';

type Line = { roleTitle: string; payMonthly: string; billMonthly: string };
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

/** Margin a card's bill rate leaves over pay alone (before on-costs and overhead), as a quick guide. */
const spread = (l: Line) => (Number(l.billMonthly) > 0 && Number(l.payMonthly) > 0 ? Math.round((1 - Number(l.payMonthly) / Number(l.billMonthly)) * 100) : null);

export function RateCardsView({ cards, clients, canManage }: { cards: RateCard[]; clients: Client[]; canManage: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<RateCard | 'new' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {canManage && <div className="flex justify-end"><Button onClick={() => setEditing('new')}><Plus className="size-4" /> New rate card</Button></div>}
      {cards.length ? cards.map((c) => (
        <Card key={c.id} aria-label={`Rate card ${c.name}`}>
          <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
            <h2 className="text-sm font-semibold">{c.name}</h2>
            <Badge tone={c.clientId ? 'info' : 'neutral'}>{c.clientName ?? 'Any client'}</Badge>
            <Badge>{c.currency}</Badge>
            {canManage && (
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil className="size-3.5" /></Button>
                <Button size="sm" variant="ghost" aria-label={`Archive ${c.name}`} disabled={pending} onClick={() => {
                  if (!confirm(`Archive “${c.name}”? Bids that used it keep their rates.`)) return;
                  start(async () => { const r = await archiveRateCardAction(c.id); setMsg(r.ok ? { tone: 'success', text: `${c.name} archived` } : { tone: 'danger', text: r.message }); router.refresh(); });
                }}><Trash2 className="size-3.5" /></Button>
              </span>
            )}
          </div>
          {c.notes && <p className="px-5 pt-1 text-xs text-fg-subtle">{c.notes}</p>}
          <div className="mt-3 overflow-x-auto">
            <Table aria-label={`Rates in ${c.name}`}>
              <THead><TR><TH>Role</TH><TH className="text-right">Pay per month</TH><TH className="text-right">Bill rate per month</TH><TH className="text-right">Spread over pay</TH></TR></THead>
              <TBody>
                {c.lines.map((l) => (
                  <TR key={l.roleTitle}>
                    <TD className="font-medium">{l.roleTitle}</TD>
                    <TD className="text-right tabular-nums">{formatAmount(l.payMonthly, c.currency)}</TD>
                    <TD className="text-right tabular-nums">{formatAmount(l.billMonthly, c.currency)}</TD>
                    <TD className="text-right tabular-nums text-fg-muted">{spread(l) ?? '—'}%</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </Card>
      )) : <Card><EmptyState icon={<Tags className="size-5" />} title="No rate cards yet" description={canManage ? 'Add your standard rates once and every bid can start from them.' : undefined} /></Card>}
      {editing && <RateCardDialog card={editing === 'new' ? null : editing} clients={clients} onClose={() => setEditing(null)} onSaved={(name) => { setEditing(null); setMsg({ tone: 'success', text: `${name} saved` }); router.refresh(); }} />}
    </div>
  );
}

function RateCardDialog({ card, clients, onClose, onSaved }: { card: RateCard | null; clients: Client[]; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(card?.name ?? '');
  const [clientId, setClientId] = useState(card?.clientId ?? '');
  const [currency, setCurrency] = useState(card?.currency ?? 'INR');
  const [notes, setNotes] = useState(card?.notes ?? '');
  const [lines, setLines] = useState<Line[]>(card?.lines.map((l) => ({ ...l })) ?? [{ roleTitle: '', payMonthly: '', billMonthly: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const submit = () => {
    const clean = lines.map((l) => ({ roleTitle: l.roleTitle.trim(), payMonthly: l.payMonthly.replace(/,/g, ''), billMonthly: l.billMonthly.replace(/,/g, '') })).filter((l) => l.roleTitle || l.payMonthly || l.billMonthly);
    const bad = clean.findIndex((l) => l.roleTitle.length < 2 || !MONEY.test(l.payMonthly) || !MONEY.test(l.billMonthly));
    if (bad >= 0) { setError(`Check role ${bad + 1}: a name, the monthly pay and the bill rate`); return; }
    const body: RateCardInput = { name: name.trim(), clientId: clientId || null, currency, notes: notes.trim(), lines: clean };
    setError(null);
    start(async () => {
      const r = await saveRateCardAction(card?.id ?? null, body);
      if (r.ok) onSaved(body.name); else setError([r.message, ...Object.values(r.fieldErrors ?? {})].filter(Boolean).join(' '));
    });
  };
  return (
    <Dialog open onClose={onClose} title={card ? `Edit ${card.name}` : 'New rate card'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={pending}>Save rate card</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Name" required>{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Warehouse staffing 2027" />}</Field>
          <Field label="For client" hint="Empty: any client">{(f) => <Select {...f} value={clientId} onChange={(e) => { setClientId(e.target.value); const c = clients.find((x) => x.id === e.target.value); if (c) setCurrency(c.currency); }}><option value="">Any client</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
          <Field label="Currency">{(f) => <Input {...f} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />}</Field>
        </div>
        <Field label="Notes">{(f) => <Textarea {...f} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />}</Field>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_8rem_8rem_auto] items-end gap-2">
              <Input aria-label={`Role ${i + 1}`} placeholder="Role" value={l.roleTitle} maxLength={120} onChange={(e) => setLine(i, { roleTitle: e.target.value })} />
              <Input aria-label={`Pay for role ${i + 1}`} placeholder="Pay / month" inputMode="decimal" value={l.payMonthly} onChange={(e) => setLine(i, { payMonthly: e.target.value })} />
              <Input aria-label={`Bill rate for role ${i + 1}`} placeholder="Bill / month" inputMode="decimal" value={l.billMonthly} onChange={(e) => setLine(i, { billMonthly: e.target.value })} />
              <Button size="sm" variant="ghost" aria-label={`Remove role ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => setLines([...lines, { roleTitle: '', payMonthly: '', billMonthly: '' }])} disabled={lines.length >= 100}><Plus className="size-3.5" /> Add role</Button>
        </div>
      </div>
    </Dialog>
  );
}
