'use client';
import {
  DOCUMENT_ACTIVITY_LABEL, REQUEST_FILE_ACCEPT, REQUEST_FILE_FORMAT_KEYS, REQUEST_FILE_LABEL, type RequestFileFormat,
} from '@crew/contracts';
import { Alert, Badge, Button, Checkbox, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, Textarea, TH, THead, TR, type Tone } from '@crew/ui';
import { Download, Eye, FileText, FileUp, Lock, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, useTransition } from 'react';
import { useRefreshOn } from '@/components/live';
import { decideDocumentAction, requestDocumentAction } from './actions';
import { fmtDate, fmtSize, fmtWhen } from './format';
import type { Catalogue, DocRow, HistoryRow, RequestRow, Targets } from './types';


const DOC_TONE: Record<string, Tone> = { verified: 'success', pending: 'warning', rejected: 'danger', correction_required: 'ember', unverified: 'neutral', expired: 'danger', superseded: 'neutral' };
const REQ_TONE: Record<string, Tone> = {
  new_request: 'info', pending_submission: 'info', submitted: 'warning', resubmitted: 'warning', under_verification: 'accent', correction_required: 'ember',
  rejected: 'danger', completed: 'success', cancelled: 'neutral', overdue: 'danger',
};

export function DocStatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={DOC_TONE[status] ?? 'neutral'} dot>{label}</Badge>;
}

export function RequestStatusBadge({ r }: { r: Pick<RequestRow, 'displayStatus' | 'statusLabel'> }) {
  return <Badge tone={REQ_TONE[r.displayStatus] ?? 'neutral'} dot>{r.statusLabel}</Badge>;
}

/** Re-reads the page when a document or request changes anywhere (another person approved, uploaded, asked). */
export function LiveDocuments() {
  useRefreshOn(['documents.changed', 'approvals.changed']);
  return null;
}

export function FileActions({ d }: { d: Pick<DocRow, 'id' | 'can'> }) {
  return (
    <span className="inline-flex items-center gap-3 whitespace-nowrap">
      {d.can.preview && <a className="inline-flex items-center gap-1 text-[0.8125rem] font-medium text-accent hover:underline" href={`/document-preview/${d.id}`} target="_blank" rel="noopener"><Eye className="size-3.5" aria-hidden /> Preview</a>}
      {d.can.download && <a className="inline-flex items-center gap-1 text-[0.8125rem] font-medium text-accent hover:underline" href={`/files/${d.id}`}><Download className="size-3.5" aria-hidden /> Download</a>}
      {!d.can.preview && !d.can.download && <span className="inline-flex items-center gap-1 text-xs text-fg-subtle"><Lock className="size-3.5" aria-hidden /> Restricted</span>}
    </span>
  );
}

/**
 * The documents table used by profiles and the repository. `filterable` adds search and filters in the page (for a
 * profile, which holds at most a few hundred rows); the repository filters on the server instead.
 */
export function DocumentTable({ rows, showOwner, filterable, empty, rowAction }: { rows: DocRow[]; showOwner?: boolean; filterable?: boolean; empty?: string; rowAction?: (d: DocRow) => React.ReactNode }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [by, setBy] = useState('');
  const [from, setFrom] = useState('');
  const shown = useMemo(() => rows.filter((d) => {
    if (q && !`${d.title} ${d.typeName ?? ''} ${d.reference} ${d.fileName} ${d.employee?.name ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (type && d.group !== type) return false;
    if (status && d.status !== status) return false;
    if (by && (d.requestedBy?.level ?? 'none') !== by) return false;
    if (from && d.createdAt.slice(0, 10) < from) return false;
    return true;
  }), [rows, q, type, status, by, from]);
  const categories = [...new Map(rows.map((d) => [d.group, d.categoryName])).entries()];
  return (
    <>
      {filterable && rows.length > 0 && (
        <div className="grid gap-2 px-5 pb-4 sm:grid-cols-2 lg:grid-cols-5" role="search" aria-label="Filter documents">
          <div className="relative lg:col-span-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-subtle" aria-hidden />
            <Input aria-label="Search documents" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <Select aria-label="Document type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All categories</option>
            {categories.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </Select>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="verified">Approved</option><option value="pending">Pending verification</option><option value="rejected">Rejected</option>
            <option value="correction_required">Correction required</option><option value="unverified">Not verified</option><option value="expired">Expired</option>
          </Select>
          <Select aria-label="Requested by" value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="">Requested by anyone</option><option value="super_workspace">Super Workspace</option><option value="hr_workspace">HR Workspace</option><option value="none">Added directly</option>
          </Select>
          <Input aria-label="Submitted from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
      )}
      {shown.length ? (
        <Table aria-label="Documents">
          <THead>
            <tr>
              <TH>Document</TH>
              {showOwner && <TH>Person or workspace</TH>}
              <TH>Type</TH><TH>Submitted</TH><TH>Requested by</TH><TH>Status</TH><TH>Verified</TH><TH>Expiry</TH><TH>Version</TH><TH><span className="sr-only">Actions</span></TH>
            </tr>
          </THead>
          <TBody>
            {shown.map((d) => (
              <TR key={d.id}>
                <TD>
                  <span className="flex items-start gap-2">
                    <FileText className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                    <span className="min-w-0">
                      <Link className="block font-medium hover:underline" href={`/documents/${d.id}`}>{d.title}</Link>
                      <span className="block truncate text-xs text-fg-subtle">{d.reference} · {d.fileName}</span>
                      {d.sensitive && <Badge tone="warning" className="mt-1">Sensitive</Badge>}
                    </span>
                  </span>
                </TD>
                {showOwner && (
                  <TD>
                    {d.employee ? <Link className="text-accent hover:underline" href={`/employees/${d.employee.id}?tab=documents`}>{d.employee.name}</Link> : d.hrWorkspace ? <Link className="text-accent hover:underline" href={`/hr-workspaces/${d.hrWorkspace.id}?tab=documents`}>{d.hrWorkspace.name}</Link> : '—'}
                    <span className="block text-xs text-fg-subtle">{d.ownerType === 'hr_workspace' ? 'HR Workspace' : d.hrWorkspace?.name ?? 'Central group'}{d.employee?.code ? ` · ${d.employee.code}` : ''}</span>
                  </TD>
                )}
                <TD className="text-fg-muted">{d.typeName ?? d.title}<span className="block text-xs text-fg-subtle">{d.categoryName}</span></TD>
                <TD className="text-fg-muted">{fmtDate(d.createdAt)}{d.submittedBy && <span className="block text-xs">{d.submittedBy}</span>}</TD>
                <TD className="text-fg-muted">{d.requestedBy ? <>{d.requestedBy.label}<span className="block text-xs">{d.requestedBy.name}</span></> : <span className="text-xs">Added directly</span>}</TD>
                <TD>
                  <DocStatusBadge status={d.status} label={d.statusLabel} />
                  {d.verificationRemarks && <ReviewerNote status={d.verificationStatus} text={d.verificationRemarks} />}
                </TD>
                <TD className="text-fg-muted">{d.verifiedBy ? <>{d.verifiedBy.name}<span className="block text-xs">{[d.verifiedBy.designation, fmtDate(d.verifiedAt)].filter(Boolean).join(' · ')}</span></> : '—'}</TD>
                <TD className={d.expired ? 'font-medium text-danger' : 'text-fg-muted'}>{d.expiresOn ? fmtDate(d.expiresOn) : '—'}</TD>
                <TD className="tabular-nums text-fg-muted">v{d.version}</TD>
                <TD className="text-right"><span className="inline-flex flex-col items-end gap-1"><FileActions d={d} /><Link className="text-xs text-fg-subtle hover:text-fg hover:underline" href={`/documents/${d.id}`}>History</Link>{rowAction?.(d)}</span></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <EmptyState icon={<FileText className="size-5" />} title={rows.length ? 'No documents match these filters' : 'No documents yet'} description={rows.length ? undefined : empty} />
      )}
    </>
  );
}


export function RequestTable({ rows, showTarget, empty }: { rows: RequestRow[]; showTarget?: boolean; empty?: string }) {
  if (!rows.length) return <EmptyState icon={<FileText className="size-5" />} title="No document requests" description={empty} />;
  return (
    <Table aria-label="Document requests">
      <THead><tr><TH>Request</TH>{showTarget && <TH>Asked of</TH>}<TH>Requested by</TH><TH>Deadline</TH><TH>Status</TH><TH>Latest file</TH></tr></THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.id}>
            <TD><Link className="font-medium hover:underline" href={`/documents/requests/${r.id}`}>{r.title}</Link><span className="block text-xs text-fg-subtle">{r.reference} · {r.categoryName}</span></TD>
            {showTarget && <TD>{r.employee?.name ?? r.hrWorkspace?.name ?? '—'}<span className="block text-xs text-fg-subtle">{r.targetType === 'hr_workspace' ? 'HR Workspace' : r.hrWorkspace?.name ?? 'Central group'}</span></TD>}
            <TD className="text-fg-muted">{r.requestedBy.label}<span className="block text-xs">{r.requestedBy.name}{r.requestedBy.designation ? ` · ${r.requestedBy.designation}` : ''}</span></TD>
            <TD className={r.overdue ? 'font-medium text-danger' : 'text-fg-muted'}>{r.dueOn ? fmtDate(r.dueOn) : 'No deadline'}</TD>
            <TD><RequestStatusBadge r={r} />{r.canReview && <Badge tone="accent" className="ml-1">Yours to verify</Badge>}</TD>
            <TD className="text-fg-muted">{r.document ? <>v{r.document.version} · {fmtDate(r.submittedAt)}</> : 'Not submitted'}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function HistoryList({ rows }: { rows: HistoryRow[] }) {
  if (!rows.length) return <p className="px-5 pb-5 text-sm text-fg-muted">Nothing recorded yet.</p>;
  return (
    <ol className="grid gap-4 px-5 pb-5" aria-label="Document history">
      {[...rows].reverse().map((h) => (
        <li key={h.id} className="relative border-l-2 border-border pl-4">
          <span className="absolute -left-[5px] top-1.5 size-2 rounded-full bg-accent" aria-hidden />
          <div className="text-sm font-medium">{DOCUMENT_ACTIVITY_LABEL[h.action] ?? h.action}{typeof h.metadata.version === 'number' ? ` (v${h.metadata.version})` : ''}</div>
          <div className="text-xs text-fg-subtle">{h.by ?? 'Someone'}{h.byDesignation ? `, ${h.byDesignation}` : ''} · {h.level} · {fmtWhen(h.at)}</div>
          {h.comment && <div className="mt-1 whitespace-pre-wrap text-xs text-fg-muted">{h.comment}</div>}
        </li>
      ))}
    </ol>
  );
}

// -------------------------------------------------------------------------------------------------------------
// Request a document
// -------------------------------------------------------------------------------------------------------------

export interface RequestPreset {
  target: 'employee' | 'hr_workspace';
  employeeIds?: string[];
  employeeName?: string;
  hrWorkspaceId?: string;
  hrWorkspaceName?: string;
  admins?: { membershipId: string; name: string | null }[];
  replacesDocumentId?: string;
  typeKey?: string;
}

/** The "Request Document" form: from a profile, an HR Workspace, a document (replacement) or the Documents page. */
export function RequestDocumentDialog({ open, onClose, catalogue, preset, targets }: { open: boolean; onClose: () => void; catalogue: Catalogue; preset: RequestPreset | null; targets?: Targets | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<'employee' | 'hr_workspace'>(preset?.target ?? 'employee');
  const [people, setPeople] = useState<string[]>(preset?.employeeIds ?? []);
  const [ws, setWs] = useState(preset?.hrWorkspaceId ?? '');
  const [typeKey, setTypeKey] = useState(preset?.typeKey ?? '');
  const [formats, setFormats] = useState<RequestFileFormat[]>(['pdf', 'image']);
  const [find, setFind] = useState('');
  const fixed = !!preset && (preset.employeeIds?.length || preset.hrWorkspaceId);
  const types = catalogue.types.filter((x) => x.owners.includes(target));
  const groups = catalogue.groups.filter((g) => types.some((x) => x.category === g.key));
  const admins = preset?.admins ?? targets?.hrWorkspaces.find((w) => w.id === ws)?.admins ?? [];
  const candidates = (targets?.employees ?? []).filter((e) => !find || `${e.name} ${e.code ?? ''}`.toLowerCase().includes(find.toLowerCase())).slice(0, 50);

  const submit = (f: FormData) => {
    const body = {
      target, typeKey, title: (f.get('title') as string) || null, instructions: (f.get('instructions') as string) || null, reason: f.get('reason') as string,
      dueOn: (f.get('dueOn') as string) || null, priority: f.get('priority') as string, formats, maxMb: Number(f.get('maxMb') ?? 10), expiryRequired: f.get('expiryRequired') === 'on',
      ...(target === 'employee' ? { employeeIds: people } : { hrWorkspaceId: ws, assigneeMembershipId: (f.get('assignee') as string) || null }),
      ...(preset?.replacesDocumentId ? { replacesDocumentId: preset.replacesDocumentId } : {}),
    };
    start(async () => {
      const r = await requestDocumentAction(body);
      if (!r.ok) {
        setError(r.message);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      setError(null);
      onClose();
      const first = r.data?.[0];
      if (first && r.data?.length === 1) router.push(`/documents/requests/${first.id}`);
      else router.refresh();
    });
  };

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={preset?.replacesDocumentId ? 'Request a replacement' : 'Request document'}
      description={fixed ? `From ${preset?.employeeName ?? preset?.hrWorkspaceName}. They get a task and a notification; the upload comes back to you for verification.` : 'They get a task and a notification; the upload comes back to your level for verification.'}>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit(new FormData(e.currentTarget)); }}>
        {error && <Alert tone="danger">{error}</Alert>}
        {!fixed && (
          <Field label="Ask">{(p) => (
            <Select {...p} value={target} onChange={(e) => { setTarget(e.target.value as 'employee'); setTypeKey(''); }}>
              <option value="employee">Employees</option>
              {(targets?.hrWorkspaces.length ?? 0) > 0 && <option value="hr_workspace">An HR Workspace</option>}
            </Select>
          )}</Field>
        )}
        {!fixed && target === 'employee' && (
          <Field label="People" required error={fieldErrors.employeeIds} hint={`${people.length} chosen`}>{(p) => (
            <div className="grid gap-2">
              <Input {...p} placeholder="Search by name or code" value={find} onChange={(e) => setFind(e.target.value)} />
              <div className="max-h-40 overflow-y-auto rounded-lg border border-border p-2">
                {candidates.map((e) => (
                  <Checkbox key={e.id} label={`${e.name}${e.code ? ` (${e.code})` : ''}`} description={[e.departmentName, e.hrWorkspaceName ?? 'Central group', e.hasLogin ? null : 'no login yet'].filter(Boolean).join(' · ')}
                    disabled={!e.hasLogin} checked={people.includes(e.id)} onChange={(ev) => setPeople((cur) => (ev.target.checked ? [...cur, e.id] : cur.filter((x) => x !== e.id)))} />
                ))}
                {!candidates.length && <p className="text-xs text-fg-subtle">Nobody you may ask matches.</p>}
              </div>
            </div>
          )}</Field>
        )}
        {!fixed && target === 'hr_workspace' && (
          <Field label="HR Workspace" required error={fieldErrors.hrWorkspaceId}>{(p) => (
            <Select {...p} value={ws} onChange={(e) => setWs(e.target.value)} required>
              <option value="">Choose…</option>
              {targets?.hrWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          )}</Field>
        )}
        {target === 'hr_workspace' && admins.length > 0 && (
          <Field label="Assigned person" hint="The task goes to this HR Workspace Admin; any admin of the HR Workspace can submit it.">{(p) => (
            <Select {...p} name="assignee" defaultValue={admins[0]?.membershipId}>{admins.map((a) => <option key={a.membershipId} value={a.membershipId}>{a.name ?? 'HR Workspace Admin'}</option>)}</Select>
          )}</Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Document type" required error={fieldErrors.typeKey}>{(p) => (
            <Select {...p} value={typeKey} onChange={(e) => setTypeKey(e.target.value)} required disabled={!!preset?.replacesDocumentId && !!preset.typeKey}>
              <option value="">Choose…</option>
              {groups.map((g) => <optgroup key={g.key} label={g.name}>{types.filter((x) => x.category === g.key).map((x) => <option key={x.key} value={x.key}>{x.name}{x.sensitive ? ' (sensitive)' : ''}</option>)}</optgroup>)}
            </Select>
          )}</Field>
          <Field label="Document name" hint={typeKey === 'custom' ? 'Required for a custom document' : 'Leave empty to use the type name'} error={fieldErrors.title}>{(p) => <Input {...p} name="title" maxLength={200} required={typeKey === 'custom'} />}</Field>
        </div>
        <Field label="Reason" required error={fieldErrors.reason} hint="Shown to the person. Ask only for what the stated purpose needs.">{(p) => <Input {...p} name="reason" required minLength={3} maxLength={1000} defaultValue={preset?.replacesDocumentId ? 'The earlier document expired or needs renewing' : ''} />}</Field>
        <Field label="Instructions">{(p) => <Textarea {...p} name="instructions" rows={2} maxLength={2000} placeholder="For example: both sides in one PDF, clearly readable" />}</Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Submission deadline" error={fieldErrors.dueOn}>{(p) => <Input {...p} type="date" name="dueOn" min={new Date().toISOString().slice(0, 10)} />}</Field>
          <Field label="Priority">{(p) => <Select {...p} name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></Select>}</Field>
          <Field label="Largest file (MB)">{(p) => <Input {...p} type="number" name="maxMb" min={1} max={10} defaultValue={10} />}</Field>
        </div>
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-[0.8125rem] font-medium">Accepted files</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {REQUEST_FILE_FORMAT_KEYS.map((f) => <Checkbox key={f} label={REQUEST_FILE_LABEL[f]} checked={formats.includes(f)} onChange={(e) => setFormats((cur) => (e.target.checked ? [...cur, f] : cur.filter((x) => x !== f)))} />)}
          </div>
        </fieldset>
        <Checkbox name="expiryRequired" label="Ask for the expiry date" description="For passports, licences, certificates and other documents that expire." />
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Back</Button>
          <Button type="submit" loading={pending} disabled={!typeKey || !formats.length || (target === 'employee' ? !people.length : !ws)}>Send request</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A "Request document" button with its dialog, for server-rendered pages. */
export function RequestDocumentButton({ catalogue, preset, targets, label = 'Request document', variant = 'primary' }: { catalogue: Catalogue; preset: RequestPreset | null; targets?: Targets | null; label?: string; variant?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={variant} onClick={() => setOpen(true)}><FileUp className="size-3.5" aria-hidden /> {label}</Button>
      {open && <RequestDocumentDialog open={open} onClose={() => setOpen(false)} catalogue={catalogue} preset={preset} targets={targets} />}
    </>
  );
}

// -------------------------------------------------------------------------------------------------------------
// Upload (drag and drop, progress, failure)
// -------------------------------------------------------------------------------------------------------------

export function UploadBox({ r, onDone }: { r: RequestRow; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');
  const [expires, setExpires] = useState('');
  const accept = r.formats.length ? r.formats.map((f) => ({ pdf: '.pdf', image: '.jpg,.jpeg,.png', word: '.doc,.docx', excel: '.xls,.xlsx' })[f]).join(',') : REQUEST_FILE_ACCEPT;
  const pick = (f: File | null | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > r.maxMb * 1024 * 1024) return setError(`This file is ${fmtSize(f.size)}. Files for this request can be up to ${r.maxMb} MB.`);
    const ext = `.${f.name.split('.').pop()?.toLowerCase()}`;
    if (!accept.split(',').includes(ext)) return setError(`Upload ${r.formats.map((x) => REQUEST_FILE_LABEL[x]).join(', ')}.`);
    setFile(f);
  };
  const send = () => {
    if (!file) return;
    if (r.expiryRequired && !expires) return setError('Enter the date the document expires.');
    const fd = new FormData();
    fd.set('file', file);
    if (remarks.trim()) fd.set('remarks', remarks.trim());
    if (expires) fd.set('expiresOn', expires);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/document-upload/${r.id}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => { setProgress(null); setError('The upload failed: check your connection and try again. Nothing was saved.'); };
    xhr.onload = () => {
      setProgress(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        setFile(null);
        setRemarks('');
        onDone();
        return;
      }
      try {
        setError((JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? 'The upload failed. Try again.');
      } catch {
        setError('The upload failed. Try again.');
      }
    };
    setProgress(0);
    xhr.send(fd);
  };
  return (
    <div className="grid gap-3">
      {error && <Alert tone="danger" title="Not uploaded">{error}</Alert>}
      <label
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0]); }}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center focus-within:border-accent hover:border-accent ${drag ? 'border-accent bg-accent-subtle' : 'border-border-strong'}`}
      >
        <FileUp className="size-6 text-accent" aria-hidden />
        <span className="text-sm font-medium">{file ? file.name : 'Drop the file here, or choose one'}</span>
        <span className="text-xs text-fg-subtle">{r.formats.map((f) => REQUEST_FILE_LABEL[f]).join(', ')}, up to {r.maxMb} MB{file ? ` · ${fmtSize(file.size)}` : ''}</span>
        <input ref={input} type="file" className="sr-only" accept={accept} onChange={(e) => pick(e.target.files?.[0])} data-testid="request-file" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {r.expiryRequired && <Field label="Expiry date" required>{(p) => <Input {...p} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />}</Field>}
        <Field label="Note for the reviewer (optional)" className={r.expiryRequired ? '' : 'sm:col-span-2'}>{(p) => <Textarea {...p} rows={2} maxLength={2000} value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
      </div>
      {progress !== null && (
        <div className="grid gap-1" aria-live="polite">
          <div className="h-2 overflow-hidden rounded-full bg-bg-subtle"><div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} /></div>
          <span className="text-xs text-fg-subtle">Uploading… {progress}%</span>
        </div>
      )}
      <div><Button disabled={!file || progress !== null} loading={progress !== null} onClick={send}>Submit for verification</Button></div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------------------
// Verification decision
// -------------------------------------------------------------------------------------------------------------

type Ask = null | 'approve' | 'reject' | 'correction';

export function DecisionButtons({ r, expiresOn, onDone }: { r: RequestRow; expiresOn: string | null; onDone: (msg: string) => void }) {
  const [ask, setAsk] = useState<Ask>(null);
  const [comment, setComment] = useState('');
  const [expiry, setExpiry] = useState(expiresOn ?? '');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const needs = ask === 'reject' || ask === 'correction';
  const go = () => start(async () => {
    const res = await decideDocumentAction(r.id, ask!, comment.trim() || undefined, ask === 'approve' && expiry ? expiry : undefined);
    if (!res.ok) return setError(res.message);
    setAsk(null);
    setComment('');
    onDone(res.message ?? 'Saved.');
  });
  const title = { approve: 'Approve this document?', reject: 'Reject this document?', correction: 'Ask for a correction?' };
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setAsk('approve')}>Approve</Button>
        <Button variant="secondary" onClick={() => setAsk('correction')}>Request correction</Button>
        <Button variant="danger" onClick={() => setAsk('reject')}>Reject</Button>
      </div>
      <Dialog open={!!ask} onClose={() => setAsk(null)} title={ask ? title[ask] : ''}
        description={ask === 'approve' ? 'It becomes an approved document in the profile and the request is marked collected. Your comment is shown to the person who uploaded it.' : ask === 'reject' ? 'The person is told the reason and can upload a new file. The rejected file is kept in the history.' : 'The person is told what to fix and uploads a new version.'}
        footer={<><Button variant="secondary" onClick={() => setAsk(null)}>Back</Button><Button variant={ask === 'reject' ? 'danger' : 'primary'} loading={pending} disabled={needs && comment.trim().length < 3} onClick={go}>{ask === 'approve' ? 'Approve' : ask === 'reject' ? 'Reject' : 'Send back'}</Button></>}>
        <div className="grid gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          {ask === 'approve' && <Field label="Expiry date (if the document expires)">{(p) => <Input {...p} type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />}</Field>}
          <Field label={ask === 'reject' ? 'Reason for rejecting' : ask === 'correction' ? 'What must be corrected' : 'Comment for the person who uploaded it (optional)'} required={needs}
            hint={needs ? 'Required. It is shown to the person, highlighted, with the document and in their notification.' : 'For example: Clear scan, thank you. It is shown with the document and in their notification.'}>{(p) => <Textarea {...p} data-testid="decision-comment" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </>
  );
}

/** The secure preview: PDFs and images inline (through the permission-checked link), others as a download. */
export function PreviewPanel({ d }: { d: Pick<DocRow, 'id' | 'contentType' | 'fileName' | 'can'> }) {
  const [shown, setShown] = useState(false);
  if (!d.can.preview) return <Alert tone="info" title="Preview not allowed">Super Workspace has not allowed previews for your HR Workspace.</Alert>;
  const inline = d.contentType === 'application/pdf' || d.contentType.startsWith('image/') || d.contentType === 'text/plain';
  if (!inline) return <p className="text-sm text-fg-muted">This file type cannot be shown in the browser. {d.can.download ? 'Download it to open it.' : ''}</p>;
  if (!shown) return <Button variant="secondary" onClick={() => setShown(true)}><Eye className="size-4" aria-hidden /> Show preview</Button>;
  return d.contentType.startsWith('image/')
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={`/document-preview/${d.id}`} alt={`Preview of ${d.fileName}`} className="max-h-[70vh] w-full rounded-lg border border-border object-contain" />
    : <iframe src={`/document-preview/${d.id}`} title={`Preview of ${d.fileName}`} className="h-[70vh] w-full rounded-lg border border-border" />;
}

/** The verifier's comment under a document's status: the reason for a rejection or correction, or a note on approval. */
export function ReviewerNote({ status, text }: { status: string | null; text: string }) {
  const tone = status === 'rejected' ? 'border-danger bg-danger-subtle text-danger' : status === 'correction_required' ? 'border-ember bg-ember-subtle text-ember' : 'border-border bg-bg-subtle text-fg-muted';
  const label = status === 'rejected' ? 'Reason' : status === 'correction_required' ? 'To fix' : 'Comment';
  return <span className={`mt-1 block max-w-[16rem] whitespace-pre-wrap rounded-md border-l-2 px-2 py-1 text-xs ${tone}`}><span className="font-semibold">{label}:</span> {text}</span>;
}
