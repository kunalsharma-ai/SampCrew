'use client';
import {
  ACTIVITY_TYPES, CALL_OUTCOMES, DOCUMENT_KINDS, FOLLOW_UP_PRIORITIES, FOLLOW_UP_TYPES, INTERVIEW_OUTCOMES, REFERENCE_RELATIONSHIPS, REFERENCE_TYPES, REMARK_CATEGORIES,
  REMINDER_OPTIONS, crmLabel,
} from '@crew/contracts';
import { Alert, Avatar, Badge, Button, buttonClass, Card, CardBody, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Textarea } from '@crew/ui';
import { Archive, CalendarPlus, Camera, Download, Eye, FileText, Pencil, PhoneCall, Plus, Share2, Trash2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useRunner } from '../../../use-runner';
import {
  addFollowUpAction, addReferenceAction, archiveAction, assignAction, deleteDocumentAction, eraseAction, logActivityAction, photoAction, remarkAction, removePhotoAction,
  removeReferenceAction, replaceDocumentAction, shareAction, stageAction, updateFollowUpAction, uploadDocumentAction,
} from '../../crm-actions';
import type { CrmContext, CrmDocument, CrmProfile, FollowUp } from '../../crm-types';
import { FollowUpBadge, NoticeBar, PriorityBadge, StageBadge, dash, day, dueText, localInput, money, toIso, when } from '../../crm-ui';

type DialogState =
  | { kind: 'activity' } | { kind: 'followUp' } | { kind: 'reference' } | { kind: 'document' } | { kind: 'replace'; doc: CrmDocument }
  | { kind: 'share' } | { kind: 'erase' } | { kind: 'stage'; stage: string } | { kind: 'close'; followUp: FollowUp; status: 'completed' | 'missed' | 'cancelled' | 'rescheduled' }
  | null;

const TABS: [string, string][] = [
  ['overview', 'Overview'], ['remarks', 'Remarks'], ['references', 'References'], ['activities', 'Activities'], ['follow-ups', 'Follow-ups'],
  ['documents', 'Documents'], ['jobs', 'Jobs'], ['timeline', 'Timeline'],
];
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const inHours = (h: number) => localInput(new Date(Date.now() + h * 3600000));

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="text-[0.8125rem] text-fg">{dash(value)}</dd>
    </div>
  );
}

export function ProfileView({ ctx, profile, tab, saved }: { ctx: CrmContext; profile: CrmProfile; tab: string; saved: string | null }) {
  const { pending, notice, run } = useRunner();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [remark, setRemark] = useState({ body: '', category: 'general', restricted: false });
  const photoInput = useRef<HTMLInputElement>(null);
  const c = profile.candidate;
  const id = c.id;
  const erased = Boolean(c.anonymizedAt);
  const can = profile.can;
  const edit = can.edit && !erased;
  const stage = ctx.stages.find((s) => s.key === c.stage);
  const f = (k: string) => form[k] ?? '';
  const setF = (k: string) => (e: { target: { value: string } }) => setForm((x) => ({ ...x, [k]: e.target.value }));
  const open = (d: DialogState, initial: Record<string, string> = {}) => { setForm(initial); setDialog(d); };
  const close = () => setDialog(null);
  const comp = c.compensation as Record<string, unknown>;
  const notice_ = c.notice as Record<string, unknown>;
  const prefs = c.preferences as Record<string, unknown>;
  const ins = c.insights as Record<string, unknown>;
  const links = c.links as Record<string, string | null> & { other?: { label: string; url: string }[] };
  const pendingFollowUps = profile.followUps.filter((x) => x.status === 'pending' || x.status === 'rescheduled');
  const manualActivities = profile.activities.filter((a) => ACTIVITY_TYPES.some(([k]) => k === a.kind));
  const g = (k: string) => c[k] as unknown;

  return (
    <div className="grid gap-6">
      {saved && !notice && <Alert tone="success">{saved}</Alert>}
      <NoticeBar notice={notice} />

      <Card>
        <CardBody className="flex flex-wrap items-start gap-5">
          <div className="relative">
            <Avatar name={c.name} size={72} src={c.hasPhoto ? `/crm-photos/${id}?v=${encodeURIComponent(c.updatedAt)}` : null} />
            {edit && (
              <>
                <button type="button" className="absolute -bottom-1 -right-1 rounded-full border border-border bg-surface p-1.5 text-fg-muted hover:text-fg" aria-label="Change photo" onClick={() => photoInput.current?.click()}><Camera className="size-3.5" /></button>
                <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Candidate photo" onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const fd = new FormData();
                  fd.set('file', file);
                  run(() => photoAction(id, fd));
                  e.target.value = '';
                }} />
              </>
            )}
          </div>
          <div className="grid min-w-60 flex-1 gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-fg-muted" data-testid="crm-candidate-code">{c.candidateCode}</span>
              <StageBadge label={c.stageLabel} kind={stage?.kind} />
              {c.archivedAt && <Badge tone="neutral">Archived</Badge>}
              {c.tags.map((t) => <Badge key={t} tone="accent">{t}</Badge>)}
            </div>
            <p className="text-[0.8125rem] text-fg-muted">
              {[c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details'}
            </p>
            <p className="text-[0.8125rem] text-fg-muted">
              Recruiter: <span className="text-fg">{c.recruiterName ?? 'Unassigned'}</span> · {c.hrWorkspaceName}
              {c.sharedWith.length > 0 && <> · shared with {c.sharedWith.map((s) => s.name).join(', ')}</>}
            </p>
            <p className="text-[0.8125rem] text-fg-muted">
              Next follow-up: <span className={c.nextFollowUpAt && new Date(c.nextFollowUpAt) < new Date() ? 'text-danger' : 'text-fg'}>{c.nextFollowUpAt ? `${when(c.nextFollowUpAt)} (${dueText(c.nextFollowUpAt)})` : 'None'}</span>
              {' · '}Last activity: <span className="text-fg">{when(c.lastActivityAt)}</span>
            </p>
          </div>
          {edit && (
            <div className="flex flex-wrap gap-2">
              <Link href={`/recruitment/crm/candidates/${id}/edit`} className={buttonClass('secondary', 'sm')}><Pencil className="size-3.5" /> Edit</Link>
              <Button size="sm" variant="secondary" onClick={() => open({ kind: 'activity' }, { type: 'call' })}><PhoneCall className="size-3.5" /> Log call or activity</Button>
              <Button size="sm" onClick={() => open({ kind: 'followUp' }, { type: 'general', priority: 'medium', dueAt: inHours(24), reminderMinutes: '15', assignedMembershipId: c.assignedRecruiterMembershipId ?? '' })}><CalendarPlus className="size-3.5" /> Schedule follow-up</Button>
            </div>
          )}
        </CardBody>
        {edit && (
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3 text-[0.8125rem]">
            <label className="flex items-center gap-2">Stage
              <Select aria-label="Change stage" className="w-52" value={c.stage} disabled={pending} onChange={(e) => open({ kind: 'stage', stage: e.target.value })}>
                {ctx.stages.filter((s) => s.active || s.key === c.stage).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-2">Recruiter
              <Select aria-label="Assign recruiter" className="w-52" value={c.assignedRecruiterMembershipId ?? ''} disabled={pending} onChange={(e) => run(() => assignAction(id, e.target.value || null))}>
                <option value="">Unassigned</option>
                {ctx.recruiters.map((r) => <option key={r.membershipId} value={r.membershipId}>{r.name}</option>)}
              </Select>
            </label>
            <span className="ml-auto flex flex-wrap gap-2">
              {c.hasPhoto && <Button data-delete-area="recruitment" data-delete="candidate photo" size="sm" variant="ghost" onClick={() => run(() => removePhotoAction(id))}>Remove photo</Button>}
              {can.share && <Button size="sm" variant="ghost" onClick={() => open({ kind: 'share' }, Object.fromEntries(c.sharedWith.map((s) => [`share:${s.id}`, 'yes'])))}><Share2 className="size-3.5" /> Share</Button>}
              {can.archive && <Button data-delete-area={c.archivedAt ? undefined : 'recruitment'} data-delete={c.archivedAt ? undefined : 'candidate (archive)'} size="sm" variant="ghost" onClick={() => run(() => archiveAction(id, !c.archivedAt))}><Archive className="size-3.5" /> {c.archivedAt ? 'Restore' : 'Archive'}</Button>}
              {can.archive && <Button data-delete-area="recruitment" size="sm" variant="ghost" onClick={() => open({ kind: 'erase' })}><Trash2 className="size-3.5" /> Erase personal details</Button>}
            </span>
          </div>
        )}
      </Card>

      <nav aria-label="Profile sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map(([key, label]) => {
          const count = key === 'remarks' ? profile.remarks.length : key === 'references' ? profile.references.length : key === 'activities' ? manualActivities.length
            : key === 'follow-ups' ? pendingFollowUps.length : key === 'documents' ? profile.documents.length : key === 'jobs' ? profile.applications.length : 0;
          return (
            <Link key={key} href={`?tab=${key}`} scroll={false} aria-current={tab === key ? 'page' : undefined}
              className={`whitespace-nowrap border-b-2 px-3 py-2 text-[0.8125rem] font-medium ${tab === key ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}>
              {label}{count > 0 && <span className="ml-1.5 text-xs text-fg-subtle">{count}</span>}
            </Link>
          );
        })}
      </nav>

      {tab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Personal details" />
            <CardBody><dl className="grid grid-cols-2 gap-4">
              <Detail label="Email" value={c.email} /><Detail label="Mobile" value={c.phone} /><Detail label="WhatsApp" value={g('whatsapp')} />
              <Detail label="Alternate email" value={g('alternateEmail')} /><Detail label="Alternate phone" value={g('alternatePhone')} />
              {!c.sensitiveHidden && <><Detail label="Gender" value={g('gender')} /><Detail label="Date of birth" value={g('dateOfBirth')} /><Detail label="Nationality" value={g('nationality')} /></>}
              <Detail label="Current location" value={g('currentLocation')} /><Detail label="City / State" value={[g('city'), g('state'), g('country')].filter(Boolean).join(', ')} />
              <Detail label="Address" value={g('address')} /><Detail label="Languages" value={g('languages')} />
              <Detail label="Preferred contact" value={g('contactMethod')} /><Detail label="Best time" value={g('contactTime')} />
            </dl></CardBody>
          </Card>
          <Card>
            <CardHeader title="Professional details" />
            <CardBody><dl className="grid grid-cols-2 gap-4">
              <Detail label="Profession" value={g('profession')} /><Detail label="Current title" value={g('currentTitle')} /><Detail label="Current company" value={g('currentCompany')} />
              <Detail label="Previous company" value={g('previousCompany')} /><Detail label="Industry" value={g('industry')} /><Detail label="Department" value={g('department')} />
              <Detail label="Job role" value={g('jobRole')} /><Detail label="Total experience" value={c.experienceText} /><Detail label="Relevant experience" value={c.relevantExperienceText} />
              <Detail label="Primary skills" value={g('primarySkills')} /><Detail label="Technical skills" value={g('technicalSkills')} /><Detail label="Certifications" value={g('certifications')} />
              <Detail label="Highest qualification" value={g('highestQualification')} /><Detail label="Institution" value={g('institution')} />
            </dl>{g('summary') ? <p className="mt-4 whitespace-pre-line text-[0.8125rem]">{String(g('summary'))}</p> : null}</CardBody>
          </Card>
          <Card>
            <CardHeader title="Compensation and notice" />
            <CardBody><dl className="grid grid-cols-2 gap-4">
              <Detail label="Currency and basis" value={`${comp.currency ?? 'INR'} · ${comp.basis ?? 'annual'}`} />
              <Detail label="Current CTC" value={money(comp.currentCtc, comp.currency)} /><Detail label="Expected CTC" value={money(comp.expectedCtc, comp.currency)} />
              <Detail label="Negotiable" value={comp.negotiable === true ? 'Yes' : comp.negotiable === false ? 'No' : null} /><Detail label="Minimum acceptable" value={money(comp.minimumAcceptable, comp.currency)} />
              <Detail label="Notice period" value={c.noticeText} /><Detail label="Serving notice" value={notice_.servingNotice === true ? 'Yes' : notice_.servingNotice === false ? 'No' : null} />
              <Detail label="Last working day" value={notice_.lastWorkingDay} /><Detail label="Available from" value={notice_.availableFrom} />
            </dl></CardBody>
          </Card>
          <Card>
            <CardHeader title="Job preferences and recruiter insights" />
            <CardBody><dl className="grid grid-cols-2 gap-4">
              <Detail label="Preferred roles" value={prefs.roles} /><Detail label="Preferred locations" value={prefs.locations} /><Detail label="Work mode" value={prefs.workMode} />
              <Detail label="Relocate" value={prefs.relocate === true ? 'Yes' : prefs.relocate === false ? 'No' : null} /><Detail label="Reason for change" value={prefs.changeReason} />
              <Detail label="Communication" value={ins.communication} /><Detail label="Professional assessment" value={ins.professional} /><Detail label="Interest level" value={ins.interest} />
              <Detail label="Reason for change (recruiter)" value={ins.reasonChange} /><Detail label="Observations" value={ins.observations} />
            </dl></CardBody>
          </Card>
          <Card>
            <CardHeader title="Professional links" />
            <CardBody className="grid gap-2 text-[0.8125rem]">
              {Object.entries(links).filter(([k, v]) => k !== 'other' && v).length === 0 && !(links.other ?? []).length && <p className="text-fg-muted">No links added.</p>}
              {Object.entries(links).filter(([k, v]) => k !== 'other' && typeof v === 'string' && v).map(([k, v]) => (
                <a key={k} href={v as string} target="_blank" rel="noopener noreferrer nofollow" className="truncate text-accent hover:underline"><span className="capitalize text-fg-muted">{k}: </span>{v as string}</a>
              ))}
              {(links.other ?? []).map((o) => <a key={o.url} href={o.url} target="_blank" rel="noopener noreferrer nofollow" className="truncate text-accent hover:underline">{o.label}: {o.url}</a>)}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Record" />
            <CardBody><dl className="grid grid-cols-2 gap-4">
              <Detail label="Source" value={ctx.sources.find((s) => s.key === c.source)?.label ?? c.source} /><Detail label="Source detail" value={g('sourceDetail')} />
              <Detail label="Stage since" value={when(c.stageEnteredAt)} /><Detail label="Belongs to" value={c.hrWorkspaceName} />
              <Detail label="Added" value={`${when(c.createdAt)}${c.createdByName ? ` by ${c.createdByName}` : ''}`} />
              <Detail label="Last updated" value={`${when(c.updatedAt)}${c.updatedByName ? ` by ${c.updatedByName}` : ''}`} />
            </dl></CardBody>
          </Card>
          {profile.customFields.length > 0 && (
            <Card className="lg:col-span-2">
              <CardHeader title="Additional details" />
              <CardBody><dl className="grid gap-4 sm:grid-cols-3">{profile.customFields.map((x) => <Detail key={x.key} label={x.label} value={x.text} />)}</dl></CardBody>
            </Card>
          )}
        </div>
      )}

      {tab === 'remarks' && (
        <Card>
          <CardHeader title="Recruiter remarks" description="Dated notes. A new remark never replaces an earlier one." />
          {edit && (
            <CardBody className="grid gap-3 border-b border-border">
              <div className="grid gap-3 sm:grid-cols-[16rem_1fr]">
                <Select aria-label="Remark category" value={remark.category} onChange={(e) => setRemark({ ...remark, category: e.target.value })}>
                  {REMARK_CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </Select>
                <Textarea aria-label="Remark" rows={3} placeholder="Write a remark" value={remark.body} onChange={(e) => setRemark({ ...remark, body: e.target.value })} />
              </div>
              <div className="flex flex-wrap items-center gap-4">
                {can.sensitive && <Checkbox label="Restricted (only people who may see private details)" checked={remark.restricted} onChange={(e) => setRemark({ ...remark, restricted: e.target.checked })} />}
                <Button size="sm" disabled={!remark.body.trim() || pending} onClick={() => run(() => remarkAction(id, remark), () => setRemark({ body: '', category: remark.category, restricted: false }))}>Add remark</Button>
              </div>
            </CardBody>
          )}
          {profile.remarks.length === 0 ? <EmptyState title="No remarks yet" /> : (
            <ul className="divide-y divide-border">
              {profile.remarks.map((r) => (
                <li key={r.id} className="grid gap-1 px-5 py-3 text-[0.8125rem]">
                  <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <Badge tone="neutral">{r.categoryLabel}</Badge>{r.restricted && <Badge tone="warning">Restricted</Badge>}
                    {r.author ?? 'Someone'}{r.authorLevel ? ` · ${r.authorLevel === 'super' ? 'Super Workspace' : r.authorHrWorkspace ?? 'HR Workspace'}` : ''} · {when(r.createdAt)}
                  </span>
                  <p className="whitespace-pre-line">{r.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'references' && (
        <Card>
          <CardHeader title="References" description="Who referred the candidate, or where the reference came from." action={edit && <Button size="sm" variant="secondary" onClick={() => open({ kind: 'reference' }, { type: 'employee_referral' })}><Plus className="size-3.5" /> Add reference</Button>} />
          {profile.references.length === 0 ? <EmptyState title="No references yet" /> : (
            <ul className="divide-y divide-border">
              {profile.references.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 text-[0.8125rem]">
                  <span>
                    <span className="font-medium">{r.typeLabel}</span>{r.name && <> · {r.name}</>}
                    <span className="block text-xs text-fg-muted">{[r.relationship && crmLabel(REFERENCE_RELATIONSHIPS, r.relationship), r.company, r.phone, r.email].filter(Boolean).join(' · ')}</span>
                    {r.details && <span className="block text-xs">{r.details}</span>}
                    <span className="block text-xs text-fg-subtle">Added {when(r.createdAt)}{r.createdBy ? ` by ${r.createdBy}` : ''}</span>
                  </span>
                  {edit && <Button data-delete-area="recruitment" data-delete="reference" size="sm" variant="ghost" onClick={() => run(() => removeReferenceAction(id, r.id))}>Remove</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'activities' && (
        <Card>
          <CardHeader title="Activity history" description="Calls, emails, messages and meetings logged by recruiters." action={edit && <Button size="sm" variant="secondary" onClick={() => open({ kind: 'activity' }, { type: 'call' })}><PhoneCall className="size-3.5" /> Log activity</Button>} />
          {manualActivities.length === 0 ? <EmptyState title="No activities logged yet" description="Log a call after speaking to the candidate, with its outcome." /> : (
            <ul className="divide-y divide-border">
              {manualActivities.map((a) => (
                <li key={a.id} className="grid gap-1 px-5 py-3 text-[0.8125rem]">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{crmLabel(ACTIVITY_TYPES, a.kind)}</Badge>
                    {a.outcome && <Badge tone={['connected', 'interested', 'completed', 'passed'].includes(a.outcome) ? 'success' : 'neutral'}>{crmLabel(a.kind === 'interview' ? INTERVIEW_OUTCOMES : CALL_OUTCOMES, a.outcome)}</Badge>}
                    {a.subject && <span className="font-medium">{a.subject}</span>}
                    {a.durationMinutes ? <span className="text-xs text-fg-muted">{a.durationMinutes} min</span> : null}
                  </span>
                  {a.remarks && <p className="whitespace-pre-line">{a.remarks}</p>}
                  <span className="text-xs text-fg-subtle">{a.by ?? 'Someone'} · {when(a.occurredAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'follow-ups' && (
        <Card>
          <CardHeader title="Follow-ups" description="Scheduled calls and tasks for this candidate. Reminders go to the assigned person’s notifications." action={edit && <Button size="sm" onClick={() => open({ kind: 'followUp' }, { type: 'general', priority: 'medium', dueAt: inHours(24), reminderMinutes: '15', assignedMembershipId: c.assignedRecruiterMembershipId ?? '' })}><CalendarPlus className="size-3.5" /> Schedule</Button>} />
          {profile.followUps.length === 0 ? <EmptyState title="No follow-ups yet" /> : (
            <ul className="divide-y divide-border">
              {profile.followUps.map((x) => {
                const live = x.status === 'pending' || x.status === 'rescheduled';
                return (
                  <li key={x.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 text-[0.8125rem]" data-testid="crm-follow-up">
                    <span className="grid gap-1">
                      <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{x.typeLabel}</span><FollowUpBadge status={x.status} overdue={x.overdue} /><PriorityBadge priority={x.priority} /></span>
                      <span className="text-xs text-fg-muted">Due {when(x.dueAt)} · {x.assignedTo ?? 'Unassigned'}{x.reminderMinutes !== null ? ` · reminder ${x.reminderMinutes ? `${x.reminderMinutes} min before` : 'at the time'}` : ''}</span>
                      {x.reason && <span>{x.reason}</span>}
                      {x.notes && <span className="text-xs">{x.notes}</span>}
                      {x.outcome && <span className="text-xs">Outcome: {x.outcome}</span>}
                      {x.completedAt && <span className="text-xs text-fg-subtle">Closed {when(x.completedAt)}{x.completedBy ? ` by ${x.completedBy}` : ''}</span>}
                    </span>
                    {edit && live && (
                      <span className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => open({ kind: 'close', followUp: x, status: 'completed' })}>Complete</Button>
                        <Button size="sm" variant="ghost" onClick={() => open({ kind: 'close', followUp: x, status: 'rescheduled' }, { dueAt: localInput(new Date(new Date(x.dueAt).getTime() + 86400000)) })}>Reschedule</Button>
                        <Button size="sm" variant="ghost" onClick={() => open({ kind: 'close', followUp: x, status: 'missed' })}>Missed</Button>
                        <Button size="sm" variant="ghost" onClick={() => open({ kind: 'close', followUp: x, status: 'cancelled' })}>Cancel</Button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {tab === 'documents' && (
        <Card>
          <CardHeader title="Documents" description="Resume and supporting documents. PDF, Word, images or text up to 10 MB; each new upload of the same document keeps the earlier versions." action={edit && <Button size="sm" variant="secondary" onClick={() => open({ kind: 'document' }, { kind: 'resume' })}><Upload className="size-3.5" /> Upload document</Button>} />
          {profile.documents.length === 0 ? <EmptyState icon={<FileText className="size-5" />} title="No documents yet" /> : (
            <ul className="divide-y divide-border">
              {profile.documents.map((d) => (
                <li key={d.id} className="grid gap-2 px-5 py-3 text-[0.8125rem]">
                  <span className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      <span className="font-medium">{d.name}</span> <Badge tone="neutral">{d.kindLabel ?? d.kind}</Badge> <span className="text-xs text-fg-muted">v{d.version}</span>
                      <span className="block text-xs text-fg-muted">{d.fileName} · {size(d.sizeBytes)} · {d.uploadedBy ?? 'Someone'} · {when(d.uploadedAt)}</span>
                      {d.notes && <span className="block text-xs">{d.notes}</span>}
                    </span>
                    <span className="flex flex-wrap gap-2">
                      {d.previewable && <a className={buttonClass('ghost', 'sm')} href={`/crm-files/${d.id}?inline=1`} target="_blank" rel="noopener"><Eye className="size-3.5" /> View</a>}
                      <a className={buttonClass('ghost', 'sm')} href={`/crm-files/${d.id}`} download><Download className="size-3.5" /> Download</a>
                      {edit && <Button size="sm" variant="ghost" onClick={() => open({ kind: 'replace', doc: d })}>New version</Button>}
                      {can.archive && <Button data-delete-area="recruitment" data-delete="candidate document" size="sm" variant="ghost" onClick={() => run(() => deleteDocumentAction(id, d.id))}>Delete</Button>}
                    </span>
                  </span>
                  {(d.versions ?? []).length > 1 && (
                    <details className="text-xs text-fg-muted">
                      <summary className="cursor-pointer">Earlier versions</summary>
                      <ul className="mt-1 grid gap-1">
                        {(d.versions ?? []).filter((x) => x.id !== d.id).map((x) => <li key={x.id}>v{x.version} · {x.fileName} · {when(x.uploadedAt)} · <a className="text-accent hover:underline" href={`/crm-files/${x.id}`} download>Download</a></li>)}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'jobs' && (
        <Card>
          <CardHeader title="Jobs" description="Job requisitions the candidate is put forward for in Recruitment & ATS, with interviews and offers." action={profile.applications.length > 0 && <Link href={`/recruitment/candidates/${id}`} className="text-sm font-medium text-accent hover:underline">Open in ATS</Link>} />
          {profile.applications.length === 0 ? <EmptyState title="Not in a job yet" description="Put the candidate forward for a job from the ATS candidate page or the job’s pipeline." action={<Link href={`/recruitment/candidates/${id}`} className={buttonClass('secondary', 'sm')}>Open in ATS</Link>} /> : (
            <ul className="divide-y divide-border">
              {profile.applications.map((a) => (
                <li key={a.id} className="grid gap-1 px-5 py-3 text-[0.8125rem]">
                  <span><Link className="font-medium text-accent hover:underline" href={`/recruitment/jobs/${a.requisitionId}`}>{a.requisitionCode} · {a.requisitionTitle}</Link> <Badge tone="neutral">{a.status === 'active' ? a.stage ?? 'In process' : a.status}</Badge>{a.offerStatus && <Badge tone="info" className="ml-1">Offer {a.offerStatus}</Badge>}</span>
                  <span className="text-xs text-fg-muted">Applied {day(a.appliedAt)}</span>
                  {a.interviews.map((i) => <span key={i.id} className="text-xs">Interview: {i.title} · {when(i.startsAt)} · {i.mode} · {i.status}</span>)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'timeline' && (
        <Card>
          <CardHeader title="Timeline" description="Everything that happened to this candidate, newest first." />
          {profile.activities.length === 0 ? <EmptyState title="Nothing yet" /> : (
            <ol className="grid gap-0 px-5 py-4" data-testid="crm-timeline">
              {profile.activities.map((a) => (
                <li key={a.id} className="relative border-l border-border pb-4 pl-5 text-[0.8125rem] last:pb-0">
                  <span className={`absolute -left-[5px] top-1.5 size-2.5 rounded-full ${a.automatic ? 'bg-fg-subtle' : 'bg-accent'}`} />
                  <span className="block">{a.text}</span>
                  <span className="text-xs text-fg-subtle">{a.by ?? 'SampCrew'} · {when(a.occurredAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {/* Dialogs ------------------------------------------------------------------------------------------- */}

      <Dialog open={dialog?.kind === 'stage'} onClose={close} title="Change stage" description={dialog?.kind === 'stage' ? `Move to ${ctx.stages.find((s) => s.key === dialog.stage)?.label}.` : undefined}
        footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button loading={pending} onClick={() => dialog?.kind === 'stage' && run(() => stageAction(id, dialog.stage, f('note')), close)}>Move</Button></>}>
        <Field label="Note" hint="Optional: why the stage changed">{(p) => <Textarea {...p} rows={3} value={f('note')} onChange={setF('note')} />}</Field>
      </Dialog>

      <Dialog open={dialog?.kind === 'activity'} onClose={close} title="Log activity" description="Record a call, email, message or meeting, and schedule the next follow-up in the same step." size="lg"
        footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button loading={pending} onClick={() => run(() => logActivityAction(id, {
          type: f('type'), occurredAt: toIso(f('occurredAt')) ?? undefined, outcome: f('outcome') || null, subject: f('subject') || null, remarks: f('remarks') || null,
          durationMinutes: f('duration') ? Number(f('duration')) : null, nextFollowUpAt: toIso(f('next')), nextFollowUpType: f('nextType') || null,
        }), close)}>Save</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">{(p) => <Select {...p} value={f('type')} onChange={setF('type')}>{ACTIVITY_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          <Field label="When" hint="Leave empty for now">{(p) => <Input {...p} type="datetime-local" value={f('occurredAt')} max={localInput(new Date())} onChange={setF('occurredAt')} />}</Field>
          <Field label="Outcome" required={f('type') === 'call'}>{(p) => <Select {...p} value={f('outcome')} onChange={setF('outcome')}><option value="">Choose…</option>{(f('type') === 'interview' ? INTERVIEW_OUTCOMES : CALL_OUTCOMES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          <Field label="Duration (minutes)">{(p) => <Input {...p} inputMode="numeric" value={f('duration')} onChange={setF('duration')} />}</Field>
          <Field label="Subject" className="sm:col-span-2">{(p) => <Input {...p} value={f('subject')} onChange={setF('subject')} />}</Field>
          <Field label="Remarks" className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={f('remarks')} onChange={setF('remarks')} />}</Field>
          <Field label="Next follow-up" hint="Optional">{(p) => <Input {...p} type="datetime-local" value={f('next')} onChange={setF('next')} />}</Field>
          <Field label="Follow-up type">{(p) => <Select {...p} value={f('nextType')} onChange={setF('nextType')}><option value="">General follow-up</option>{FOLLOW_UP_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        </div>
      </Dialog>

      <Dialog open={dialog?.kind === 'followUp'} onClose={close} title="Schedule follow-up" size="lg"
        footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button loading={pending} onClick={() => run(() => addFollowUpAction(id, {
          type: f('type'), dueAt: toIso(f('dueAt')), priority: f('priority'), reason: f('reason') || null, notes: f('notes') || null,
          reminderMinutes: f('reminderMinutes') === '' ? null : Number(f('reminderMinutes')), assignedMembershipId: f('assignedMembershipId') || undefined,
        }), close)}>Schedule</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Follow-up type">{(p) => <Select {...p} value={f('type')} onChange={setF('type')}>{FOLLOW_UP_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          <Field label="Due" required>{(p) => <Input {...p} type="datetime-local" value={f('dueAt')} onChange={setF('dueAt')} />}</Field>
          <Field label="Priority">{(p) => <Select {...p} value={f('priority')} onChange={setF('priority')}>{FOLLOW_UP_PRIORITIES.map((k) => <option key={k} value={k}>{k[0]!.toUpperCase() + k.slice(1)}</option>)}</Select>}</Field>
          <Field label="Reminder">{(p) => <Select {...p} value={f('reminderMinutes')} onChange={setF('reminderMinutes')}><option value="">No reminder</option>{REMINDER_OPTIONS.map((m) => <option key={m} value={String(m)}>{m === 0 ? 'At the time' : m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'} before` : `${m} minutes before`}</option>)}</Select>}</Field>
          <Field label="Assigned to" className="sm:col-span-2">{(p) => <Select {...p} value={f('assignedMembershipId')} onChange={setF('assignedMembershipId')}><option value="">Me</option>{ctx.recruiters.map((r) => <option key={r.membershipId} value={r.membershipId}>{r.name}</option>)}</Select>}</Field>
          <Field label="Reason" className="sm:col-span-2">{(p) => <Input {...p} value={f('reason')} onChange={setF('reason')} placeholder="Discuss salary expectations" />}</Field>
          <Field label="Notes" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={f('notes')} onChange={setF('notes')} />}</Field>
        </div>
      </Dialog>

      <Dialog open={dialog?.kind === 'close'} onClose={close} title={dialog?.kind === 'close' ? ({ completed: 'Complete follow-up', rescheduled: 'Reschedule follow-up', missed: 'Mark as missed', cancelled: 'Cancel follow-up' } as const)[dialog.status] : ''}
        footer={<><Button variant="ghost" onClick={close}>Back</Button><Button loading={pending} onClick={() => dialog?.kind === 'close' && run(() => updateFollowUpAction(id, dialog.followUp.id, {
          status: dialog.status, outcome: f('outcome') || null, ...(dialog.status === 'rescheduled' ? { dueAt: toIso(f('dueAt')) } : {}),
        }), close)}>Save</Button></>}>
        <div className="grid gap-4">
          {dialog?.kind === 'close' && dialog.status === 'rescheduled' && <Field label="New time" required>{(p) => <Input {...p} type="datetime-local" value={f('dueAt')} onChange={setF('dueAt')} />}</Field>}
          <Field label="Outcome or note">{(p) => <Textarea {...p} rows={3} value={f('outcome')} onChange={setF('outcome')} />}</Field>
        </div>
      </Dialog>

      <Dialog open={dialog?.kind === 'reference'} onClose={close} title="Add reference" size="lg"
        footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button loading={pending} onClick={() => run(() => addReferenceAction(id, {
          type: f('type'), name: f('name') || null, phone: f('phone') || null, email: f('email') || null, company: f('company') || null, relationship: f('relationship') || null, details: f('details') || null,
        }), close)}>Add</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reference type">{(p) => <Select {...p} value={f('type')} onChange={setF('type')}>{REFERENCE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          <Field label="Reference name">{(p) => <Input {...p} value={f('name')} onChange={setF('name')} />}</Field>
          <Field label="Reference phone">{(p) => <Input {...p} type="tel" value={f('phone')} onChange={setF('phone')} />}</Field>
          <Field label="Reference email">{(p) => <Input {...p} type="email" value={f('email')} onChange={setF('email')} />}</Field>
          <Field label="Reference company">{(p) => <Input {...p} value={f('company')} onChange={setF('company')} />}</Field>
          <Field label="Relationship">{(p) => <Select {...p} value={f('relationship')} onChange={setF('relationship')}><option value="">Choose…</option>{REFERENCE_RELATIONSHIPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          <Field label="Reference details" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={f('details')} onChange={setF('details')} />}</Field>
        </div>
      </Dialog>

      <DocumentDialog open={dialog?.kind === 'document' || dialog?.kind === 'replace'} replace={dialog?.kind === 'replace' ? dialog.doc : null} onClose={close} pending={pending}
        onSubmit={(fd) => run(() => (dialog?.kind === 'replace' ? replaceDocumentAction(id, dialog.doc.id, fd) : uploadDocumentAction(id, fd)), close)} />

      <Dialog open={dialog?.kind === 'share'} onClose={close} title="Share with HR Workspaces" description="HR Workspaces you share with can see and work on this candidate. The owner stays the same."
        footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button loading={pending} onClick={() => run(() => shareAction(id, Object.entries(form).filter(([k, v]) => k.startsWith('share:') && v === 'yes').map(([k]) => k.slice(6))), close)}>Save sharing</Button></>}>
        <div className="grid gap-2">
          {ctx.hrWorkspaces.filter((w) => w.id !== c.hrWorkspaceId).map((w) => (
            <Checkbox key={w.id} label={w.name} checked={form[`share:${w.id}`] === 'yes'} onChange={(e) => setForm({ ...form, [`share:${w.id}`]: e.target.checked ? 'yes' : '' })} />
          ))}
          {ctx.hrWorkspaces.length === 0 && <p className="text-[0.8125rem] text-fg-muted">There are no HR Workspaces yet.</p>}
        </div>
      </Dialog>

      <Dialog open={dialog?.kind === 'erase'} onClose={close} title="Erase personal details" description="Use this when the candidate asks to be forgotten. Their name, contact details, documents, remarks and references are erased for good; the anonymous history stays for reporting."
        footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button data-delete-area="recruitment" data-delete="candidate's personal details" variant="danger" loading={pending} disabled={f('reason').trim().length < 3} onClick={() => run(() => eraseAction(id, f('reason').trim()), close)}>Erase for good</Button></>}>
        <Field label="Reason" required>{(p) => <Input {...p} value={f('reason')} onChange={setF('reason')} placeholder="Candidate asked to be removed" />}</Field>
      </Dialog>
    </div>
  );
}

function DocumentDialog({ open, replace, onClose, onSubmit, pending }: { open: boolean; replace: CrmDocument | null; onClose: () => void; onSubmit: (fd: FormData) => void; pending: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <Dialog open={open} onClose={onClose} title={replace ? `New version of ${replace.name}` : 'Upload document'} description="PDF, Word (DOCX or DOC), JPG, PNG, WebP or text, up to 10 MB."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => formRef.current && onSubmit(new FormData(formRef.current))}>Upload</Button></>}>
      <form ref={formRef} className="grid gap-4" onSubmit={(e) => { e.preventDefault(); onSubmit(new FormData(e.currentTarget)); }}>
        <Field label="File" required>{(p) => <Input {...p} type="file" name="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.txt" />}</Field>
        {!replace && (
          <>
            <Field label="Document type">{(p) => <Select {...p} name="kind" defaultValue="resume">{DOCUMENT_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
            <Field label="Name" hint="Optional; the file name is used if empty">{(p) => <Input {...p} name="name" />}</Field>
          </>
        )}
        <Field label="Notes">{(p) => <Input {...p} name="notes" />}</Field>
      </form>
    </Dialog>
  );
}
