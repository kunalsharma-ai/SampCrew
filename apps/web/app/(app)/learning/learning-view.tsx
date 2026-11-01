'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ExternalLink, GraduationCap, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useRunner } from '../recruitment/use-runner';
import { assignAction, assignmentStepAction, enrolAction } from '../talent/actions';
import { ASSIGNMENT_STATUS, ASSIGNMENT_TONE, FORMAT, minutes } from '../talent/labels';
import type { Assignment, Course, LearningPath } from '../talent/types';

function StatusCell({ a }: { a: Assignment }) {
  return (
    <div className="grid gap-0.5">
      <Badge tone={a.expired ? 'warning' : a.overdue ? 'danger' : ASSIGNMENT_TONE[a.status]} dot>{a.expired ? 'Expired' : a.overdue ? 'Overdue' : ASSIGNMENT_STATUS[a.status]}</Badge>
      {a.completedOn && <span className="text-xs text-fg-muted">Completed {a.completedOn}{a.expiresOn ? ` · valid to ${a.expiresOn}` : ''}</span>}
      {!a.completedOn && a.dueOn && <span className="text-xs text-fg-muted">Due {a.dueOn}</span>}
    </div>
  );
}

function AssignDialog({ open, onClose, people, courses, paths }: { open: boolean; onClose: () => void; people: { id: string; name: string; departmentName: string | null }[]; courses: Course[]; paths: LearningPath[] }) {
  const { pending, notice, run } = useRunner();
  const [picked, setPicked] = useState<string[]>([]);
  const [what, setWhat] = useState(courses[0] ? `course:${courses[0].id}` : paths[0] ? `path:${paths[0].id}` : '');
  const [due, setDue] = useState('');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Assign learning"
      description="People are notified and see it in their learning. Anyone who already has the course open is skipped."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button loading={pending} disabled={!picked.length || !what} onClick={() => {
            const [kind, id] = what.split(':');
            run(() => assignAction({ employeeIds: picked, ...(kind === 'path' ? { pathId: id } : { courseId: id }), dueOn: due || null }), () => setPicked([]));
          }}>Assign to {picked.length || ''} {picked.length === 1 ? 'person' : 'people'}</Button>
        </>
      }
    >
      <div className="grid gap-4">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <Field label="Course or learning path">
          {(p) => (
            <Select {...p} name="what" value={what} onChange={(e) => setWhat(e.target.value)}>
              {paths.length > 0 && <optgroup label="Learning paths">{paths.map((x) => <option key={x.id} value={`path:${x.id}`}>{x.title} ({x.courses.length} courses)</option>)}</optgroup>}
              <optgroup label="Courses">{courses.map((c) => <option key={c.id} value={`course:${c.id}`}>{c.title}</option>)}</optgroup>
            </Select>
          )}
        </Field>
        <Field label="Due date" hint="Optional">{(p) => <Input {...p} type="date" name="dueOn" value={due} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDue(e.target.value)} />}</Field>
        <div className="grid gap-1">
          <div className="flex items-center justify-between text-[0.8125rem] font-medium">
            <span>People</span>
            <Button size="sm" variant="ghost" type="button" onClick={() => setPicked(picked.length === people.length ? [] : people.map((p) => p.id))}>{picked.length === people.length ? 'Clear' : 'Select all'}</Button>
          </div>
          <ul className="grid max-h-56 gap-0.5 overflow-auto rounded-lg border border-border p-1">
            {people.map((p) => (
              <li key={p.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[0.8125rem] hover:bg-bg-subtle">
                  <input type="checkbox" checked={picked.includes(p.id)} onChange={() => setPicked(picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id])} />
                  <span>{p.name}</span><span className="text-xs text-fg-muted">{p.departmentName}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}

export function LearningView({ view, filter, assignments, courses, paths, people, manages }: {
  view: 'mine' | 'team' | 'catalogue'; filter?: string; assignments: Assignment[]; courses: Course[]; paths: LearningPath[];
  people: { id: string; name: string; departmentName: string | null }[]; manages: boolean;
}) {
  const { pending, notice, run } = useRunner();
  const [assignOpen, setAssignOpen] = useState(false);
  const tabs = [{ v: 'mine', l: 'My learning' }, { v: 'catalogue', l: 'Catalogue' }, ...(manages ? [{ v: 'team', l: 'My team' }] : [])];
  const complete = (a: Assignment) => {
    const note = prompt(`Record completion of "${a.courseTitle}". Add a note (optional):`);
    if (note !== null) run(() => assignmentStepAction(a.id, 'complete', { note }));
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <Link key={t.v} href={t.v === 'mine' ? '/learning' : `/learning?view=${t.v}`} className={`rounded-full px-3 py-1 text-[0.8125rem] font-medium ${view === t.v ? 'bg-accent text-accent-fg' : 'bg-bg-subtle text-fg-muted hover:text-fg'}`}>{t.l}</Link>
        ))}
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}

      {view === 'mine' && (
        <Card>
          <CardHeader title="My learning" />
          {assignments.length ? (
            <Table>
              <THead><tr><TH>Course</TH><TH>Status</TH><TH /></tr></THead>
              <TBody>
                {assignments.map((a) => (
                  <TR key={a.id}>
                    <TD>
                      <div className="font-medium">{a.courseTitle}</div>
                      <div className="text-xs text-fg-muted">{FORMAT[a.format]}{a.durationMinutes ? ` · ${minutes(a.durationMinutes)}` : ''}{a.pathTitle ? ` · ${a.pathTitle}` : ''}{a.source === 'self_enrolled' ? ' · you enrolled' : ''}</div>
                    </TD>
                    <TD><StatusCell a={a} /></TD>
                    <TD className="whitespace-nowrap text-right">
                      {a.contentUrl && a.status !== 'completed' && <a className="mr-2 inline-flex items-center gap-1 text-[0.8125rem] text-accent hover:underline" href={a.contentUrl} target="_blank" rel="noopener noreferrer">Open <ExternalLink className="size-3" /></a>}
                      {a.status === 'assigned' && <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => assignmentStepAction(a.id, 'start'))}>Start</Button>}
                      {(a.status === 'assigned' || a.status === 'in_progress') && a.format !== 'classroom' && <Button size="sm" className="ml-1" loading={pending} onClick={() => complete(a)}>Mark complete</Button>}
                      {(a.status === 'assigned' || a.status === 'in_progress') && a.format === 'classroom' && <span className="text-xs text-fg-muted">Your manager records attendance</span>}
                      {a.source === 'self_enrolled' && a.status === 'in_progress' && <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => assignmentStepAction(a.id, 'cancel', { reason: 'Withdrawn by the learner' }))}>Drop</Button>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <EmptyState icon={<GraduationCap className="size-5" />} title="Nothing assigned yet" description="Courses your manager or HR assign appear here. You can also enrol from the catalogue." />
          )}
        </Card>
      )}

      {view === 'catalogue' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Courses" />
            {courses.length ? (
              <ul className="divide-y divide-border">
                {courses.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{c.title}</div>
                      <div className="text-xs text-fg-muted">{[c.category, FORMAT[c.format], minutes(c.durationMinutes), c.validityMonths ? `renew every ${c.validityMonths} months` : null].filter(Boolean).join(' · ')}</div>
                      {c.description && <p className="mt-1 text-[0.8125rem] text-fg-muted">{c.description}</p>}
                    </div>
                    {c.myStatus === 'assigned' || c.myStatus === 'in_progress' ? <Badge tone="info">In your learning</Badge>
                      : c.selfEnrol ? <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => enrolAction(c.id))}>Enrol</Button>
                      : <span className="text-xs text-fg-muted">Assigned by your manager or HR</span>}
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={<GraduationCap className="size-5" />} title="The catalogue is empty" description="HR adds courses and learning paths." />}
          </Card>
          <Card className="h-fit">
            <CardHeader title="Learning paths" />
            <CardBody className="grid gap-4 text-[0.8125rem]">
              {paths.length ? paths.map((p) => (
                <div key={p.id}>
                  <div className="font-medium">{p.title}</div>
                  {p.description && <p className="text-xs text-fg-muted">{p.description}</p>}
                  <ol className="mt-1 list-decimal pl-5 text-fg-muted">{p.courses.map((c) => <li key={c.id}>{c.title}</li>)}</ol>
                </div>
              )) : <p className="text-fg-muted">No learning paths yet.</p>}
            </CardBody>
          </Card>
        </div>
      )}

      {view === 'team' && (
        <Card>
          <CardHeader
            title="My team's learning"
            action={
              <div className="flex gap-2">
                <Link className="rounded-full bg-bg-subtle px-3 py-1 text-[0.8125rem] text-fg-muted hover:text-fg" href={filter ? '/learning?view=team' : '/learning?view=team&status=overdue'}>{filter ? 'Show all' : 'Only overdue'}</Link>
                <Button size="sm" disabled={!people.length || (!courses.length && !paths.length)} onClick={() => setAssignOpen(true)}><Plus className="size-3.5" /> Assign learning</Button>
              </div>
            }
          />
          {assignments.length ? (
            <Table>
              <THead><tr><TH>Person</TH><TH>Course</TH><TH>Status</TH><TH /></tr></THead>
              <TBody>
                {assignments.map((a) => (
                  <TR key={a.id}>
                    <TD className="font-medium">{a.employeeName}</TD>
                    <TD>{a.courseTitle}<div className="text-xs text-fg-muted">{FORMAT[a.format]}{a.pathTitle ? ` · ${a.pathTitle}` : ''}</div></TD>
                    <TD><StatusCell a={a} /></TD>
                    <TD className="whitespace-nowrap text-right">
                      {(a.status === 'assigned' || a.status === 'in_progress') && (
                        <>
                          <Button size="sm" variant="secondary" loading={pending} onClick={() => complete(a)}>{a.format === 'classroom' ? 'Record attendance' : 'Mark complete'}</Button>
                          <Button size="sm" variant="ghost" loading={pending} onClick={() => { const why = prompt('Why remove this assignment?'); if (why) run(() => assignmentStepAction(a.id, 'cancel', { reason: why })); }}>Remove</Button>
                        </>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <EmptyState icon={<GraduationCap className="size-5" />} title={filter ? 'Nothing overdue' : 'No learning assigned yet'} description="Assign a course or a learning path to people you manage." />
          )}
        </Card>
      )}
      {view === 'team' && <AssignDialog open={assignOpen} onClose={() => setAssignOpen(false)} people={people} courses={courses} paths={paths} />}
    </div>
  );
}
