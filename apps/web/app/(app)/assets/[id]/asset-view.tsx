'use client';
import { ASSET_CONDITION_LABEL, ASSET_CONDITIONS, ASSET_STATUS_LABEL } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DatePicker, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Download, FileUp, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { assignAssetAction, deleteAssetAction, removeAssetFileAction, returnAssetAction, searchEmployeesAction, setStatusAction, updateAssetAction, uploadAssetFileAction } from '../actions';
import { AssetDialog } from '../inventory-view';
import { dateTime, day, EVENT_LABEL, size, today } from '../labels';
import type { AssetDetail, Category } from '../types';

type Done = (r: { ok: boolean; message?: string }) => void;
const cond = (c: string | null) => (c ? ASSET_CONDITION_LABEL[c as keyof typeof ASSET_CONDITION_LABEL] ?? c : '');
const status = (s: string | null) => (s ? ASSET_STATUS_LABEL[s as keyof typeof ASSET_STATUS_LABEL] ?? s : '');

export function AssetView({ a, categories, currency }: { a: AssetDetail; categories: Category[]; currency: string }) {
  const router = useRouter();
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [dialog, setDialog] = useState<'edit' | 'assign' | 'return' | 'status' | 'delete' | null>(null);
  const say: Done = (r) => setFlash(r.ok ? (r.message ? { tone: 'success', text: r.message } : null) : { tone: 'danger', text: r.message ?? 'Something went wrong' });
  const current = a.assignments.find((x) => x.status === 'active');
  const close = () => setDialog(null);
  const doneAndClose: Done = (r) => { say(r); if (r.ok) close(); };

  return (
    <div className="grid gap-6">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      <div className="flex flex-wrap gap-2">
        {a.can.assign && <Button onClick={() => setDialog('assign')}>Assign to an employee</Button>}
        {a.can.return && <Button onClick={() => setDialog('return')}>Record return</Button>}
        {a.can.moves.length > 0 && <Button variant="secondary" onClick={() => setDialog('status')}>Change status</Button>}
        {a.can.edit && <Button variant="secondary" onClick={() => setDialog('edit')}>Edit details</Button>}
        {a.can.delete && <Button variant="ghost" onClick={() => setDialog('delete')}>Delete</Button>}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-6">
          {current && (
            <Card>
              <CardHeader title="Current holder" />
              <CardBody className="grid gap-3 text-[0.8125rem] sm:grid-cols-2">
                <Fact label="Employee"><a className="text-accent hover:underline" href={`/employees/${current.employeeId}`}>{current.employeeName}</a>{current.employeeCode ? ` (${current.employeeCode})` : ''}</Fact>
                <Fact label="Department">{[current.department, current.designation].filter(Boolean).join(' · ') || '—'}</Fact>
                <Fact label="Assigned on">{day(current.assignedOn)} in {cond(current.conditionAtAssignment).toLowerCase()} condition{current.assignedBy ? `, by ${current.assignedBy}` : ''}</Fact>
                <Fact label="Expected back">{day(current.expectedReturnOn) || 'Not set'}</Fact>
                <div className="sm:col-span-2">
                  {current.acknowledgement ? <Acknowledgement ack={current.acknowledgement} />
                    : current.requiresAcknowledgement ? <Alert tone="warning">Not acknowledged yet. {current.employeeName} has been asked to confirm they received it.</Alert>
                    : <p className="text-fg-muted">No acknowledgement was asked for.</p>}
                </div>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Assignment history" description="Everyone who has held this asset, with their acknowledgement and how it came back." />
            {a.assignments.length ? (
              <Table aria-label="Assignment history">
                <THead><tr><TH>Employee</TH><TH>Assigned</TH><TH>Acknowledged</TH><TH>Returned</TH></tr></THead>
                <TBody>
                  {a.assignments.map((x) => (
                    <TR key={x.id}>
                      <TD>{x.employeeName}<div className="text-xs text-fg-muted">{[x.employeeCode, x.department].filter(Boolean).join(' · ')}</div></TD>
                      <TD>{day(x.assignedOn)}<div className="text-xs text-fg-muted">{cond(x.conditionAtAssignment)}</div></TD>
                      <TD>{x.acknowledgement ? dateTime(x.acknowledgement.at) : x.requiresAcknowledgement ? <Badge tone="warning">Waiting</Badge> : '—'}</TD>
                      <TD>{x.returnedOn ? <>{day(x.returnedOn)}<div className="text-xs text-fg-muted">{cond(x.conditionAtReturn)}{x.receivedBy ? ` · received by ${x.receivedBy}` : ''}{x.returnNotes ? ` · ${x.returnNotes}` : ''}</div></> : <Badge tone="info">Holding</Badge>}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : <CardBody><EmptyState title="Never assigned" description="It has stayed in stock since it was registered." /></CardBody>}
          </Card>

          <Card>
            <CardHeader title="Asset documents" description="Invoice, warranty card, photos. Downloads are recorded." />
            {a.can.edit && <CardBody><UploadAssetFile id={a.id} onDone={say} /></CardBody>}
            {a.files.length ? (
              <Table aria-label="Asset documents">
                <TBody>
                  {a.files.map((f) => (
                    <TR key={f.id}>
                      <TD><a className="font-medium text-accent hover:underline" href={`/asset-files/${f.id}`}>{f.title}</a><div className="text-xs text-fg-muted">{f.fileName} · {size(f.sizeBytes)}</div></TD>
                      <TD className="text-fg-muted">{f.uploadedBy} · {dateTime(f.createdAt)}</TD>
                      <TD className="text-right">
                        <a className="mr-1 inline-flex" href={`/asset-files/${f.id}`} aria-label={`Download ${f.title}`}><Download className="size-4 text-fg-muted" /></a>
                        {a.can.edit && <RemoveAssetFile id={a.id} fileId={f.id} title={f.title} onDone={say} />}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : !a.can.edit ? <CardBody><p className="text-[0.8125rem] text-fg-muted">No documents.</p></CardBody> : null}
          </Card>

          <Card>
            <CardHeader title="Asset history" />
            <CardBody>
              <ol className="grid gap-3">
                {a.history.map((h) => (
                  <li key={h.id} className="grid gap-0.5 border-l-2 border-border pl-3 text-[0.8125rem]">
                    <span><span className="font-medium">{EVENT_LABEL[h.kind] ?? h.kind}</span>{h.from || h.to ? ` · ${status(h.from)}${h.from && h.to ? ' → ' : ''}${status(h.to)}` : ''}</span>
                    {(h.note || h.vendor || h.cost) && <span className="text-fg-muted">{[h.note, h.vendor ? `Vendor: ${h.vendor}` : null, h.cost ? `Cost: ${currency} ${h.cost}` : null].filter(Boolean).join(' · ')}</span>}
                    <span className="text-xs text-fg-subtle">{h.by ?? 'SampCrew'} · {dateTime(h.at)}</span>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>

        <Card className="content-start">
          <CardHeader title="Asset details" />
          <CardBody className="grid gap-3 text-[0.8125rem]">
            <Fact label="Serial number"><span className="font-mono">{a.serialNumber ?? '—'}</span></Fact>
            <Fact label="Condition">{cond(a.condition)}</Fact>
            <Fact label="Location">{a.location ?? '—'}</Fact>
            <Fact label="Purchased">{a.purchaseDate ? day(a.purchaseDate) : '—'}{a.purchasePrice ? ` for ${a.currency ?? currency} ${a.purchasePrice}` : ''}{a.vendor ? ` from ${a.vendor}` : ''}</Fact>
            <Fact label="Warranty until">{day(a.warrantyExpiry) || '—'}{a.warrantyExpiry && a.warrantyExpiry < today() ? ' (ended)' : ''}</Fact>
            {a.description && <Fact label="Description">{a.description}</Fact>}
            {a.remarks && <Fact label="Remarks">{a.remarks}</Fact>}
            <Fact label="Registered">{dateTime(a.createdAt)}</Fact>
          </CardBody>
        </Card>
      </div>

      {dialog === 'edit' && <AssetDialog categories={categories} currency={currency} asset={a as never} onClose={close} onSaved={() => { close(); setFlash({ tone: 'success', text: 'Saved.' }); }} save={(body) => updateAssetAction(a.id, body)} />}
      {dialog === 'assign' && <AssignDialog id={a.id} condition={a.condition} onClose={close} onDone={doneAndClose} />}
      {dialog === 'return' && current && <ReturnDialog id={a.id} since={current.assignedOn} who={current.employeeName ?? 'the employee'} onClose={close} onDone={doneAndClose} />}
      {dialog === 'status' && <StatusDialog a={a} onClose={close} onDone={doneAndClose} />}
      {dialog === 'delete' && (
        <Dialog open onClose={close} title="Delete this asset" description="Only an asset that was never assigned can be deleted. Others are retired instead, to keep their history."
          footer={<><Button variant="secondary" onClick={close}>Keep it</Button><DeleteButton id={a.id} onDone={(r) => { if (r.ok) router.push('/assets'); else doneAndClose(r); }} /></>}>
          <p className="text-[0.8125rem]">{a.assetCode} {a.name} will be removed from the inventory.</p>
        </Dialog>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-0.5"><span className="text-xs text-fg-subtle">{label}</span><span>{children}</span></div>;
}

function Acknowledgement({ ack }: { ack: NonNullable<AssetDetail['assignments'][number]['acknowledgement']> }) {
  return (
    <div className="grid gap-1 rounded-lg border border-success/30 bg-success-subtle/40 p-3">
      <span className="font-medium text-success">Acknowledged by {ack.name} on {dateTime(ack.at)}</span>
      <span className="text-fg-muted">“{ack.text}”</span>
      {ack.comment && <span>Comment: {ack.comment}</span>}
      <span className="break-all font-mono text-[0.6875rem] text-fg-subtle">Record SHA-256 {ack.sha256}{ack.ip ? ` · from ${ack.ip}` : ''}</span>
    </div>
  );
}

function DeleteButton({ id, onDone }: { id: string; onDone: Done }) {
  const [pending, start] = useTransition();
  return <Button data-delete-area="assets" data-delete="asset" variant="danger" loading={pending} onClick={() => start(async () => onDone(await deleteAssetAction(id)))}>Delete asset</Button>;
}

function AssignDialog({ id, condition, onClose, onDone }: { id: string; condition: string; onClose: () => void; onDone: Done }) {
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<{ id: string; name: string; departmentName: string | null }[]>([]);
  const [who, setWho] = useState<{ id: string; name: string } | null>(null);
  const [assignedOn, setAssignedOn] = useState(today());
  const [expected, setExpected] = useState('');
  const [ack, setAck] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const find = () => start(async () => { const r = await searchEmployeesAction(search); setFound(r.ok ? r.data ?? [] : []); });
  return (
    <Dialog open onClose={onClose} title="Assign to an employee" description="They are notified and asked to acknowledge that they received it."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="assign-form" loading={pending} disabled={!who}>Assign</Button></>}>
      <form id="assign-form" className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          const r = await assignAssetAction(id, { employeeId: who?.id, assignedOn, expectedReturnOn: expected, condition: f.get('condition'), notes: String(f.get('notes') ?? ''), requireAcknowledgement: ack });
          if (r.ok) onDone(r); else { setError(r.message); setFe(r.fieldErrors ?? {}); }
        });
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        {who ? (
          <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.8125rem]"><span className="font-medium">{who.name}</span><Button size="sm" variant="ghost" type="button" className="ml-auto" onClick={() => setWho(null)}>Change</Button></div>
        ) : (
          <div className="grid gap-2">
            <div className="flex gap-2">
              <Input aria-label="Find the employee" placeholder="Find the employee by name or ID" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } }} />
              <Button type="button" variant="secondary" onClick={find} aria-label="Find"><Search className="size-3.5" aria-hidden /></Button>
            </div>
            {found.map((x) => <button key={x.id} type="button" className="rounded-md px-2 py-1 text-left text-[0.8125rem] hover:bg-bg-subtle" onClick={() => setWho(x)}>{x.name} <span className="text-xs text-fg-muted">{x.departmentName}</span></button>)}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assigned on" required error={fe.assignedOn}>{(p) => <DatePicker {...p} value={assignedOn} onChange={setAssignedOn} max={today()} />}</Field>
          <Field label="Expected return" error={fe.expectedReturnOn}>{(p) => <DatePicker {...p} value={expected} onChange={setExpected} min={assignedOn} />}</Field>
          <Field label="Condition when handed over">{(p) => <Select {...p} name="condition" defaultValue={condition === 'damaged' ? 'poor' : condition}>{ASSET_CONDITIONS.map((c) => <option key={c} value={c}>{ASSET_CONDITION_LABEL[c]}</option>)}</Select>}</Field>
        </div>
        <Field label="Notes">{(p) => <Textarea {...p} name="notes" rows={2} maxLength={1000} />}</Field>
        <Checkbox label="Ask them to acknowledge it" description="Leave on, unless you are recording an asset handed over long ago." checked={ack} onChange={(e) => setAck(e.target.checked)} />
      </form>
    </Dialog>
  );
}

function ReturnDialog({ id, since, who, onClose, onDone }: { id: string; since: string; who: string; onClose: () => void; onDone: Done }) {
  const [returnedOn, setReturnedOn] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={`Record the return from ${who}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="return-form" loading={pending}>Record return</Button></>}>
      <form id="return-form" className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => { const r = await returnAssetAction(id, { returnedOn, condition: f.get('condition'), nextStatus: f.get('nextStatus'), notes: String(f.get('notes') ?? '') }); if (r.ok) onDone(r); else setError(r.message); });
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Returned on" required>{(p) => <DatePicker {...p} value={returnedOn} onChange={setReturnedOn} min={since} max={today()} />}</Field>
          <Field label="Condition on return">{(p) => <Select {...p} name="condition" defaultValue="good">{ASSET_CONDITIONS.map((c) => <option key={c} value={c}>{ASSET_CONDITION_LABEL[c]}</option>)}</Select>}</Field>
          <Field label="Then">{(p) => <Select {...p} name="nextStatus" defaultValue="available"><option value="available">Back in stock</option><option value="under_maintenance">Send for maintenance</option><option value="damaged">Mark as damaged</option></Select>}</Field>
        </div>
        <Field label="Notes">{(p) => <Textarea {...p} name="notes" rows={2} maxLength={1000} />}</Field>
      </form>
    </Dialog>
  );
}

function StatusDialog({ a, onClose, onDone }: { a: AssetDetail; onClose: () => void; onDone: Done }) {
  const moves = a.can.moves.filter((m) => (m === 'lost' || m === 'damaged' ? a.can.writeOff : true));
  const [to, setTo] = useState(moves[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title="Change status" description="Lost and damaged need the asset Approve permission; retiring needs Delete. An assigned asset that is lost or damaged ends its assignment."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="status-form" loading={pending} disabled={!to}>Save</Button></>}>
      <form id="status-form" className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => { const r = await setStatusAction(a.id, { status: to, note: String(f.get('note') ?? ''), vendor: String(f.get('vendor') ?? ''), cost: String(f.get('cost') ?? '') }); if (r.ok) onDone(r); else { setError(r.message); setFe(r.fieldErrors ?? {}); } });
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="New status">{(p) => <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>{moves.map((m) => <option key={m} value={m}>{status(m)}</option>)}</Select>}</Field>
        {to === 'under_maintenance' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Repairer" error={fe.vendor}>{(p) => <Input {...p} name="vendor" maxLength={160} />}</Field>
            <Field label="Cost" error={fe.cost}>{(p) => <Input {...p} name="cost" inputMode="decimal" />}</Field>
          </div>
        )}
        <Field label="Reason" required error={fe.note}>{(p) => <Textarea {...p} name="note" rows={2} required minLength={3} maxLength={1000} />}</Field>
      </form>
    </Dialog>
  );
}

function UploadAssetFile({ id, onDone }: { id: string; onDone: Done }) {
  const [pending, start] = useTransition();
  return (
    <form className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const f = new FormData(form);
      start(async () => { const r = await uploadAssetFileAction(id, f); if (r.ok) form.reset(); onDone(r); });
    }}>
      <Field label="Title">{(p) => <Input {...p} name="title" required maxLength={200} placeholder="Purchase invoice" />}</Field>
      <Field label="File" hint="PDF, image or Word, up to 10 MB">{(p) => <Input {...p} name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" />}</Field>
      <Button type="submit" loading={pending}><FileUp className="size-4" aria-hidden /> Attach</Button>
    </form>
  );
}

function RemoveAssetFile({ id, fileId, title, onDone }: { id: string; fileId: string; title: string; onDone: Done }) {
  const [pending, start] = useTransition();
  return <Button data-delete-area="assets" data-delete={`file ${title}`} size="sm" variant="ghost" aria-label={`Remove ${title}`} loading={pending} onClick={() => start(async () => onDone(await removeAssetFileAction(id, fileId)))}><Trash2 className="size-4" aria-hidden /></Button>;
}
