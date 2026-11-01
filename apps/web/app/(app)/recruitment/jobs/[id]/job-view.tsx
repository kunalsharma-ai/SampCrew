'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Select, buttonClass, cn } from '@crew/ui';
import { Columns3, ExternalLink, GripVertical, Mail, Plus, UserX } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import type { Application, Pipeline, RequisitionDetail } from '@/lib/types';
import {
  addCandidateAction, moveAction, publishPostingAction, requisitionStatusAction, savePostingAction, saveRequisitionAction, submitRequisitionAction,
  bulkApplicationsAction,
} from '../../actions';
import { EMPLOYMENT, OFFER_STATUS, opts, range, REJECTION, REQ_STATUS, REQ_TONE, SOURCE, WORK_MODE } from '../../labels';
import { requisitionFields, requisitionInitial, type RequisitionRefs } from '../../requisition-form';
import { useRunner } from '../../use-runner';

/** Up to 100 candidates can be selected for a bulk action; 2 to 4 of them can be compared. */
const MAX_PICK = 100;
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const SOURCES = Object.fromEntries(Object.entries(SOURCE).filter(([k]) => k !== 'career_site'));

export function JobView({ req, pipeline, show, refs }: { req: RequisitionDetail; pipeline: Pipeline | null; show: string | null; refs: RequisitionRefs }) {
  const { pending, notice, run } = useRunner();
  const router = useRouter();
  const [bulkPending, startBulk] = useTransition();
  const [bulkNote, setBulkNote] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const [dialog, setDialog] = useState<null | 'edit' | 'posting' | 'candidate' | 'bulk-reject' | 'bulk-email'>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [dragging, setDragging] = useState<Application | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_PICK ? p : [...p, id]));
  const toggleStage = (ids: string[], on: boolean) => setPicked((p) => (on ? [...new Set([...p, ...ids])].slice(0, MAX_PICK) : p.filter((x) => !ids.includes(x))));
  const names = Object.fromEntries((pipeline?.applications ?? []).map((a) => [a.id, a.candidateName]));
  const pickedActive = picked.filter((id) => pipeline?.applications.find((a) => a.id === id)?.status === 'active');
  const bulk = async (body: Record<string, unknown>) => {
    const r = await bulkApplicationsAction(req.id, { ...body, applicationIds: pickedActive }, names);
    setBulkNote(r.ok ? { tone: r.message?.includes('Skipped') ? 'warning' : 'success', text: r.message ?? 'Done.' } : { tone: 'danger', text: r.message });
    if (r.ok) { setPicked([]); router.refresh(); }
    return r;
  };
  const canDrag = (a: Application) => req.can.manageCandidates && a.status === 'active';
  const drop = (stageId: string) => {
    const a = dragging;
    setDragging(null);
    setOver(null);
    if (!a || a.stageId === stageId) return;
    run(() => moveAction(a.id, stageId, [path]));
  };
  const s = req.status;
  const path = `/recruitment/jobs/${req.id}`;
  const careerUrl = req.careerSite && req.posting ? `/careers/${req.careerSite.slug}/${req.posting.slug}` : null;
  const reason = (q: string) => {
    const r = prompt(q);
    return r === null ? null : r.trim();
  };

  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {s === 'pending_approval' && <Alert tone="warning" title="Waiting for approval">HR approves new requisitions. You will get a notification when it is decided.</Alert>}
      {s === 'rejected' && <Alert tone="danger" title="Not approved">{req.statusReason ?? 'Change the requisition and submit it again, or cancel it.'}</Alert>}

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2">Requisition <Badge tone={REQ_TONE[s] ?? 'neutral'} dot>{REQ_STATUS[s] ?? s}</Badge></span>}
          action={req.can.edit && (
            <div className="flex flex-wrap gap-2">
              {['draft', 'rejected', 'approved', 'open', 'on_hold'].includes(s) && <Button size="sm" variant="secondary" onClick={() => setDialog('edit')}>Edit</Button>}
              {['draft', 'rejected'].includes(s) && <Button size="sm" loading={pending} onClick={() => run(() => submitRequisitionAction(req.id))}>Submit for approval</Button>}
              {s === 'approved' && <Button size="sm" loading={pending} onClick={() => run(() => requisitionStatusAction(req.id, 'open'))}>Open for hiring</Button>}
              {s === 'open' && <Button size="sm" variant="secondary" loading={pending} onClick={() => { const r = reason('Why is this job on hold? (optional)'); if (r !== null) run(() => requisitionStatusAction(req.id, 'hold', r)); }}>Put on hold</Button>}
              {s === 'on_hold' && <Button size="sm" loading={pending} onClick={() => run(() => requisitionStatusAction(req.id, 'reopen'))}>Reopen</Button>}
              {['approved', 'open', 'on_hold'].includes(s) && <Button size="sm" variant="ghost" loading={pending} onClick={() => { const r = reason('Close this job? Candidates in process stay as they are. Reason (optional):'); if (r !== null) run(() => requisitionStatusAction(req.id, 'close', r)); }}>Close</Button>}
              {['draft', 'pending_approval', 'rejected'].includes(s) && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Cancel this requisition?') && run(() => requisitionStatusAction(req.id, 'cancel'))}>Cancel requisition</Button>}
            </div>
          )}
        />
        <CardBody>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[0.8125rem] sm:grid-cols-4">
            <div><dt className="text-fg-muted">Openings</dt><dd className="font-medium tabular-nums">{req.hiredCount} of {req.headcount} filled</dd></div>
            <div><dt className="text-fg-muted">Type</dt><dd className="font-medium">{EMPLOYMENT[req.employmentType] ?? req.employmentType}, {WORK_MODE[req.workMode]}</dd></div>
            <div><dt className="text-fg-muted">Budget per year</dt><dd className="font-medium">{range(req.salaryMin, req.salaryMax, req.currency)}</dd></div>
            <div><dt className="text-fg-muted">Target start</dt><dd className="font-medium">{req.targetStartDate ?? 'Not set'}</dd></div>
            <div><dt className="text-fg-muted">Legal entity</dt><dd className="font-medium">{req.legalEntityName}</dd></div>
            <div><dt className="text-fg-muted">Raised by</dt><dd className="font-medium">{req.createdByName ?? 'Unknown'}</dd></div>
            <div className="col-span-2"><dt className="text-fg-muted">Scorecard</dt><dd className="font-medium">{req.scorecard.join(' · ')}</dd></div>
            {req.justification && <div className="col-span-2 sm:col-span-4"><dt className="text-fg-muted">Why this hire is needed</dt><dd className="whitespace-pre-wrap">{req.justification}</dd></div>}
          </dl>
        </CardBody>
      </Card>

      {req.can.manageCandidates && !['cancelled', 'rejected'].includes(s) && (
        <Card>
          <CardHeader
            title={<span className="flex items-center gap-2">Job posting {req.posting?.published ? <Badge tone="success" dot>On career site</Badge> : <Badge tone="neutral">Not published</Badge>}</span>}
            description={req.careerSite ? (req.careerSite.enabled ? undefined : 'Your career site is switched off in Recruitment settings.') : 'Set up your career site in Recruitment settings to publish jobs.'}
            action={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setDialog('posting')}>{req.posting ? 'Edit posting' : 'Write posting'}</Button>
                {req.posting && !req.posting.published && <Button size="sm" loading={pending} disabled={s !== 'open'} title={s !== 'open' ? 'Open the requisition first' : undefined} onClick={() => run(() => publishPostingAction(req.id, true))}>Publish</Button>}
                {req.posting?.published && <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => publishPostingAction(req.id, false))}>Unpublish</Button>}
              </div>
            }
          />
          {req.posting && (
            <CardBody className="grid gap-2 text-[0.8125rem]">
              <div className="font-medium">{req.posting.publicTitle}{req.posting.locationText ? <span className="text-fg-muted"> · {req.posting.locationText}</span> : null}</div>
              {req.posting.summary && <div className="text-fg-muted">{req.posting.summary}</div>}
              {careerUrl && req.posting.published && req.careerSite?.enabled && (
                <a className="inline-flex items-center gap-1 text-accent hover:underline" href={careerUrl} target="_blank" rel="noreferrer">View on career site <ExternalLink className="size-3" /></a>
              )}
            </CardBody>
          )}
        </Card>
      )}

      {pipeline && (
        <Card>
          <CardHeader
            title="Pipeline"
            description={`${pipeline.counts.active} in process · ${pipeline.counts.hired} hired · ${pipeline.counts.rejected} rejected · ${pipeline.counts.withdrawn} withdrew`}
            action={
              <div className="flex flex-wrap items-center gap-3">
                <Link className="text-[0.8125rem] font-medium text-accent hover:underline" href={show ? path : `${path}?show=rejected`}>{show ? 'Show active candidates' : 'Show rejected'}</Link>
                {req.can.manageCandidates && ['approved', 'open', 'on_hold'].includes(s) && <Button size="sm" onClick={() => setDialog('candidate')}><Plus className="size-3.5" /> Add candidate</Button>}
              </div>
            }
          />
          {pipeline.applications.length ? (
            show ? (
              <CardBody className="grid gap-2">
                {pipeline.applications.map((a) => <AppCard key={a.id} a={a} />)}
              </CardBody>
            ) : (
              <>
                {bulkNote && <Alert tone={bulkNote.tone} className="mx-4 mt-3">{bulkNote.text}</Alert>}
                <p className="px-5 pt-3 text-xs text-fg-subtle">{req.can.manageCandidates ? 'Drag a card to another stage, or use Move to. Tick candidates to move, email or reject them together, or ' : 'Tick '}two to four candidates to compare them side by side.</p>
                <div className="flex gap-3 overflow-x-auto p-4">
                  {pipeline.stages.map((st) => {
                    const apps = pipeline.applications.filter((a) => a.stageId === st.id);
                    const droppable = !!dragging && st.kind !== 'hired' && dragging.stageId !== st.id;
                    return (
                      <section
                        key={st.id}
                        aria-label={st.name}
                        onDragOver={(e) => { if (droppable) { e.preventDefault(); setOver(st.id); } }}
                        onDragLeave={() => setOver((o) => (o === st.id ? null : o))}
                        onDrop={(e) => { e.preventDefault(); if (droppable) drop(st.id); }}
                        className={cn('flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-bg-subtle p-2 transition-colors', droppable && 'ring-1 ring-dashed ring-accent/40', over === st.id && 'bg-accent/10 ring-2 ring-accent')}
                      >
                        <h3 className="flex items-center gap-1.5 px-1 text-[0.8125rem] font-semibold">
                          {req.can.manageCandidates && apps.length > 0 && (
                            <input
                              type="checkbox"
                              aria-label={`Select everyone in ${st.name}`}
                              checked={apps.every((a) => picked.includes(a.id))}
                              onChange={(e) => toggleStage(apps.map((a) => a.id), e.target.checked)}
                              className="size-3.5 accent-[var(--color-accent)]"
                            />
                          )}
                          <span className="flex-1">{st.name}</span><span className="text-xs font-normal text-fg-muted">{apps.length}</span>
                        </h3>
                        {apps.map((a) => (
                          <AppCard
                            key={a.id}
                            a={a}
                            picked={picked.includes(a.id)}
                            onPick={() => toggle(a.id)}
                            pickDisabled={!picked.includes(a.id) && picked.length >= MAX_PICK}
                            draggable={canDrag(a) && !pending}
                            onDragStart={() => setDragging(a)}
                            onDragEnd={() => { setDragging(null); setOver(null); }}
                          >
                            {canDrag(a) && (
                              <Select
                                aria-label={`Move ${a.candidateName}`}
                                className="mt-2 h-8 text-xs"
                                value=""
                                disabled={pending}
                                onChange={(e) => e.target.value && run(() => moveAction(a.id, e.target.value, [path]))}
                              >
                                <option value="">Move to…</option>
                                {pipeline.stages.filter((x) => x.id !== st.id && x.kind !== 'hired').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                              </Select>
                            )}
                          </AppCard>
                        ))}
                        {droppable && !apps.length && <p className="rounded-md border border-dashed border-accent/40 p-3 text-center text-xs text-fg-subtle">Drop here</p>}
                      </section>
                    );
                  })}
                </div>
                {picked.length > 0 && (
                  <div className="sticky bottom-3 mx-4 mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 shadow-card" role="region" aria-label="Selected candidates">
                    <span className="text-[0.8125rem] font-medium">{picked.length} selected</span>
                    <Button size="sm" variant="ghost" onClick={() => setPicked([])}>Clear</Button>
                    <span className="flex-1" />
                    {req.can.manageCandidates && pickedActive.length > 0 && (
                      <>
                        <Select
                          aria-label="Move selected to"
                          className="h-8 w-auto text-xs"
                          value=""
                          disabled={bulkPending}
                          onChange={(e) => { const stageId = e.target.value; if (stageId) startBulk(async () => { await bulk({ action: 'move', stageId }); }); }}
                        >
                          <option value="">Move {pickedActive.length} to…</option>
                          {pipeline.stages.filter((x) => x.kind !== 'hired').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </Select>
                        <Button size="sm" variant="secondary" onClick={() => setDialog('bulk-email')}><Mail className="size-3.5" /> Email {pickedActive.length}</Button>
                        <Button size="sm" variant="secondary" onClick={() => setDialog('bulk-reject')}><UserX className="size-3.5" /> Reject {pickedActive.length}</Button>
                      </>
                    )}
                    {picked.length >= 2 && picked.length <= 4
                      ? <Link href={`${path}/compare?applications=${picked.join(',')}`} className={buttonClass('primary', 'sm')}><Columns3 className="size-3.5" /> Compare {picked.length}</Link>
                      : <Button size="sm" disabled title="Compare two to four candidates"><Columns3 className="size-3.5" /> Compare</Button>}
                  </div>
                )}
              </>
            )
          ) : (
            <EmptyState title={show ? 'Nobody here' : 'No candidates yet'} description={req.posting?.published ? 'Applications from your career site appear here.' : 'Add candidates by hand, or publish the posting to take applications.'} />
          )}
        </Card>
      )}

      <ResourceDialog
        open={dialog === 'bulk-reject'}
        onClose={() => setDialog(null)}
        title={`Reject ${pickedActive.length} candidate${pickedActive.length === 1 ? '' : 's'}`}
        description="Each application is closed with this reason and future interviews are cancelled. Candidates with an accepted offer are skipped."
        fields={[
          { name: 'reason', label: 'Reason', type: 'select', required: true, options: opts(REJECTION) },
          { name: 'note', label: 'Internal note', type: 'textarea', hint: 'Never shown to candidates' },
          { name: 'notifyCandidate', label: 'Tell the candidates', type: 'select', required: true, options: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes, send each a short, neutral email' }] },
        ]}
        initial={{ notifyCandidate: 'false' }}
        submitLabel="Reject"
        onSubmit={(v) => bulk({ action: 'reject', reason: v.reason, note: v.note || undefined, notifyCandidate: v.notifyCandidate === 'true' })}
      />
      <ResourceDialog
        open={dialog === 'bulk-email'}
        onClose={() => setDialog(null)}
        title={`Email ${pickedActive.length} candidate${pickedActive.length === 1 ? '' : 's'}`}
        description="Each candidate gets their own email from your organisation, and it is recorded on their timeline."
        fields={[
          { name: 'subject', label: 'Subject', required: true },
          { name: 'message', label: 'Message', type: 'textarea', required: true, hint: '{firstName} and {jobTitle} are filled in for each candidate' },
        ]}
        initial={{ subject: `Your application for {jobTitle}`, message: 'Dear {firstName},\n\n' }}
        submitLabel="Send emails"
        onSubmit={(v) => bulk({ action: 'email', subject: v.subject, message: v.message })}
      />
      <ResourceDialog
        open={dialog === 'edit'}
        onClose={() => setDialog(null)}
        title="Edit requisition"
        description={['approved', 'open', 'on_hold'].includes(s) ? 'The budget and shape of an approved role are fixed. Raise a new requisition to change them.' : undefined}
        fields={requisitionFields(refs, ['approved', 'open', 'on_hold'].includes(s))}
        initial={requisitionInitial(req)}
        submitLabel="Save"
        onSubmit={(v) => saveRequisitionAction(req.id, v)}
      />
      <ResourceDialog
        open={dialog === 'posting'}
        onClose={() => setDialog(null)}
        title="Job posting"
        description="This is what applicants see on your career site. Internal notes and the justification are never shown."
        fields={[
          { name: 'publicTitle', label: 'Title', required: true },
          { name: 'slug', label: 'Web address', required: true, half: true, hint: 'Lowercase letters, numbers and dashes' },
          { name: 'locationText', label: 'Location shown', half: true, placeholder: 'e.g. Pune or remote' },
          { name: 'summary', label: 'One-line summary' },
          { name: 'description', label: 'Description', type: 'textarea', required: true },
          { name: 'showSalary', label: 'Show the budget range', type: 'select', required: true, options: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }] },
        ]}
        initial={req.posting ? { ...req.posting, showSalary: String(req.posting.showSalary) } : { publicTitle: req.title, slug: slugify(req.title), description: req.description, showSalary: 'false' }}
        submitLabel="Save posting"
        onSubmit={(v) => savePostingAction(req.id, v)}
      />
      <ResourceDialog
        open={dialog === 'candidate'}
        onClose={() => setDialog(null)}
        title="Add candidate"
        description="Only add people who have shared their details with you for this purpose, for example by sending a CV."
        fields={[
          { name: 'firstName', label: 'First name', required: true, half: true },
          { name: 'lastName', label: 'Last name', half: true },
          { name: 'email', label: 'Email', required: true, half: true },
          { name: 'phone', label: 'Phone', half: true },
          { name: 'currentTitle', label: 'Current title', half: true },
          { name: 'currentCompany', label: 'Current company', half: true },
          { name: 'source', label: 'Source', type: 'select', required: true, half: true, options: opts(SOURCES) },
          { name: 'sourceDetail', label: 'Source detail', half: true, placeholder: 'e.g. agency name, referrer' },
          { name: 'profileUrl', label: 'Profile link', placeholder: 'https://' },
          { name: 'lawfulBasisConfirmed', label: 'I may store this person’s details', type: 'select', required: true, options: [{ value: 'true', label: 'Yes, they shared them with us to be considered' }] },
        ]}
        initial={{ source: 'manual', lawfulBasisConfirmed: 'true' }}
        submitLabel="Add to this job"
        onSubmit={(v) => addCandidateAction({ ...v, requisitionId: req.id })}
      />
    </div>
  );
}

const daysSince = (d: string) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));

function AppCard({ a, children, picked, onPick, pickDisabled, draggable, onDragStart, onDragEnd }: {
  a: Application; children?: React.ReactNode; picked?: boolean; onPick?: () => void; pickDisabled?: boolean; draggable?: boolean; onDragStart?: () => void; onDragEnd?: () => void;
}) {
  const days = a.status === 'active' ? daysSince(a.stageEnteredAt) : null;
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', a.id); onDragStart?.(); }}
      onDragEnd={onDragEnd}
      data-application={a.id}
      className={cn('rounded-md border bg-surface p-2.5 text-[0.8125rem] shadow-card', picked ? 'border-accent ring-1 ring-accent' : 'border-border', draggable && 'cursor-grab active:cursor-grabbing')}
    >
      <div className="flex items-start gap-1.5">
        {draggable && <GripVertical className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />}
        <Link className="min-w-0 flex-1 truncate font-medium text-accent hover:underline" href={`/recruitment/candidates/${a.candidateId}`}>{a.candidateName}</Link>
        {onPick && <input type="checkbox" checked={!!picked} disabled={pickDisabled} onChange={onPick} aria-label={`Select ${a.candidateName}`} className="mt-0.5 size-3.5 accent-[var(--color-accent)]" />}
      </div>
      {(a.currentTitle || a.currentCompany) && <div className="truncate text-xs text-fg-muted">{[a.currentTitle, a.currentCompany].filter(Boolean).join(' at ')}</div>}
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Badge tone="neutral">{SOURCE[a.source] ?? a.source}</Badge>
        {days !== null && <Badge tone={days > 14 ? 'warning' : 'neutral'}>{days === 0 ? 'New in stage' : `${days}d in stage`}</Badge>}
        {a.status !== 'active' && <Badge tone={a.status === 'hired' ? 'success' : 'neutral'}>{a.status === 'hired' ? 'Hired' : a.status === 'rejected' ? 'Rejected' : 'Withdrew'}</Badge>}
        {a.interviews > 0 && <Badge tone="info">{a.interviews} interview{a.interviews > 1 ? 's' : ''}</Badge>}
        {a.scorecards > 0 && <Badge tone="accent">{a.averageScore} / 4 from {a.scorecards}</Badge>}
        {a.offerStatus && <Badge tone={a.offerStatus === 'accepted' ? 'success' : 'warning'}>Offer: {OFFER_STATUS[a.offerStatus]?.toLowerCase() ?? a.offerStatus}</Badge>}
      </div>
      {children}
    </div>
  );
}
