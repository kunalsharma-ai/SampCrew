'use client';
import { BGV_CHECK_LABEL, BGV_CHECK_TYPES } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, Checkbox, Dialog, EmptyState, Field, Input, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Building2, Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
import { saveAgencyAction } from '../actions';
import type { Agency } from '../types';

export function AgenciesView({ agencies, canManage }: { agencies: Agency[]; canManage: boolean }) {
  const [editing, setEditing] = useState<Agency | 'new' | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  return (
    <div className="grid gap-6">
      {flash && <Alert tone="success">{flash}</Alert>}
      <Card>
        <CardBody className="flex items-center justify-between gap-3">
          <p className="text-[0.8125rem] text-fg-muted">{agencies.filter((a) => a.active).length} active of {agencies.length}</p>
          {canManage && <Button onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden /> Add agency</Button>}
        </CardBody>
        {agencies.length ? (
          <Table aria-label="Verification agencies">
            <THead><tr><TH>Agency</TH><TH>Contact</TH><TH>Checks they do</TH><TH>Turnaround</TH><TH>Status</TH><TH /></tr></THead>
            <TBody>
              {agencies.map((a) => (
                <TR key={a.id}>
                  <TD className="font-medium">{a.name}{a.website && <div className="text-xs text-fg-muted">{a.website}</div>}</TD>
                  <TD>{a.contactName ?? '—'}<div className="text-xs text-fg-muted">{a.email}{a.phone ? ` · ${a.phone}` : ''}</div></TD>
                  <TD className="text-fg-muted">{a.services.map((s) => BGV_CHECK_LABEL[s as keyof typeof BGV_CHECK_LABEL]).join(', ')}</TD>
                  <TD>{a.turnaroundDays ? `${a.turnaroundDays} days` : '—'}</TD>
                  <TD><Badge tone={a.active ? 'success' : 'neutral'}>{a.active ? 'Active' : 'Switched off'}</Badge></TD>
                  <TD className="text-right">{canManage && <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>Edit</Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <CardBody><EmptyState icon={<Building2 className="size-5" />} title="No agencies yet" description="Add the agencies you work with to assign verification cases to them." /></CardBody>}
      </Card>
      {editing && <AgencyDialog agency={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(m) => { setFlash(m); setEditing(null); }} />}
    </div>
  );
}

function AgencyDialog({ agency, onClose, onSaved }: { agency: Agency | null; onClose: () => void; onSaved: (m: string) => void }) {
  const [services, setServices] = useState<string[]>(agency?.services ?? [...BGV_CHECK_TYPES]);
  const [active, setActive] = useState(agency?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} size="lg" title={agency ? `Edit ${agency.name}` : 'Add a verification agency'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="agency-form" loading={pending}>Save agency</Button></>}>
      <form id="agency-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const v = (k: string) => String(f.get(k) ?? '').trim();
        start(async () => {
          const r = await saveAgencyAction(agency?.id ?? null, {
            name: v('name'), contactName: v('contactName'), email: v('email'), phone: v('phone'), website: v('website'), address: v('address'),
            services, ...(v('turnaroundDays') ? { turnaroundDays: Number(v('turnaroundDays')) } : {}), notes: v('notes'), active,
          });
          if (r.ok) onSaved(r.message ?? 'Saved.'); else { setError(r.message); setFe(r.fieldErrors ?? {}); }
        });
      }}>
        {error && <div className="sm:col-span-2"><Alert tone="danger">{error}</Alert></div>}
        <Field label="Agency name" required error={fe.name}>{(p) => <Input {...p} name="name" required defaultValue={agency?.name} maxLength={160} />}</Field>
        <Field label="Contact person" error={fe.contactName}>{(p) => <Input {...p} name="contactName" defaultValue={agency?.contactName ?? ''} maxLength={160} />}</Field>
        <Field label="Email" required hint="Private links are sent here" error={fe.email}>{(p) => <Input {...p} name="email" type="email" required defaultValue={agency?.email} />}</Field>
        <Field label="Phone" error={fe.phone}>{(p) => <Input {...p} name="phone" type="tel" defaultValue={agency?.phone ?? ''} />}</Field>
        <Field label="Website" error={fe.website}>{(p) => <Input {...p} name="website" type="url" placeholder="https://" defaultValue={agency?.website ?? ''} />}</Field>
        <Field label="Turnaround (days)" error={fe.turnaroundDays}>{(p) => <Input {...p} name="turnaroundDays" type="number" min={1} max={180} defaultValue={agency?.turnaroundDays ?? ''} />}</Field>
        <Field label="Address" className="sm:col-span-2" error={fe.address}>{(p) => <Textarea {...p} name="address" rows={2} defaultValue={agency?.address ?? ''} maxLength={500} />}</Field>
        <fieldset className="grid gap-2 sm:col-span-2">
          <legend className="mb-1 text-[0.8125rem] font-medium">Checks they do</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {BGV_CHECK_TYPES.map((t) => <Checkbox key={t} label={BGV_CHECK_LABEL[t]} checked={services.includes(t)} onChange={() => setServices((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]))} />)}
          </div>
          {fe.services && <p className="text-xs text-danger">{fe.services}</p>}
        </fieldset>
        <Field label="Notes" className="sm:col-span-2">{(p) => <Textarea {...p} name="notes" rows={2} defaultValue={agency?.notes ?? ''} maxLength={1000} />}</Field>
        <div className="sm:col-span-2"><Checkbox label="Active" description="Switched-off agencies cannot be given new cases; their old cases are kept." checked={active} onChange={(e) => setActive(e.target.checked)} /></div>
      </form>
    </Dialog>
  );
}
