'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Select } from '@crew/ui';
import { ExternalLink, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import type { Application, Pipeline, RequisitionDetail } from '@/lib/types';
import {
  addCandidateAction, moveAction, publishPostingAction, requisitionStatusAction, savePostingAction, saveRequisitionAction, submitRequisitionAction,
} from '../../actions';
import { EMPLOYMENT, OFFER_STATUS, opts, range, REQ_STATUS, REQ_TONE, SOURCE, WORK_MODE } from '../../labels';
import { requisitionFields, requisitionInitial, type RequisitionRefs } from '../../requisition-form';
import { useRunner } from '../../use-runner';

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const SOURCES = Object.fromEntries(Object.entries(SOURCE).filter(([k]) => k !== 'career_site'));

export function JobView({ req, pipeline, show, refs }: { req: RequisitionDetail; pipeline: Pipeline | null; show: string | null; refs: RequisitionRefs }) {
  const { pending, notice, run } = useRunner();
  const [dialog, setDialog] = useState<null | 'edit' | 'posting' | 'candidate'>(null);
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
              <div className="flex gap-3 overflow-x-auto p-4">
                {pipeline.stages.map((st) => {
                  const apps = pipeline.applications.filter((a) => a.stageId === st.id);
                  return (
                    <section key={st.id} aria-label={st.name} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-bg-subtle p-2">
                      <h3 className="flex items-center justify-between px-1 text-[0.8125rem] font-semibold">{st.name}<span className="text-xs font-normal text-fg-muted">{apps.length}</span></h3>
                      {apps.map((a) => (
                        <AppCard key={a.id} a={a}>
                          {req.can.manageCandidates && a.status === 'active' && (
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
                    </section>
                  );
                })}
              </div>
            )
          ) : (
            <EmptyState title={show ? 'Nobody here' : 'No candidates yet'} description={req.posting?.published ? 'Applications from your career site appear here.' : 'Add candidates by hand, or publish the posting to take applications.'} />
          )}
        </Card>
      )}

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

function AppCard({ a, children }: { a: Application; children?: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface p-2.5 text-[0.8125rem] shadow-card">
      <Link className="font-medium text-accent hover:underline" href={`/recruitment/candidates/${a.candidateId}`}>{a.candidateName}</Link>
      {(a.currentTitle || a.currentCompany) && <div className="truncate text-xs text-fg-muted">{[a.currentTitle, a.currentCompany].filter(Boolean).join(' at ')}</div>}
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Badge tone="neutral">{SOURCE[a.source] ?? a.source}</Badge>
        {a.status !== 'active' && <Badge tone={a.status === 'hired' ? 'success' : 'neutral'}>{a.status === 'hired' ? 'Hired' : a.status === 'rejected' ? 'Rejected' : 'Withdrew'}</Badge>}
        {a.interviews > 0 && <Badge tone="info">{a.interviews} interview{a.interviews > 1 ? 's' : ''}</Badge>}
        {a.scorecards > 0 && <Badge tone="accent">{a.averageScore} / 4 from {a.scorecards}</Badge>}
        {a.offerStatus && <Badge tone={a.offerStatus === 'accepted' ? 'success' : 'warning'}>Offer: {OFFER_STATUS[a.offerStatus]?.toLowerCase() ?? a.offerStatus}</Badge>}
      </div>
      {children}
    </div>
  );
}

