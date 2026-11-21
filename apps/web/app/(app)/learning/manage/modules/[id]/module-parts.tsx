'use client';
import { EMPTY_LEARNING_AUDIENCE, type LearningAudience } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DatePicker, Dialog, Field, Input, Table, TBody, TD, TH, THead, TR, Textarea, buttonClass, cn } from '@crew/ui';
import { Archive, Download, RotateCcw, Send, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useRunner } from '../../../../recruitment/use-runner';
import { archiveModuleAction, assignModuleAction, cancelEnrolmentAction, publishModuleAction, stopAudienceAction, unscheduleModuleAction } from '../../../actions';
import { dateLabel, DueLabel, LearnerStatusBadge, ProgressBar, scoreLabel } from '../../../labels';
import type { EnrolmentRow, LearningAccessView, LearningOptions, ModuleDetail, Tally } from '../../../types';

export function ModuleActions({ module: m }: { module: ModuleDetail }) {
  const { pending, notice, run } = useRunner();
  const [publishOpen, setPublishOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  if (!m.can.publish) return notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null;
  const canPublish = m.status === 'draft' || m.status === 'scheduled' || (m.status === 'published' && m.unpublishedChanges);
  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex flex-wrap gap-2">
        {canPublish && <Button size="sm" onClick={() => setPublishOpen(true)} data-testid="publish-module"><Send className="size-4" aria-hidden />{m.status === 'published' ? 'Publish changes' : 'Publish'}</Button>}
        {m.status === 'scheduled' && <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => unscheduleModuleAction(m.id))}>Back to draft</Button>}
        {m.status !== 'archived' ? <Button size="sm" variant="ghost" onClick={() => setArchiveOpen(true)}><Archive className="size-4" aria-hidden />Archive</Button>
          : <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => archiveModuleAction(m.id, true))}><RotateCcw className="size-4" aria-hidden />Restore</Button>}
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Dialog open={publishOpen} onClose={() => setPublishOpen(false)} title={m.status === 'published' ? 'Publish the changes' : 'Publish the module'}
        description={m.status === 'published' ? 'This becomes the next version. People who finished an earlier version keep their record; people still learning keep the version they started.' : 'Published modules can be assigned, and appear in the library if they are open for enrolling.'}
        footer={<>
          <Button variant="secondary" onClick={() => setPublishOpen(false)}>Cancel</Button>
          <Button loading={pending} disabled={when === 'later' && !at} data-testid="confirm-publish" onClick={() => run(() => publishModuleAction(m.id, when === 'later' && at ? new Date(at).toISOString() : null, note), () => setPublishOpen(false))}>
            {when === 'later' ? 'Schedule' : 'Publish now'}
          </Button>
        </>}>
        <div className="grid gap-4">
          {m.status !== 'published' && (
            <div className="flex gap-4 text-[0.8125rem]" role="radiogroup" aria-label="When">
              <label className="flex items-center gap-2"><input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} />Now</label>
              <label className="flex items-center gap-2"><input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} />At a later time</label>
            </div>
          )}
          {when === 'later' && <Field label="Publish at">{(p) => <Input {...p} type="datetime-local" value={at} min={new Date().toISOString().slice(0, 16)} onChange={(e) => setAt(e.target.value)} />}</Field>}
          <Field label="What changed" hint="Kept with the version">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={m.version ? 'For example, updated the fire exit video' : 'First version'} />}</Field>
        </div>
      </Dialog>
      <Dialog open={archiveOpen} onClose={() => setArchiveOpen(false)} title="Archive this module?" description="Nobody new can be enrolled. People keep their records and can finish what they started. You can restore it later."
        footer={<><Button variant="secondary" onClick={() => setArchiveOpen(false)}>Cancel</Button><Button variant="danger" loading={pending} onClick={() => run(() => archiveModuleAction(m.id, false), () => setArchiveOpen(false))}>Archive</Button></>}>
        <p className="text-[0.8125rem] text-fg-muted">{m.assigned} enrolment{m.assigned === 1 ? '' : 's'} stay on record.</p>
      </Dialog>
    </div>
  );
}

function Chips({ label, all, chosen, onToggle, testId }: { label: string; all: { id: string; name: string }[]; chosen: string[]; onToggle: (id: string) => void; testId: string }) {
  const [q, setQ] = useState('');
  if (!all.length) return null;
  const shown = all.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  return (
    <fieldset className="grid gap-1.5" data-testid={testId}>
      <legend className="mb-1 flex w-full items-center justify-between text-xs font-medium">{label}{all.length > 10 && <Input aria-label={`Find ${label.toLowerCase()}`} placeholder="Find" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 max-w-32 text-xs" />}</legend>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((x) => (
          <button key={x.id} type="button" aria-pressed={chosen.includes(x.id)} onClick={() => onToggle(x.id)}
            className={cn('rounded-full border px-2.5 py-1 text-xs', chosen.includes(x.id) ? 'border-accent bg-accent text-accent-fg' : 'border-border text-fg-muted hover:text-fg')}>
            {x.name}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

const EMPLOYMENT = [{ id: 'full_time', name: 'Full time' }, { id: 'part_time', name: 'Part time' }, { id: 'contract', name: 'Contract' }, { id: 'intern', name: 'Intern' }, { id: 'temporary', name: 'Temporary' }];

export function AssignPanel({ module: m, options, access }: { module: ModuleDetail; options: LearningOptions; access: LearningAccessView }) {
  const { pending, notice, run } = useRunner();
  const [a, setA] = useState<LearningAudience>(EMPTY_LEARNING_AUDIENCE);
  const [due, setDue] = useState('');
  const [keep, setKeep] = useState(false);
  const [q, setQ] = useState('');
  const toggle = (key: 'hrWorkspaceIds' | 'departmentIds' | 'designationIds' | 'locationIds' | 'employeeIds', id: string) => setA({ ...a, [key]: a[key].includes(id) ? a[key].filter((x) => x !== id) : [...a[key], id] });
  const people = q.trim().length >= 2 ? options.people.filter((p) => `${p.name} ${p.code}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 10) : [];
  const names = new Map(options.people.map((p) => [p.id, p.name]));
  const empty = !a.all && !a.central && !a.employeeIds.length && !a.hrWorkspaceIds.length && !a.departmentIds.length && !a.designationIds.length && !a.locationIds.length && !a.employmentTypes.length;
  const reach = a.all ? options.people.length : new Set([
    ...options.people.filter((p) => a.employeeIds.includes(p.id) || (p.hrWorkspaceId && a.hrWorkspaceIds.includes(p.hrWorkspaceId)) || (a.central && !p.hrWorkspaceId)).map((p) => p.id),
  ]).size;
  if (m.status !== 'published') return <Alert tone="info">Publish the module before assigning it.</Alert>;
  if (!access.caps.assign) return <Alert tone="warning">Your Super Workspace has not let your HR Workspace assign learning.</Alert>;
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Assign this module" description="Choose who should take it. Anyone in any of the chosen groups is enrolled and told. People who already have it open, or finished this version, are skipped." />
        <CardBody className="grid gap-4">
          {options.canAssignCentral && <Checkbox label={access.level === 'super' ? 'All employees' : 'Everyone you look after'} checked={a.all} onChange={(e) => setA({ ...a, all: e.target.checked })} data-testid="audience-all" />}
          {!a.all && (
            <>
              <Chips label="HR Workspaces" all={options.hrWorkspaces} chosen={a.hrWorkspaceIds} onToggle={(id) => toggle('hrWorkspaceIds', id)} testId="audience-hr-workspaces" />
              {options.canAssignCentral && <Checkbox label="Central group" description="People not in any HR Workspace" checked={a.central} onChange={(e) => setA({ ...a, central: e.target.checked })} />}
              <Chips label="Departments" all={options.departments} chosen={a.departmentIds} onToggle={(id) => toggle('departmentIds', id)} testId="audience-departments" />
              <Chips label="Job roles" all={options.designations} chosen={a.designationIds} onToggle={(id) => toggle('designationIds', id)} testId="audience-designations" />
              <Chips label="Locations" all={options.locations} chosen={a.locationIds} onToggle={(id) => toggle('locationIds', id)} testId="audience-locations" />
              <Chips label="Employment types" all={EMPLOYMENT} chosen={a.employmentTypes} onToggle={(id) => setA({ ...a, employmentTypes: a.employmentTypes.includes(id as never) ? a.employmentTypes.filter((x) => x !== id) : [...a.employmentTypes, id as LearningAudience['employmentTypes'][number]] })} testId="audience-employment" />
              <div className="grid gap-1.5">
                <span className="text-xs font-medium">Specific people</span>
                <div className="flex flex-wrap gap-1.5">{a.employeeIds.map((id) => <Badge key={id}>{names.get(id) ?? 'Employee'}<button type="button" aria-label={`Remove ${names.get(id) ?? 'person'}`} onClick={() => toggle('employeeIds', id)}><X className="size-3" /></button></Badge>)}</div>
                <Input aria-label="Find people" placeholder="Type a name or employee ID" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" data-testid="audience-people" />
                {people.length > 0 && (
                  <ul className="grid max-w-sm gap-0.5 rounded-lg border border-border p-1">
                    {people.map((p) => <li key={p.id}><button type="button" className="w-full rounded-md px-2 py-1 text-left text-[0.8125rem] hover:bg-bg-subtle" onClick={() => { if (!a.employeeIds.includes(p.id)) toggle('employeeIds', p.id); setQ(''); }}>{p.name} <span className="text-xs text-fg-subtle">{p.code}</span></button></li>)}
                  </ul>
                )}
              </div>
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Due date" hint={m.defaultDueDays ? `Empty: due ${m.defaultDueDays} days after enrolling` : 'Optional'}>{(p) => <DatePicker id={p.id} value={due} min={new Date().toISOString().slice(0, 10)} onChange={setDue} calendarLabel="Choose the due date" />}</Field>
            <div className="pt-6"><Checkbox label="Keep enrolling new people" description="New joiners and transfers who match are enrolled automatically" checked={keep} onChange={(e) => setKeep(e.target.checked)} /></div>
          </div>
          {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
          <div className="flex flex-wrap items-center gap-3">
            <Button loading={pending} disabled={empty} data-testid="assign-module" onClick={() => run(() => assignModuleAction(m.id, a, due || null, keep), () => { setA(EMPTY_LEARNING_AUDIENCE); setDue(''); setKeep(false); })}>Assign</Button>
            {!empty && (a.all || !a.departmentIds.length && !a.designationIds.length && !a.locationIds.length && !a.employmentTypes.length) && <span className="text-xs text-fg-muted">Reaches about {reach} {reach === 1 ? 'person' : 'people'}</span>}
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Assigned to" />
        {m.audiences.length ? (
          <Table aria-label="Assignments">
            <THead><TR><TH>Audience</TH><TH>Due</TH><TH className="text-right">Enrolled</TH><TH>New people</TH><TH>Assigned</TH><TH /></TR></THead>
            <TBody>
              {m.audiences.map((x) => (
                <TR key={x.id}>
                  <TD className="font-medium">{x.description}</TD>
                  <TD className="text-fg-muted">{x.dueOn ? dateLabel(x.dueOn) : '—'}</TD>
                  <TD className="text-right tabular-nums">{x.enrolled}</TD>
                  <TD>{x.keepEnrolling && x.active ? <Badge tone="info">Enrolled automatically</Badge> : <span className="text-xs text-fg-subtle">Not added</span>}</TD>
                  <TD className="text-fg-muted">{dateLabel(x.createdAt)}</TD>
                  <TD className="text-right">{x.keepEnrolling && x.active && <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => stopAudienceAction(m.id, x.id))}>Stop adding</Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <p className="px-5 pb-5 text-[0.8125rem] text-fg-muted">Not assigned yet.</p>}
      </Card>
    </div>
  );
}

export function LearnersTable({ module: m, data, canAssign }: { module: ModuleDetail; data: { rows: EnrolmentRow[]; total: number; summary: Tally; canExport: boolean }; canAssign: boolean }) {
  const { pending, notice, run } = useRunner();
  const [remove, setRemove] = useState<EnrolmentRow | null>(null);
  const [reason, setReason] = useState('');
  const [filter, setFilter] = useState('');
  const rows = data.rows.filter((r) => !filter || r.status === filter);
  const s = data.summary;
  return (
    <Card>
      <CardHeader title={`${data.total} learner${data.total === 1 ? '' : 's'}`} description={`${s.completed} completed · ${s.inProgress} in progress · ${s.notStarted} not started · ${s.overdue} overdue${s.averageScore !== null ? ` · average score ${s.averageScore}%` : ''}`}
        action={data.canExport ? <a className={buttonClass('secondary', 'sm')} href={`/learning-export?moduleId=${m.id}`}><Download className="size-4" aria-hidden />Export to Excel</a> : undefined} />
      <div className="flex flex-wrap gap-1.5 px-5 pb-3">
        {[['', 'All'], ['not_started', 'Not started'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['overdue', 'Overdue']].map(([v, l]) => (
          <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v!)} className={cn('rounded-full border px-2.5 py-1 text-xs', filter === v ? 'border-accent bg-accent text-accent-fg' : 'border-border text-fg-muted')}>{l}</button>
        ))}
      </div>
      {notice && <div className="px-5 pb-3"><Alert tone={notice.tone}>{notice.text}</Alert></div>}
      {rows.length ? (
        <Table aria-label="Learners">
          <THead><TR><TH>Employee</TH><TH>HR Workspace</TH><TH>Status</TH><TH className="w-40">Progress</TH><TH className="text-right">Score</TH><TH>Deadline</TH><TH /></TR></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id} data-testid="learner-row">
                <TD><Link href={`/learning/manage/learners/${r.employeeId}`} className="font-medium hover:underline">{r.employeeName}</Link><span className="block text-xs text-fg-muted">{r.employeeCode}{r.department ? ` · ${r.department}` : ''}</span></TD>
                <TD className="text-fg-muted">{r.hrWorkspace ?? 'Central group'}</TD>
                <TD><LearnerStatusBadge status={r.status} />{r.version !== m.version && <span className="block text-xs text-fg-subtle">Version {r.version}</span>}</TD>
                <TD><ProgressBar value={r.progressPercent} label={`${r.employeeName} progress`} /></TD>
                <TD className="text-right tabular-nums">{scoreLabel(r.scorePercent) || '—'}</TD>
                <TD className="text-xs">{r.status === 'completed' ? <span className="text-fg-muted">Completed {dateLabel(r.completedOn)}</span> : <DueLabel dueOn={r.dueOn} due={r.due} />}</TD>
                <TD className="whitespace-nowrap text-right">
                  <Link href={`/learning/manage/enrolments/${r.id}`} className={buttonClass('ghost', 'sm')}>Details</Link>
                  {canAssign && r.status !== 'completed' && <Button size="sm" variant="ghost" onClick={() => { setRemove(r); setReason(''); }}>Remove</Button>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <p className="px-5 pb-5 text-[0.8125rem] text-fg-muted">Nobody here.</p>}
      <Dialog open={!!remove} onClose={() => setRemove(null)} title={`Remove ${remove?.employeeName ?? ''} from this module?`} description="Their progress stays on record. They no longer see it as something to do."
        footer={<><Button variant="secondary" onClick={() => setRemove(null)}>Cancel</Button><Button variant="danger" loading={pending} disabled={reason.trim().length < 3} onClick={() => remove && run(() => cancelEnrolmentAction(remove.id, reason.trim(), m.id), () => setRemove(null))}>Remove</Button></>}>
        <Field label="Reason">{(p) => <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </Dialog>
    </Card>
  );
}
