'use client';
import { BGV_CHECK_FIELDS, BGV_CHECK_LABEL, BGV_CHECK_TYPES, BGV_STATUS_LABEL, BGV_STATUSES, type BgvCheckType } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DatePicker, Dialog, EmptyState, Field, Input, Select, Switch, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Copy, Download, FileUp, Link2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  addCheckAction, cancelCaseAction, decideAction, removeFileAction, revokeLinkAction, sendToAgencyAction, shareFileAction, updateCaseAction, updateCheckAction, uploadFileAction,
} from '../actions';
import { dateTime, day, EVENT_LABEL, size, STATUS_TONE } from '../labels';
import type { Agency, CaseDetail, Verifier } from '../types';

type Flash = { tone: 'success' | 'danger'; text: string } | null;
const statusLabel = (s: string | null) => (s ? BGV_STATUS_LABEL[s as keyof typeof BGV_STATUS_LABEL] ?? s : '');

export function CaseView({ c, agencies, verifiers }: { c: CaseDetail; agencies: Agency[]; verifiers: Verifier[] }) {
  const [flash, setFlash] = useState<Flash>(null);
  const [deciding, setDeciding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const say = (r: { ok: boolean; message?: string }) => setFlash(r.ok ? (r.message ? { tone: 'success', text: r.message } : null) : { tone: 'danger', text: r.message ?? 'Something went wrong' });
  const checkLabel = (id: string | null) => c.checks.find((x) => x.id === id)?.label;
  const linkedDocs = c.checks.flatMap((x) => (x.documents ?? []).map((d) => ({ ...d, checkId: x.id, check: x.label })));

  return (
    <div className="grid gap-6">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      {c.status === 'cancelled' && <Alert tone="info" title="This case was cancelled">{c.cancelledReason}</Alert>}
      {c.decision && <Alert tone={c.status === 'verified' ? 'success' : c.status === 'failed' ? 'danger' : 'info'} title={`${statusLabel(c.status)} by ${c.decision.by ?? 'HR'} on ${dateTime(c.decision.at)}`}>{c.decision.remarks}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader title="Checks" description="Record what was verified, the internal remarks and what the source or agency said."
              action={c.can.edit ? <AddCheck caseId={c.id} existing={c.checks.map((x) => x.type)} onDone={say} /> : undefined} />
            <CardBody className="grid gap-4">
              {c.checks.map((x) => <CheckEditor key={x.id} caseId={c.id} check={x} editable={c.can.edit} onDone={say} />)}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Case files" description="Supporting documents and agency reports. Only files you share are visible to the agency." />
            {c.can.edit && <CardBody><UploadFile caseId={c.id} checks={c.checks} onDone={say} /></CardBody>}
            {/* Issue #86: documents attached to the checks from the employee's profile are files of the case too. They
                were left out here, so the card said "No files yet" while the case had documents. */}
            {linkedDocs.length > 0 && (
              <CardBody className="grid gap-1 border-b border-border text-[0.8125rem]" data-testid="case-linked-documents">
                <div className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">From the employee&apos;s documents</div>
                {linkedDocs.map((d) => (
                  <div key={`${d.checkId}-${d.id}`} className="flex items-center justify-between gap-2">
                    <a className="truncate font-medium text-accent hover:underline" href={`/files/${d.id}`}>{d.title}</a>
                    <span className="shrink-0 text-xs text-fg-muted">{d.check}{d.archived ? ' · archived' : ''}</span>
                  </div>
                ))}
              </CardBody>
            )}
            {c.files.length ? (
              <Table aria-label="Case files">
                <THead><tr><TH>File</TH><TH>Check</TH><TH>Added</TH><TH>Shared with agency</TH><TH /></tr></THead>
                <TBody>
                  {c.files.map((f) => (
                    <TR key={f.id}>
                      <TD><a className="font-medium text-accent hover:underline" href={`/bgv-files/${f.id}`}>{f.title}</a><div className="text-xs text-fg-muted">{f.fileName} · {size(f.sizeBytes)}{f.kind === 'agency_report' ? ' · agency report' : ''}</div></TD>
                      <TD className="text-fg-muted">{checkLabel(f.checkId) ?? 'Whole case'}</TD>
                      <TD className="text-fg-muted">{f.uploadedBy}<div className="text-xs">{dateTime(f.createdAt)}</div></TD>
                      <TD>{f.kind === 'agency_report' ? <span className="text-fg-muted">From the agency</span> : <FileShare caseId={c.id} id={f.id} shared={f.sharedWithAgency} disabled={!c.can.edit} onDone={say} />}</TD>
                      <TD className="text-right">
                        <a className="mr-1 inline-flex" href={`/bgv-files/${f.id}`} aria-label={`Download ${f.title}`}><Download className="size-4 text-fg-muted" /></a>
                        {c.can.delete && <RemoveFile caseId={c.id} id={f.id} title={f.title} onDone={say} />}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : linkedDocs.length ? null : <CardBody><EmptyState title="No files yet" description="Upload ID proofs, certificates, relieving letters or reports, or attach the employee's documents to a check." /></CardBody>}
          </Card>

          <Card>
            <CardHeader title="Case history" description="Every change to the case, its checks and files, with who made it." />
            <CardBody>
              <ol className="grid gap-3">
                {[...c.history].reverse().map((h) => (
                  <li key={h.id} className="grid gap-0.5 border-l-2 border-border pl-3 text-[0.8125rem]">
                    <span><span className="font-medium">{EVENT_LABEL[h.action] ?? h.action}</span>{h.checkId ? ` · ${checkLabel(h.checkId) ?? ''}` : ''}{h.from || h.to ? ` · ${statusLabel(h.from)}${h.from && h.to ? ' → ' : ''}${statusLabel(h.to)}` : ''}</span>
                    {h.note && <span className="text-fg-muted">{h.note}</span>}
                    <span className="text-xs text-fg-subtle">{h.by ?? 'SampCrew'} · {dateTime(h.at)}</span>
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader title="Case details" />
            <CardBody className="grid gap-3 text-[0.8125rem]">
              <Fact label="Done by">{c.method === 'external' ? c.agency?.name ?? 'Agency' : 'HR (internal)'}</Fact>
              <Fact label="Started">{dateTime(c.createdAt)}{c.createdBy ? ` by ${c.createdBy}` : ''}</Fact>
              {c.completedOn && <Fact label="Completed on">{day(c.completedOn)}</Fact>}
              {c.employee.dateOfJoining && <Fact label="Date of joining">{day(c.employee.dateOfJoining)}</Fact>}
              <CaseDetails c={c} verifiers={verifiers} onDone={say} />
            </CardBody>
          </Card>

          {(c.can.approve || c.can.delete) && (
            <Card>
              <CardHeader title="Result" description="Verified needs every check verified. The result is kept with the remarks and who set it." />
              <CardBody className="flex flex-wrap gap-2">
                {c.can.approve && <Button onClick={() => setDeciding(true)}>Record the result</Button>}
                {c.can.delete && <Button variant="secondary" onClick={() => setCancelling(true)}>Cancel case</Button>}
              </CardBody>
            </Card>
          )}

          <AgencyCard c={c} agencies={agencies} onDone={say} />
        </div>
      </div>
      {deciding && <DecisionDialog c={c} onClose={() => setDeciding(false)} onDone={say} />}
      {cancelling && <CancelDialog id={c.id} onClose={() => setCancelling(false)} onDone={say} />}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-0.5"><span className="text-xs text-fg-subtle">{label}</span><span>{children}</span></div>;
}

function CaseDetails({ c, verifiers, onDone }: { c: CaseDetail; verifiers: Verifier[]; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [due, setDue] = useState(c.dueDate ?? '');
  const [pending, start] = useTransition();
  if (!c.can.edit) {
    return (
      <>
        <Fact label="Due date">{day(c.dueDate) || 'No date'}</Fact>
        <Fact label="Verifier">{c.assignee?.name ?? 'Nobody'}</Fact>
        {c.agencyReference && <Fact label="Agency reference">{c.agencyReference}</Fact>}
        {c.notes && <Fact label="Notes">{c.notes}</Fact>}
      </>
    );
  }
  return (
    <form className="grid gap-3" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      start(async () => onDone(await updateCaseAction(c.id, {
        dueDate: due || null, assigneeMembershipId: String(f.get('assignee') ?? '') || null, notes: String(f.get('notes') ?? '') || null,
        ...(c.method === 'external' ? { agencyReference: String(f.get('agencyReference') ?? '') || null } : {}),
      })));
    }}>
      <Field label="Due date">{(p) => <DatePicker {...p} value={due} onChange={setDue} />}</Field>
      <Field label="Verifier">{(p) => <Select {...p} name="assignee" defaultValue={c.assignee?.membershipId ?? ''}><option value="">Nobody</option>{verifiers.map((v) => <option key={v.membershipId} value={v.membershipId}>{v.name}</option>)}</Select>}</Field>
      {c.method === 'external' && <Field label="Agency reference">{(p) => <Input {...p} name="agencyReference" defaultValue={c.agencyReference ?? ''} maxLength={120} />}</Field>}
      <Field label="Notes">{(p) => <Textarea {...p} name="notes" rows={3} defaultValue={c.notes ?? ''} maxLength={2000} />}</Field>
      <Button type="submit" variant="secondary" loading={pending}>Save details</Button>
    </form>
  );
}

function CheckEditor({ caseId, check, editable, onDone }: { caseId: string; check: CaseDetail['checks'][number]; editable: boolean; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const fields = BGV_CHECK_FIELDS[check.type as BgvCheckType] ?? [];
  const [pending, start] = useTransition();
  const [fe, setFe] = useState<Record<string, string>>({});
  const [vals, setVals] = useState<Record<string, string>>(check.details);
  return (
    <form aria-label={`${check.label} check`} className="grid gap-3 rounded-lg border border-border p-4" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const details = Object.fromEntries(fields.map((x) => [x.key, String(vals[x.key] ?? '').trim()]).filter(([, v]) => v));
      start(async () => {
        const r = await updateCheckAction(caseId, check.id, { status: f.get('status'), details, remarks: String(f.get('remarks') ?? '') || null, agencyFeedback: String(f.get('agencyFeedback') ?? '') || null });
        setFe(r.ok ? {} : r.fieldErrors ?? {});
        onDone(r);
      });
    }}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">{check.label}</h3>
        <Badge tone={STATUS_TONE[check.status]}>{statusLabel(check.status)}</Badge>
        {check.verifiedBy && <span className="text-xs text-fg-muted">by {check.verifiedBy}{check.verifiedAt ? ` on ${dateTime(check.verifiedAt)}` : ''}</span>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((x) => (
          <Field key={x.key} label={x.label} help={false} className={x.type === 'textarea' ? 'sm:col-span-2' : ''} error={fe[`details.${x.key}`]}>
            {(p) => x.type === 'textarea'
              ? <Textarea {...p} rows={2} value={vals[x.key] ?? ''} onChange={(e) => setVals({ ...vals, [x.key]: e.target.value })} disabled={!editable} maxLength={500} />
              : <Input {...p} type={x.type === 'date' ? 'date' : x.type === 'email' ? 'email' : 'text'} value={vals[x.key] ?? ''} onChange={(e) => setVals({ ...vals, [x.key]: e.target.value })} disabled={!editable} maxLength={500} />}
          </Field>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Check status" help={false}>{(p) => <Select {...p} name="status" defaultValue={check.status} disabled={!editable}>{BGV_STATUSES.map((s) => <option key={s} value={s}>{BGV_STATUS_LABEL[s]}</option>)}</Select>}</Field>
        <Field label="Internal remarks" hint="Never shown to the agency or the employee" error={fe.remarks}>{(p) => <Textarea {...p} name="remarks" rows={2} defaultValue={check.remarks ?? ''} disabled={!editable} maxLength={4000} />}</Field>
      </div>
      <Field label="Agency or source feedback" error={fe.agencyFeedback}>{(p) => <Textarea {...p} name="agencyFeedback" rows={2} defaultValue={check.agencyFeedback ?? ''} disabled={!editable} maxLength={4000} />}</Field>
      {editable && <div><Button type="submit" size="sm" loading={pending}>Save {check.label.toLowerCase()} check</Button></div>}
    </form>
  );
}

function AddCheck({ caseId, existing, onDone }: { caseId: string; existing: string[]; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [pending, start] = useTransition();
  const [type, setType] = useState<string>(BGV_CHECK_TYPES.find((t) => !existing.includes(t)) ?? 'document');
  return (
    <div className="flex items-center gap-2">
      <Select aria-label="Kind of check to add" value={type} onChange={(e) => setType(e.target.value)} className="h-8 w-44">{BGV_CHECK_TYPES.map((t) => <option key={t} value={t}>{BGV_CHECK_LABEL[t]}</option>)}</Select>
      <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => onDone(await addCheckAction(caseId, { type })))}>Add check</Button>
    </div>
  );
}

function UploadFile({ caseId, checks, onDone }: { caseId: string; checks: CaseDetail['checks']; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [pending, start] = useTransition();
  const [shared, setShared] = useState(false);
  return (
    <form className="grid items-end gap-3 sm:grid-cols-[1fr_12rem_1fr_auto]" onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const f = new FormData(form);
      f.set('shared', String(shared));
      start(async () => { const r = await uploadFileAction(caseId, f); if (r.ok) { form.reset(); setShared(false); } onDone(r); });
    }}>
      <Field label="Title">{(p) => <Input {...p} name="title" required maxLength={200} placeholder="Degree certificate" />}</Field>
      <Field label="For check">{(p) => <Select {...p} name="checkId"><option value="">Whole case</option>{checks.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>}</Field>
      <Field label="File" hint="PDF, image, Word or text, up to 10 MB">{(p) => <Input {...p} name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.txt" />}</Field>
      <Button type="submit" loading={pending}><FileUp className="size-4" aria-hidden /> Upload</Button>
      <div className="sm:col-span-4"><Checkbox label="Share with the agency" checked={shared} onChange={(e) => setShared(e.target.checked)} /></div>
    </form>
  );
}

function FileShare({ caseId, id, shared, disabled, onDone }: { caseId: string; id: string; shared: boolean; disabled: boolean; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [pending, start] = useTransition();
  return <Switch label="Shared with the agency" checked={shared} disabled={disabled || pending} onChange={(next) => start(async () => onDone(await shareFileAction(caseId, id, next)))} />;
}

function RemoveFile({ caseId, id, title, onDone }: { caseId: string; id: string; title: string; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [pending, start] = useTransition();
  return <Button data-delete-area="people" data-delete={`file ${title}`} size="sm" variant="ghost" aria-label={`Remove ${title}`} loading={pending} onClick={() => start(async () => onDone(await removeFileAction(caseId, id)))}><Trash2 className="size-4" aria-hidden /></Button>;
}

function AgencyCard({ c, agencies, onDone }: { c: CaseDetail; agencies: Agency[]; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [pending, start] = useTransition();
  const [url, setUrl] = useState<string | null>(null);
  const shared = c.files.filter((f) => f.sharedWithAgency).length;
  const canSend = c.can.edit && agencies.length > 0;
  if (!canSend && !c.agencyLinks.length) return null;
  return (
    <Card>
      <CardHeader title="Agency" description="The agency gets a private link to the shared files and a form for its findings. No SampCrew account is needed." />
      <CardBody className="grid gap-4 text-[0.8125rem]">
        {c.sentToAgencyAt && <Fact label="Sent">{dateTime(c.sentToAgencyAt)}{c.agency ? ` to ${c.agency.name} (${c.agency.email})` : ''}</Fact>}
        {c.agencyLinks.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
            <Link2 className="size-4 text-fg-muted" aria-hidden />
            <span>{l.active ? `Active until ${day(l.expiresAt)}` : l.revokedAt ? 'Switched off' : 'Expired'}{l.submittedAt ? ` · findings sent ${dateTime(l.submittedAt)}` : l.lastUsedAt ? ` · opened ${dateTime(l.lastUsedAt)}` : ' · not opened yet'}</span>
            {l.active && c.can.edit && <Button size="sm" variant="ghost" className="ml-auto" loading={pending} onClick={() => start(async () => onDone(await revokeLinkAction(c.id, l.id)))}>Switch off</Button>}
          </div>
        ))}
        {url && (
          <Alert tone="success" title="Private link">
            <span className="break-all font-mono text-xs">{url}</span>
            <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(url)}><Copy className="size-3.5" aria-hidden /> Copy</Button>
          </Alert>
        )}
        {canSend && (
          <form className="grid gap-3" onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            start(async () => {
              const r = await sendToAgencyAction(c.id, { agencyId: f.get('agencyId'), message: String(f.get('message') ?? ''), expiresInDays: Number(f.get('expiresInDays') ?? 30) });
              if (r.ok && r.data) setUrl(r.data.url);
              onDone(r);
            });
          }}>
            <Field label="Agency">{(p) => <Select {...p} name="agencyId" defaultValue={c.agency?.id ?? agencies[0]?.id} required>{agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
            <Field label="Link works for (days)">{(p) => <Input {...p} name="expiresInDays" type="number" min={1} max={90} defaultValue={30} />}</Field>
            <Field label="Message to the agency">{(p) => <Textarea {...p} name="message" rows={2} maxLength={2000} />}</Field>
            <p className="text-xs text-fg-muted">{shared ? `${shared} file${shared === 1 ? ' is' : 's are'} shared.` : 'No files are shared yet: share the ones the agency needs first.'} Sending again switches off the previous link.</p>
            <Button type="submit" loading={pending}>{c.agencyLinks.some((l) => l.active) ? 'Send a new link' : 'Send to the agency'}</Button>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function DecisionDialog({ c, onClose, onDone }: { c: CaseDetail; onClose: () => void; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const router = useRouter();
  const allVerified = c.checks.length > 0 && c.checks.every((x) => x.status === 'verified');
  const [status, setStatus] = useState(allVerified ? 'verified' : c.checks.some((x) => x.status === 'failed') ? 'failed' : 'on_hold');
  const [completedOn, setCompletedOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title="Record the result" description="The employee’s verification result, with your remarks. Everyone with access sees who set it and when."
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button type="submit" form="bgv-decision" loading={pending}>Save result</Button></>}>
      <form id="bgv-decision" className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          const r = await decideAction(c.id, { status, remarks: String(f.get('remarks') ?? ''), ...(completedOn ? { completedOn } : {}) });
          if (r.ok) { onDone(r); onClose(); router.refresh(); } else setError(r.message);
        });
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Result">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="verified" disabled={!allVerified}>Verified{allVerified ? '' : ' (every check must be verified)'}</option>
              <option value="failed">Failed</option>
              <option value="on_hold">On hold</option>
              <option value="in_progress">Back in progress</option>
            </Select>
          )}
        </Field>
        {(status === 'verified' || status === 'failed') && <Field label="Completion date" hint="Today when left empty">{(p) => <DatePicker {...p} value={completedOn} onChange={setCompletedOn} />}</Field>}
        <Field label="Remarks" required>{(p) => <Textarea {...p} name="remarks" rows={3} required minLength={3} maxLength={4000} />}</Field>
      </form>
    </Dialog>
  );
}

function CancelDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onClose={onClose} title="Cancel this case" description="The case and its history are kept. Any agency link stops working."
      footer={<><Button variant="secondary" onClick={onClose}>Keep the case</Button><Button variant="danger" type="submit" form="bgv-cancel" loading={pending}>Cancel case</Button></>}>
      <form id="bgv-cancel" onSubmit={(e) => {
        e.preventDefault();
        const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
        start(async () => { const r = await cancelCaseAction(id, reason); if (r.ok) { onDone(r); onClose(); } else setError(r.message); });
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Reason" required>{(p) => <Textarea {...p} name="reason" rows={3} required minLength={3} maxLength={1000} />}</Field>
      </form>
    </Dialog>
  );
}
