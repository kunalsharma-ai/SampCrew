'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Textarea } from '@crew/ui';
import { Download, FileText, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import type { CandidateDetail, Designation, Offer, RecruitPerson, Requisition, Stage } from '@/lib/types';
import {
  addToJobAction, draftOfferAction, eraseCandidateAction, hireAction, moveAction, noteAction, offerResponseAction, offerStepAction, rejectAction, reopenAction,
  scheduleInterviewAction, updateCandidateAction, updateOfferAction, uploadCvAction, withdrawAction,
} from '../../actions';
import { APP_STATUS, EVENT, MODE, money, OFFER_STATUS, opts, REJECTION, SOURCE, when } from '../../labels';
import { useRunner } from '../../use-runner';

type App = CandidateDetail['applications'][number];
type DialogState =
  | { kind: 'edit' }
  | { kind: 'reject'; app: App }
  | { kind: 'interview'; app: App }
  | { kind: 'offer'; app: App; offer?: Offer }
  | { kind: 'response'; offer: Offer }
  | { kind: 'hire'; app: App; offer: Offer }
  | null;

const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export function CandidateView({ detail, stages, people, openJobs, designations }: { detail: CandidateDetail; stages: Stage[]; people: RecruitPerson[]; openJobs: Requisition[]; designations: Designation[] }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [dialog, setDialog] = useState<DialogState>(null);
  const c = detail.candidate;
  const erased = Boolean(c.anonymizedAt);
  const path = `/recruitment/candidates/${c.id}`;
  const paths = (a: App) => [path, `/recruitment/jobs/${a.requisitionId}`];
  const offersOf = (a: App) => detail.offers.filter((o) => o.applicationId === a.id);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="grid content-start gap-6">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

        {detail.applications.map((a) => {
          const offers = offersOf(a);
          const live = offers.find((o) => ['draft', 'pending_approval', 'approved', 'sent', 'accepted'].includes(o.status));
          const interviews = detail.interviews.filter((i) => i.applicationId === a.id);
          const manage = a.can.manage && !erased;
          return (
            <Card key={a.id}>
              <CardHeader
                title={<Link className="hover:underline" href={`/recruitment/jobs/${a.requisitionId}`}>{a.requisitionTitle} <span className="font-mono text-xs text-fg-muted">{a.requisitionCode}</span></Link>}
                description={`${a.status === 'active' ? a.stageName : APP_STATUS[a.status]} · applied ${new Date(a.appliedAt).toLocaleDateString()} via ${SOURCE[a.source] ?? a.source}${a.rejectionReason ? ` · ${REJECTION[a.rejectionReason]}` : ''}`}
                action={manage && (
                  <div className="flex flex-wrap items-center gap-2">
                    {a.status === 'active' && (
                      <Select aria-label="Move to stage" className="h-8 w-40 text-xs" value="" disabled={pending} onChange={(e) => e.target.value && run(() => moveAction(a.id, e.target.value, paths(a)))}>
                        <option value="">Move to…</option>
                        {stages.filter((s) => s.id !== a.stageId && s.kind !== 'hired').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                    )}
                    {a.status === 'active' && <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'interview', app: a })}>Schedule interview</Button>}
                    {a.status === 'active' && a.can.offers && !live && <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'offer', app: a })}>Draft offer</Button>}
                    {a.status === 'active' && <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'reject', app: a })}>Reject</Button>}
                    {a.status === 'active' && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Mark that the candidate withdrew from this job?') && run(() => withdrawAction(a.id, paths(a)))}>Withdrew</Button>}
                    {['rejected', 'withdrawn'].includes(a.status) && <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => reopenAction(a.id, paths(a)))}>Reopen</Button>}
                  </div>
                )}
              />
              <CardBody className="grid gap-4 text-[0.8125rem]">
                {a.status === 'hired' && a.employeeId && <Alert tone="success">Hired. <Link className="font-medium underline" href={`/employees/${a.employeeId}`}>Open their employee record</Link></Alert>}
                {a.coverNote && <div><div className="text-fg-muted">Cover note</div><p className="whitespace-pre-wrap">{a.coverNote}</p></div>}
                {a.rejectionNote && <div><div className="text-fg-muted">Rejection note (internal)</div><p className="whitespace-pre-wrap">{a.rejectionNote}</p></div>}

                {interviews.length > 0 && (
                  <div className="grid gap-1.5">
                    <div className="font-medium">Interviews</div>
                    {interviews.map((i) => (
                      <div key={i.id} className="flex flex-wrap items-center gap-2">
                        <Link className="text-accent hover:underline" href={`/recruitment/interviews/${i.id}`}>{i.title}</Link>
                        <span className="text-fg-muted">{when(i.startsAt)} · {MODE[i.mode]}</span>
                        {i.status === 'cancelled' ? <Badge tone="neutral">Cancelled</Badge> : (i.panel ?? []).map((p) => <Badge key={p.membershipId} tone={p.submitted ? 'success' : 'neutral'}>{p.name}{p.submitted ? ' ✓' : ''}</Badge>)}
                      </div>
                    ))}
                    {a.averageScore && <div className="text-fg-muted">Average score {a.averageScore} out of 4 from {a.scorecards} scorecard{a.scorecards === 1 ? '' : 's'}</div>}
                  </div>
                )}

                {offers.map((o) => (
                  <div key={o.id} className="rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-medium">Offer: {o.jobTitle}</span> <Badge tone={o.status === 'accepted' ? 'success' : ['declined', 'withdrawn', 'rejected'].includes(o.status) ? 'neutral' : 'warning'} dot>{OFFER_STATUS[o.status]}</Badge>
                        {o.aboveRange && <Badge tone="danger" className="ml-1">Above approved budget</Badge>}
                      </div>
                      {a.can.offers && !erased && (
                        <div className="flex flex-wrap gap-2">
                          {['draft', 'rejected'].includes(o.status) && <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'offer', app: a, offer: o })}>Edit</Button>}
                          {['draft', 'rejected'].includes(o.status) && <Button size="sm" loading={pending} onClick={() => run(() => offerStepAction(o.id, 'submit', paths(a)))}>Submit for approval</Button>}
                          {o.status === 'approved' && <Button size="sm" loading={pending} onClick={() => confirm('Email the offer terms to the candidate now?') && run(() => offerStepAction(o.id, 'send', paths(a)))}>Send to candidate</Button>}
                          {o.status === 'sent' && <Button size="sm" onClick={() => setDialog({ kind: 'response', offer: o })}>Record answer</Button>}
                          {['draft', 'pending_approval', 'approved', 'sent', 'accepted'].includes(o.status) && a.status === 'active' && (
                            <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Withdraw this offer?') && run(() => offerStepAction(o.id, 'withdraw', paths(a)))}>Withdraw</Button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="mt-1.5 text-fg-muted">
                      {money(o.baseSalary, o.currency)} {o.payPeriod === 'annual' ? 'a year' : o.payPeriod === 'monthly' ? 'a month' : 'an hour'}
                      {o.variablePay ? ` + ${o.variablePay}` : ''} · joining {o.joiningDate} · reply by {o.expiresOn}
                      {o.responseNote ? ` · “${o.responseNote}”` : ''}
                    </div>
                    {o.status === 'accepted' && a.status === 'active' && (
                      <div className="mt-2">
                        {detail.can.hire
                          ? <Button size="sm" onClick={() => setDialog({ kind: 'hire', app: a, offer: o })}>Hire and create employee record</Button>
                          : <span className="text-fg-muted">HR completes the hire, which creates the employee record.</span>}
                      </div>
                    )}
                  </div>
                ))}
              </CardBody>
            </Card>
          );
        })}
        {!detail.applications.length && <Card><EmptyState title="Not in any job you can see" /></Card>}

        {!erased && openJobs.length > 0 && <AddToJob candidateId={c.id} jobs={openJobs} run={run} pending={pending} />}

        <Card>
          <CardHeader title="Notes" description="Visible to people who can see this candidate. Never shared with the candidate." />
          <CardBody className="grid gap-3">
            {!erased && detail.can.edit && <NoteForm onSubmit={(body) => run(() => noteAction(c.id, body))} pending={pending} />}
            {detail.notes.map((n) => (
              <div key={n.id} className="border-l-2 border-border pl-3 text-[0.8125rem]">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <div className="text-xs text-fg-muted">{n.authorName ?? 'Someone'} · {when(n.createdAt)}</div>
              </div>
            ))}
            {!detail.notes.length && <div className="text-[0.8125rem] text-fg-muted">No notes yet.</div>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="History" />
          <CardBody>
            <ol className="grid gap-1.5 text-[0.8125rem]">
              {detail.timeline.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-2">
                  <span className="text-fg-muted tabular-nums">{when(e.createdAt)}</span>
                  <span className="font-medium">{EVENT[e.kind] ?? e.kind}</span>
                  {e.kind === 'stage_changed' && <span>{e.fromStage} → {e.toStage}</span>}
                  {e.kind === 'email_queued' && <span className="text-fg-muted">{e.detail.subject ? `“${String(e.detail.subject)}”` : String(e.detail.template ?? '').replace('candidate.', '')}</span>}
                  {e.actorName && <span className="text-fg-muted">by {e.actorName}</span>}
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      </div>

      <div className="grid content-start gap-6">
        <Card>
          <CardHeader title="Details" action={!erased && detail.can.edit && <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'edit' })}>Edit</Button>} />
          <CardBody>
            <dl className="grid gap-2 text-[0.8125rem]">
              {[
                ['Email', c.email], ['Phone', c.phone], ['Location', c.locationText], ['Profile', c.profileUrl],
                ['Source', `${SOURCE[c.source] ?? c.source}${c.sourceDetail ? ` (${c.sourceDetail})` : ''}`], ['Referred by', c.referredByName],
                ['Basis for holding data', c.consentBasis === 'candidate_consent' ? `Candidate agreed to the privacy notice${c.consentAt ? ` on ${new Date(c.consentAt).toLocaleDateString()}` : ''}` : 'Recruiter confirmed the candidate shared their details'],
              ].filter(([, v]) => v).map(([k, v]) => (
                <div key={k}><dt className="text-fg-muted">{k}</dt><dd className="break-words">{k === 'Profile' ? <a className="text-accent hover:underline" href={String(v)} target="_blank" rel="noreferrer noopener">{v}</a> : v}</dd></div>
              ))}
              {c.tags.length > 0 && <div><dt className="text-fg-muted">Tags</dt><dd className="mt-1 flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t}>{t}</Badge>)}</dd></div>}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="CV and files" />
          <CardBody className="grid gap-2 text-[0.8125rem]">
            {detail.files.map((f) => (
              <a key={f.id} className="flex items-center gap-2 text-accent hover:underline" href={`/recruitment-files/${f.id}`}>
                <FileText className="size-4 shrink-0" /> <span className="truncate">{f.fileName}</span> <span className="ml-auto text-xs text-fg-muted">{Math.ceil(f.sizeBytes / 1024)} KB</span> <Download className="size-3.5" />
              </a>
            ))}
            {!detail.files.length && <div className="text-fg-muted">No files.</div>}
            {!erased && detail.can.edit && <CvUpload candidateId={c.id} />}
          </CardBody>
        </Card>

        {detail.can.erase && !erased && (
          <Card>
            <CardHeader title="Erase personal details" description="For a candidate who asks to be forgotten. Their name, contact details, files, notes and scorecard comments are removed for good. The anonymous pipeline history stays for reporting." />
            <CardBody>
              <Button variant="danger" size="sm" loading={pending} onClick={() => {
                const reason = prompt('Why are you erasing this candidate? (for example: asked by email on 3 October)');
                if (reason && reason.trim().length >= 3 && confirm('This cannot be undone. Erase now?')) run(() => eraseCandidateAction(c.id, reason.trim()));
              }}>Erase candidate</Button>
            </CardBody>
          </Card>
        )}
      </div>

      <ResourceDialog
        open={dialog?.kind === 'edit'}
        onClose={() => setDialog(null)}
        title="Edit candidate"
        fields={[
          { name: 'firstName', label: 'First name', required: true, half: true },
          { name: 'lastName', label: 'Last name', half: true },
          { name: 'email', label: 'Email', required: true, half: true },
          { name: 'phone', label: 'Phone', half: true },
          { name: 'currentTitle', label: 'Current title', half: true },
          { name: 'currentCompany', label: 'Current company', half: true },
          { name: 'locationText', label: 'Location', half: true },
          { name: 'tags', label: 'Tags', half: true, placeholder: 'Comma separated' },
          { name: 'profileUrl', label: 'Profile link' },
        ]}
        initial={{ ...c, tags: c.tags.join(', ') }}
        submitLabel="Save"
        onSubmit={(v) => updateCandidateAction(c.id, v)}
      />
      {dialog?.kind === 'reject' && (
        <ResourceDialog
          open
          onClose={() => setDialog(null)}
          title={`Reject for ${dialog.app.requisitionTitle}`}
          description="The reason and note stay internal. The optional email to the candidate is short and neutral and never includes them."
          fields={[
            { name: 'reason', label: 'Reason', type: 'select', required: true, options: opts(REJECTION) },
            { name: 'note', label: 'Internal note', type: 'textarea' },
            { name: 'notifyCandidate', label: 'Email the candidate', type: 'select', required: true, options: [{ value: 'true', label: 'Yes, send a short neutral email' }, { value: 'false', label: 'No' }] },
          ]}
          initial={{ reason: 'not_qualified', notifyCandidate: 'true' }}
          submitLabel="Reject"
          onSubmit={(v) => rejectAction(dialog.app.id, v, paths(dialog.app))}
        />
      )}
      {dialog?.kind === 'interview' && <InterviewDialog app={dialog.app} people={people} candidateHasEmail={Boolean(c.email)} onClose={() => setDialog(null)} paths={paths(dialog.app)} />}
      {dialog?.kind === 'offer' && (
        <ResourceDialog
          open
          onClose={() => setDialog(null)}
          title={dialog.offer ? 'Edit offer' : 'Draft offer'}
          description="Offers need approval before they are sent. Pay above the requisition's approved budget is flagged to approvers."
          fields={[
            { name: 'jobTitle', label: 'Job title', required: true },
            { name: 'designationId', label: 'Designation', type: 'select', half: true, options: designations.map((d) => ({ value: d.id, label: d.name })) },
            { name: 'payPeriod', label: 'Pay period', type: 'select', required: true, half: true, options: [{ value: 'annual', label: 'Per year' }, { value: 'monthly', label: 'Per month' }, { value: 'hourly', label: 'Per hour' }] },
            { name: 'baseSalary', label: 'Base pay', required: true, half: true, placeholder: 'e.g. 2200000' },
            { name: 'currency', label: 'Currency', required: true, half: true },
            { name: 'variablePay', label: 'Variable pay or bonus', placeholder: 'e.g. Up to 10% annual bonus' },
            { name: 'joiningDate', label: 'Joining date', type: 'date', required: true, half: true },
            { name: 'expiresOn', label: 'Reply by', type: 'date', required: true, half: true },
            { name: 'notes', label: 'Internal notes for approvers', type: 'textarea' },
          ]}
          initial={dialog.offer ? { ...dialog.offer } : { jobTitle: dialog.app.requisitionTitle, payPeriod: 'annual', currency: 'INR', joiningDate: plusDays(30), expiresOn: plusDays(7) }}
          submitLabel={dialog.offer ? 'Save' : 'Save draft'}
          onSubmit={(v) => (dialog.offer ? updateOfferAction(dialog.offer.id, v, paths(dialog.app)) : draftOfferAction(dialog.app.id, v, paths(dialog.app)))}
        />
      )}
      {dialog?.kind === 'response' && (
        <ResourceDialog
          open
          onClose={() => setDialog(null)}
          title="Record the candidate's answer"
          description="Record what the candidate told you, for example by email or phone. SampCrew does not collect signatures."
          fields={[
            { name: 'response', label: 'Answer', type: 'select', required: true, options: [{ value: 'accepted', label: 'Accepted' }, { value: 'declined', label: 'Declined' }] },
            { name: 'note', label: 'Note', placeholder: 'e.g. Accepted by email on 3 October' },
          ]}
          initial={{ response: 'accepted' }}
          submitLabel="Record"
          onSubmit={(v) => offerResponseAction(dialog.offer.id, v, [path])}
        />
      )}
      {dialog?.kind === 'hire' && (
        <ResourceDialog
          open
          onClose={() => setDialog(null)}
          title={`Hire ${c.firstName}`}
          description="Creates their employee record in Core HR from the accepted offer, with the requisition's department, location and hiring manager. Their onboarding checklist starts as usual."
          fields={[
            { name: 'dateOfJoining', label: 'Date of joining', type: 'date', required: true, half: true },
            { name: 'probationMonths', label: 'Probation (months)', type: 'number', required: true, half: true },
            { name: 'workEmail', label: 'Work email', placeholder: 'Optional' },
            { name: 'inviteToCrew', label: 'Invite them to SampCrew', type: 'select', required: true, options: [{ value: 'false', label: 'Not yet' }, { value: 'true', label: 'Yes, send an invitation to the work email' }] },
          ]}
          initial={{ dateOfJoining: dialog.offer.joiningDate, probationMonths: 6, inviteToCrew: 'false' }}
          submitLabel="Hire"
          onSubmit={async (v) => {
            const r = await hireAction(dialog.app.id, v, paths(dialog.app));
            if (r.ok && r.data) router.push(`/employees/${(r.data as { employee: { id: string } }).employee.id}`);
            return r;
          }}
        />
      )}
    </div>
  );
}

function NoteForm({ onSubmit, pending }: { onSubmit: (body: string) => void; pending: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); const v = ref.current?.value.trim(); if (v) { onSubmit(v); ref.current!.value = ''; } }}>
      <Textarea ref={ref} aria-label="New note" placeholder="Add a note" rows={2} />
      <div><Button size="sm" type="submit" variant="secondary" loading={pending}>Add note</Button></div>
    </form>
  );
}

function AddToJob({ candidateId, jobs, run, pending }: { candidateId: string; jobs: Requisition[]; run: ReturnType<typeof useRunner>['run']; pending: boolean }) {
  const [job, setJob] = useState('');
  return (
    <Card>
      <CardHeader title="Consider for another job" />
      <CardBody className="flex gap-2">
        <Select aria-label="Open job" value={job} onChange={(e) => setJob(e.target.value)}>
          <option value="">Choose an open job</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.title} ({j.code})</option>)}
        </Select>
        <Button variant="secondary" disabled={!job} loading={pending} onClick={() => run(() => addToJobAction(candidateId, job), () => setJob(''))}>Add</Button>
      </CardBody>
    </Card>
  );
}

function CvUpload({ candidateId }: { candidateId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const f = form.get('file');
        if (!(f instanceof File) || !f.size) return setError('Choose a PDF or Word file');
        setError(null);
        const target = e.currentTarget;
        start(async () => {
          const r = await uploadCvAction(candidateId, form);
          if (r.ok) { target.reset(); router.refresh(); } else setError(r.message);
        });
      }}
    >
      <Field label="Upload a CV" hint="PDF or Word (.docx), up to 5 MB" error={error ?? undefined}>
        {(p) => <Input {...p} type="file" name="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />}
      </Field>
      <div><Button size="sm" variant="secondary" type="submit" loading={pending}><Upload className="size-3.5" /> Upload</Button></div>
    </form>
  );
}

function InterviewDialog({ app, people, candidateHasEmail, onClose, paths }: { app: App; people: RecruitPerson[]; candidateHasEmail: boolean; onClose: () => void; paths: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [mode, setMode] = useState('video');
  const [panel, setPanel] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const shown = people.filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 50);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Schedule interview: ${app.candidateName}`}
      description="Add the meeting link from your own calendar or video tool. SampCrew notifies the panel and can email the candidate the details."
      size="lg"
      footer={<><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" form="interview-form" loading={pending}>Schedule</Button></>}
    >
      <form
        id="interview-form"
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const local = String(f.get('startsAt') ?? '');
          const values: Record<string, unknown> = {
            title: f.get('title'), startsAt: local ? new Date(local).toISOString().replace('Z', '+00:00') : '', durationMinutes: Number(f.get('durationMinutes')),
            mode, meetingUrl: f.get('meetingUrl') || undefined, locationText: f.get('locationText') || undefined, panelMembershipIds: panel,
            notifyCandidate: f.get('notifyCandidate') === 'on' ? 'true' : 'false',
          };
          setError(null);
          setFe({});
          start(async () => {
            const r = await scheduleInterviewAction(app.id, values, paths);
            if (r.ok) { onClose(); router.refresh(); } else { setError(r.message); setFe(r.fieldErrors ?? {}); }
          });
        }}
      >
        {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
        <Field label="Title" required error={fe.title} className="col-span-2">{(p) => <Input {...p} name="title" required defaultValue="Interview" />}</Field>
        <Field label="Starts" required error={fe.startsAt} className="col-span-2 sm:col-span-1" hint="In your time zone">{(p) => <Input {...p} name="startsAt" type="datetime-local" required />}</Field>
        <Field label="Length (minutes)" required error={fe.durationMinutes} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="durationMinutes" type="number" min={10} max={480} defaultValue={45} required />}</Field>
        <Field label="Format" required className="col-span-2 sm:col-span-1">
          {(p) => <Select {...p} value={mode} onChange={(e) => setMode(e.target.value)}>{Object.entries(MODE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
        </Field>
        {mode === 'video'
          ? <Field label="Meeting link" required error={fe.meetingUrl} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="meetingUrl" placeholder="https://" required />}</Field>
          : <Field label={mode === 'in_person' ? 'Where' : 'Details'} required={mode === 'in_person'} error={fe.locationText} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="locationText" required={mode === 'in_person'} placeholder={mode === 'in_person' ? 'Office, floor, room' : 'Who calls whom'} />}</Field>}
        <Field label="Interviewers" required error={fe.panelMembershipIds} className="col-span-2" hint={`${panel.length} chosen. Each submits their own scorecard.`}>
          {(p) => (
            <div className="grid gap-2">
              <Input {...p} placeholder="Filter people" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2">
                {shown.map((person) => (
                  <Checkbox
                    key={person.membershipId}
                    label={person.name}
                    description={person.departmentName ?? undefined}
                    checked={panel.includes(person.membershipId)}
                    onChange={(e) => setPanel((cur) => (e.target.checked ? [...cur, person.membershipId] : cur.filter((x) => x !== person.membershipId)))}
                  />
                ))}
              </div>
            </div>
          )}
        </Field>
        <div className="col-span-2">
          <Checkbox name="notifyCandidate" defaultChecked={candidateHasEmail} disabled={!candidateHasEmail} label="Email the candidate the time and joining details" />
        </div>
      </form>
    </Dialog>
  );
}
