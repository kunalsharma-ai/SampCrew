'use client';
import { ONBOARDING_REQUIREMENT_LABEL, REQUEST_FILE_LABEL } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { fmtSize } from '../documents/format';
import type { RequestRow } from '../documents/types';
import { UploadBox } from '../documents/ui';
import type { Checklist, ChecklistItem } from './types';
import { fmtDay, OnboardingStatusBadge, ProgressBar } from './ui';

const UPLOADABLE = new Set(['assigned', 'not_submitted', 'rejected', 'resubmission_required']);

/** One checklist, the same record on both sides: the employee uploads, HR reviews. */
export function ChecklistView({ c }: { c: Checklist }) {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  const groups = new Map<string, ChecklistItem[]>();
  for (const i of c.items) groups.set(i.categoryName ?? 'Other documents', [...(groups.get(i.categoryName ?? 'Other documents') ?? []), i]);
  const p = c.progress;
  return (
    <div className="grid gap-5" data-testid="onboarding-checklist">
      {note && <Alert tone="success">{note}</Alert>}
      {c.status === 'completed' && <Alert tone="success" title="Onboarding documents complete">Every mandatory document was approved{c.completedAt ? ` on ${fmtDay(c.completedAt)}` : ''}. The checklist is kept in the onboarding history.</Alert>}
      {c.mine && c.status === 'active' && p.rejected > 0 && <Alert tone="warning" title="Some documents need a new upload">HR has left a comment on each one. Upload a new version below; earlier versions are kept.</Alert>}
      <Card>
        <CardHeader title={c.mine ? 'Your progress' : 'Progress'} description={`${c.templateName ?? 'Documents chosen by HR'} · assigned ${fmtDay(c.assignedAt)}${c.dueOn ? ` · due ${fmtDay(c.dueOn)}` : ''}`} />
        <div className="grid gap-4 px-5 pb-5">
          <ProgressBar percent={p.percent} />
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <Num k="Documents" v={p.total} />
            <Num k="Approved" v={p.approved} tone="text-success" />
            <Num k="Pending HR approval" v={p.pendingApproval} tone="text-info" />
            <Num k="Not submitted" v={p.notSubmitted} tone="text-warning" />
            <Num k="Rejected" v={p.rejected} tone="text-danger" />
          </dl>
          {c.note && <p className="whitespace-pre-wrap text-sm text-fg-muted">{c.note}</p>}
        </div>
      </Card>
      {[...groups.entries()].map(([name, items]) => (
        <Card key={name}>
          <CardHeader title={name} description={`${items.filter((i) => i.approved).length} of ${items.length} approved`} />
          <ul className="grid gap-3 px-5 pb-5">
            {items.map((i) => <ItemRow key={i.requestId} i={i} c={c} onUploaded={() => { setNote(`${i.title} submitted. It is now waiting for HR approval.`); router.refresh(); }} />)}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function Num({ k, v, tone }: { k: string; v: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <dt className="text-xs text-fg-muted">{k}</dt>
      <dd className={`text-lg font-semibold ${tone ?? ''}`}>{v}</dd>
    </div>
  );
}

function ItemRow({ i, c, onUploaded }: { i: ChecklistItem; c: Checklist; onUploaded: () => void }) {
  const [open, setOpen] = useState(false);
  const canUpload = c.mine && c.status === 'active' && UPLOADABLE.has(i.status);
  const asRequest = { id: i.requestId, formats: i.formats, maxMb: i.maxMb, maxFiles: i.maxFiles, expiryRequired: i.expiryRequired } as unknown as RequestRow;
  return (
    <li className="grid gap-2 rounded-xl border border-border p-3" data-testid={`onboarding-item-${i.reference}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{i.title}</p>
          <p className="text-xs text-fg-subtle">
            {i.mandatory ? 'Mandatory' : ONBOARDING_REQUIREMENT_LABEL[i.requirement] ?? 'Optional'} · {i.formats.map((f) => REQUEST_FILE_LABEL[f]).join(', ')}, up to {i.maxMb} MB{i.maxFiles > 1 ? `, up to ${i.maxFiles} files` : ''}
            {i.submissions > 1 ? ` · ${i.submissions} uploads` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!i.mandatory && <Badge tone="neutral">Optional</Badge>}
          <OnboardingStatusBadge status={i.status} label={i.statusLabel} />
        </div>
      </div>
      {i.description && <p className="text-sm text-fg-muted">{i.description}</p>}
      {c.mine && i.instructions && <p className="text-sm text-fg-muted">{i.instructions}</p>}
      {!c.mine && i.verification && <p className="text-xs text-fg-subtle">Check: {i.verification}</p>}
      {i.hrComment && (i.status === 'rejected' || i.status === 'resubmission_required' || i.status === 'approved') && (
        <p className={`rounded-lg px-3 py-2 text-sm ${i.status === 'approved' ? 'bg-success-subtle' : 'bg-danger-subtle'}`}><span className="font-medium">HR comment:</span> {i.hrComment}</p>
      )}
      {i.files.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs text-fg-muted">
          {i.files.map((f) => <li key={f.id} className="rounded-md bg-bg-subtle px-2 py-1">{f.fileName} · {fmtSize(f.sizeBytes)}{f.version > 1 ? ` · v${f.version}` : ''}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {canUpload && !open && <Button size="sm" onClick={() => setOpen(true)} data-testid="onboarding-upload">{i.submissions ? 'Upload again' : 'Upload'}</Button>}
        {!c.mine && c.canReview && i.status === 'pending_hr_approval' && <Link className="font-medium text-accent hover:underline" href={`/documents/requests/${i.requestId}`} data-testid="onboarding-review">Review</Link>}
        <Link className="text-accent hover:underline" href={`/documents/requests/${i.requestId}`}>{c.mine ? 'Details and history' : 'Request and history'}</Link>
        {i.lastSubmittedAt && <span className="text-xs text-fg-subtle">Last upload {fmtDay(i.lastSubmittedAt)}</span>}
      </div>
      {canUpload && open && <UploadBox r={asRequest} onDone={() => { setOpen(false); onUploaded(); }} />}
    </li>
  );
}
