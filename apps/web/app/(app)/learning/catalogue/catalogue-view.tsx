'use client';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { BookOpen, Plus } from 'lucide-react';
import { useState } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import { useRunner } from '../../recruitment/use-runner';
import { archiveCourseAction, archivePathAction, saveCourseAction, savePathAction } from '../../talent/actions';
import { FORMAT, minutes } from '../../talent/labels';
import type { Course, LearningPath } from '../../talent/types';

function PathDialog({ open, onClose, courses, path }: { open: boolean; onClose: () => void; courses: Course[]; path?: LearningPath }) {
  const { pending, notice, run } = useRunner();
  const [title, setTitle] = useState(path?.title ?? '');
  const [description, setDescription] = useState(path?.description ?? '');
  const [ids, setIds] = useState<string[]>(path?.courses.map((c) => c.id) ?? []);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={path ? 'Edit learning path' : 'New learning path'}
      description="Courses are taken in the order you tick them."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={pending} disabled={!ids.length || title.trim().length < 3} onClick={() => run(() => savePathAction(path?.id ?? null, { title, description, courseIds: ids }), onClose)}>Save path</Button>
        </>
      }
    >
      <div className="grid gap-4">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <Field label="Title" required>{(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New supervisor essentials" />}</Field>
        <Field label="Description">{(p) => <Textarea {...p} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <ul className="grid max-h-60 gap-0.5 overflow-auto rounded-lg border border-border p-1">
          {courses.map((c) => {
            const pos = ids.indexOf(c.id);
            return (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[0.8125rem] hover:bg-bg-subtle">
                  <input type="checkbox" checked={pos >= 0} onChange={() => setIds(pos >= 0 ? ids.filter((x) => x !== c.id) : [...ids, c.id])} />
                  {pos >= 0 && <span className="w-4 text-xs tabular-nums text-fg-muted">{pos + 1}</span>}
                  <span>{c.title}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}

export function CatalogueView({ courses, paths }: { courses: Course[]; paths: LearningPath[] }) {
  const { pending, notice, run } = useRunner();
  const [course, setCourse] = useState<Course | 'new' | null>(null);
  const [path, setPath] = useState<LearningPath | 'new' | null>(null);
  const live = courses.filter((c) => !c.archivedAt);
  const editing = course && course !== 'new' ? course : undefined;
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Courses" action={<Button size="sm" onClick={() => setCourse('new')}><Plus className="size-3.5" /> Add course</Button>} />
        {courses.length ? (
          <Table>
            <THead><tr><TH>Course</TH><TH>Format</TH><TH>Renewal</TH><TH>Enrolment</TH><TH className="text-right">Completions</TH><TH /></tr></THead>
            <TBody>
              {courses.map((c) => (
                <TR key={c.id} className={c.archivedAt ? 'opacity-60' : undefined}>
                  <TD>
                    <div className="font-medium">{c.title}{c.archivedAt && <Badge className="ml-2">Archived</Badge>}</div>
                    <div className="text-xs text-fg-muted">{[c.category, minutes(c.durationMinutes)].filter(Boolean).join(' · ')}</div>
                  </TD>
                  <TD className="text-fg-muted">{FORMAT[c.format]}</TD>
                  <TD className="text-fg-muted">{c.validityMonths ? `Every ${c.validityMonths} months` : 'No expiry'}</TD>
                  <TD className="text-fg-muted">{c.selfEnrol ? 'Anyone can enrol' : 'Assigned only'}</TD>
                  <TD className="text-right tabular-nums">{c.completions}</TD>
                  <TD className="whitespace-nowrap text-right">
                    {!c.archivedAt && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setCourse(c)}>Edit</Button>
                        <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Archive this course? People keep their records; nobody new can be assigned.') && run(() => archiveCourseAction(c.id))}>Archive</Button>
                      </>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState icon={<BookOpen className="size-5" />} title="No courses yet" description="Add a course with a link to its content, or a classroom session." />}
      </Card>

      <Card>
        <CardHeader title="Learning paths" action={<Button size="sm" variant="secondary" disabled={!live.length} onClick={() => setPath('new')}><Plus className="size-3.5" /> New path</Button>} />
        {paths.length ? (
          <ul className="divide-y divide-border">
            {paths.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start gap-3 px-5 py-3 text-[0.8125rem]">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{p.title}</div>
                  <div className="text-xs text-fg-muted">{p.courses.map((c) => c.title).join(' → ')}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setPath(p)}>Edit</Button>
                <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Archive this path?') && run(() => archivePathAction(p.id))}>Archive</Button>
              </li>
            ))}
          </ul>
        ) : <EmptyState icon={<BookOpen className="size-5" />} title="No learning paths yet" description="Group courses into a sequence, such as onboarding or safety." />}
      </Card>

      <ResourceDialog
        key={editing?.id ?? 'new-course'}
        open={course !== null}
        onClose={() => setCourse(null)}
        title={editing ? 'Edit course' : 'Add course'}
        submitLabel={editing ? 'Save course' : 'Add course'}
        initial={editing ? { ...editing, selfEnrol: editing.selfEnrol ? 'yes' : 'no' } : { format: 'online', selfEnrol: 'yes' }}
        fields={[
          { name: 'title', label: 'Title', required: true },
          { name: 'description', label: 'Description', type: 'textarea' },
          { name: 'format', label: 'Format', type: 'select', required: true, half: true, options: Object.entries(FORMAT).map(([value, label]) => ({ value, label })) },
          { name: 'category', label: 'Category', half: true, placeholder: 'Safety' },
          { name: 'contentUrl', label: 'Link to the content', nullable: true, placeholder: 'https://', hint: 'Where people take the course. Leave empty for classroom sessions.' },
          { name: 'durationMinutes', label: 'Duration (minutes)', type: 'number', nullable: true, half: true },
          { name: 'validityMonths', label: 'Renew after (months)', type: 'number', nullable: true, half: true, hint: 'For certifications that expire' },
          { name: 'selfEnrol', label: 'Enrolment', type: 'select', required: true, options: [{ value: 'yes', label: 'Anyone can enrol themselves' }, { value: 'no', label: 'Assigned by managers or HR only' }] },
        ]}
        onSubmit={(v) => saveCourseAction(editing?.id ?? null, {
          title: v.title, description: v.description ?? '', format: v.format, category: v.category ?? '', contentUrl: v.contentUrl ?? null,
          durationMinutes: v.durationMinutes ?? null, validityMonths: v.validityMonths ?? null, selfEnrol: v.selfEnrol === 'yes',
        })}
      />
      {path !== null && <PathDialog key={path === 'new' ? 'new' : path.id} open onClose={() => setPath(null)} courses={live} path={path === 'new' ? undefined : path} />}
    </div>
  );
}
