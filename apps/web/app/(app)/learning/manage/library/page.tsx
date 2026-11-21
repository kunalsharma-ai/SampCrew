import { DIFFICULTY_LABEL, FORMAT_LABEL, LEARNING_DIFFICULTIES, MODULE_FORMATS, MODULE_STATUS_LABEL, MODULE_STATUSES } from '@crew/contracts';
import { Badge, Button, Card, EmptyState, Input, Select, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import { BookOpen, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { creatorLabel, dateLabel, difficultyLabel, formatLabel, minutesLabel, ModuleStatusBadge } from '../../labels';
import type { LearningAccessView, LearningOptions, ModuleSummary } from '../../types';

export const metadata: Metadata = { title: 'Learning library' };

const KEYS = ['q', 'status', 'category', 'skill', 'difficulty', 'format'] as const;

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Partial<Record<(typeof KEYS)[number], string>>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const k of KEYS) if (sp[k]) qs.set(k, sp[k]!.slice(0, 100));
  const [modules, access, options] = await Promise.all([load<ModuleSummary[]>(`/learning/modules?${qs}`), load<LearningAccessView>('/learning/access'), load<LearningOptions>('/learning/options')]);
  const categories = [...options.categories, ...options.customCategories.map((c) => c.name)].sort((a, b) => a.localeCompare(b));
  const filtered = KEYS.some((k) => sp[k]);
  return (
    <div className="grid gap-4">
      <form className="flex flex-wrap items-end gap-2" role="search" aria-label="Find learning modules">
        <Input name="q" defaultValue={sp.q} placeholder="Search title, topic, skill, tag or creator" className="max-w-72" aria-label="Search" />
        <Select name="status" defaultValue={sp.status ?? ''} aria-label="Status" className="max-w-36">
          <option value="">Any status</option>
          {MODULE_STATUSES.map((s) => <option key={s} value={s}>{MODULE_STATUS_LABEL[s]}</option>)}
        </Select>
        <Select name="category" defaultValue={sp.category ?? ''} aria-label="Category" className="max-w-48">
          <option value="">Any category</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <Select name="skill" defaultValue={sp.skill ?? ''} aria-label="Skill" className="max-w-44">
          <option value="">Any skill</option>
          {options.skills.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <Select name="difficulty" defaultValue={sp.difficulty ?? ''} aria-label="Difficulty" className="max-w-36">
          <option value="">Any level</option>
          {LEARNING_DIFFICULTIES.map((d) => <option key={d} value={d}>{DIFFICULTY_LABEL[d]}</option>)}
        </Select>
        <Select name="format" defaultValue={sp.format ?? ''} aria-label="Content type" className="max-w-40">
          <option value="">Any content type</option>
          {MODULE_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
        </Select>
        <Button type="submit" variant="secondary" size="sm">Filter</Button>
        {filtered && <Link href="/learning/manage/library" className={buttonClass('ghost', 'sm')}>Clear</Link>}
        {access.caps.create && <Link href="/learning/manage/new" className={buttonClass('primary', 'sm', 'ml-auto')}><Plus className="size-4" aria-hidden />New module</Link>}
      </form>
      {modules.length ? (
        <Card>
          <Table aria-label="Learning modules">
            <THead><TR><TH>Module</TH><TH>Status</TH><TH>Created by</TH><TH>Content</TH><TH className="text-right">Assigned</TH><TH className="text-right">Completed</TH><TH>Updated</TH></TR></THead>
            <TBody>
              {modules.map((m) => (
                <TR key={m.id} data-testid="library-row">
                  <TD className="max-w-80">
                    <Link href={`/learning/manage/modules/${m.id}`} className="font-medium hover:underline">{m.title}</Link>
                    <span className="mt-0.5 flex flex-wrap gap-1 text-xs text-fg-muted">
                      <span>{m.category}</span>·<span>{difficultyLabel(m.difficulty, m.customDifficulty)}</span>{minutesLabel(m.durationMinutes) && <>·<span>{minutesLabel(m.durationMinutes)}</span></>}
                    </span>
                    {m.skills.length > 0 && <span className="mt-1 flex flex-wrap gap-1">{m.skills.slice(0, 4).map((s) => <Badge key={s} tone="neutral">{s}</Badge>)}</span>}
                  </TD>
                  <TD><ModuleStatusBadge status={m.status} changes={m.unpublishedChanges} />{m.status === 'scheduled' && m.publishAt && <span className="block text-xs text-fg-muted">Goes live {dateLabel(m.publishAt)}</span>}{m.version > 0 && <span className="block text-xs text-fg-subtle">Version {m.version}</span>}</TD>
                  <TD className="text-xs text-fg-muted">{creatorLabel(m.creator)}</TD>
                  <TD className="text-xs text-fg-muted">{formatLabel(m.format)}<span className="block">{m.blockCount} item{m.blockCount === 1 ? '' : 's'}</span></TD>
                  <TD className="text-right tabular-nums">{m.assigned}</TD>
                  <TD className="text-right tabular-nums">{m.completed}{m.completionRate !== null && <span className="block text-xs text-fg-muted">{m.completionRate}%</span>}</TD>
                  <TD className="text-xs text-fg-muted">{dateLabel(m.publishedAt ?? m.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : (
        <EmptyState icon={<BookOpen className="size-5" />} title={filtered ? 'No modules match' : 'No learning modules yet'} description={filtered ? 'Try fewer filters.' : 'Modules you create, and published modules from the Super Workspace, show here.'}
          action={!filtered && access.caps.create ? <Link href="/learning/manage/new" className={buttonClass('primary', 'sm')}>Create a learning module</Link> : undefined} />
      )}
    </div>
  );
}
