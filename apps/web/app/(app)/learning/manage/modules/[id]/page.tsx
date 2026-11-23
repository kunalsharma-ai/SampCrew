import { BLOCK_LABEL } from '@crew/contracts';
import { Badge, Card, CardBody, CardHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import { SubNav } from '@/components/sub-nav';
import { load } from '@/lib/api';
import { creatorLabel, dateLabel, difficultyLabel, formatLabel, minutesLabel, ModuleStatusBadge } from '../../../labels';
import type { EnrolmentRow, LearningAccessView, LearningOptions, ModuleDetail, Tally } from '../../../types';
import { ModuleEditor } from '../../module-editor';
import { AssignPanel, LearnersTable, ModuleActions } from './module-parts';

export const metadata: Metadata = { title: 'Learning module' };

const TABS = ['content', 'assign', 'learners', 'versions'] as const;

export default async function ModulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab: t } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const [m, access, options] = await Promise.all([load<ModuleDetail>(`/learning/modules/${id}`), load<LearningAccessView>('/learning/access'), load<LearningOptions>('/learning/options')]);
  const tab = (TABS as readonly string[]).includes(t ?? '') ? t! : m.status === 'published' && !m.can.edit ? 'learners' : 'content';
  const learners = tab === 'learners' ? await load<{ rows: EnrolmentRow[]; total: number; summary: Tally; canExport: boolean }>(`/learning/modules/${id}/learners`) : null;
  const base = `/learning/manage/modules/${id}`;
  return (
    <div className="grid gap-4">
      <Card>
        <CardBody className="grid gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <h2 className="text-lg font-semibold" data-testid="module-heading">{m.title}</h2>
              <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <ModuleStatusBadge status={m.status} changes={m.unpublishedChanges} />
                {m.version > 0 && <Badge tone="neutral">Version {m.version}</Badge>}
                <span>{m.category}</span>·<span>{formatLabel(m.format)}</span>·<span>{difficultyLabel(m.difficulty, m.customDifficulty)}</span>
                {minutesLabel(m.durationMinutes) && <>·<span>{minutesLabel(m.durationMinutes)}</span></>}
              </div>
              <p className="text-xs text-fg-muted">Created by {creatorLabel(m.creator)}{m.publishedAt ? ` · published ${dateLabel(m.publishedAt)}` : ''}{m.status === 'scheduled' && m.publishAt ? ` · goes live ${new Date(m.publishAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</p>
            </div>
            <ModuleActions module={m} />
          </div>
          <dl className="grid grid-cols-2 gap-3 text-[0.8125rem] sm:grid-cols-4">
            <div><dt className="text-xs text-fg-subtle">Enrolled</dt><dd className="font-semibold tabular-nums">{m.assigned}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Completed</dt><dd className="font-semibold tabular-nums">{m.completed}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Completion</dt><dd className="font-semibold tabular-nums">{m.completionRate ?? 0}%</dd></div>
            <div><dt className="text-xs text-fg-subtle">Content items</dt><dd className="font-semibold tabular-nums">{m.blockCount}</dd></div>
          </dl>
        </CardBody>
      </Card>
      <SubNav label="Module views" current={`${base}?tab=${tab}`} items={[
        { href: `${base}?tab=content`, label: m.can.edit ? 'Content & details' : 'About' },
        { href: `${base}?tab=assign`, label: 'Assign', testId: 'tab-assign' },
        { href: `${base}?tab=learners`, label: 'Learners', count: m.assigned, testId: 'tab-learners' },
        { href: `${base}?tab=versions`, label: 'Versions', count: m.versions.length },
      ]} />
      {tab === 'content' && (m.can.edit ? <ModuleEditor key={`${m.id}:${m.version}:${String(m.unpublishedChanges)}`} options={options} access={access} initial={m} /> : (
        <Card>
          <CardHeader title="About this module" />
          <CardBody className="grid gap-3 text-[0.8125rem]">
            {m.description && <p className="whitespace-pre-line">{m.description}</p>}
            {m.skills.length > 0 && <p><span className="font-medium">Skills:</span> {m.skills.join(', ')}</p>}
            <p><span className="font-medium">Content:</span> {m.contentKinds.map((k) => BLOCK_LABEL[k as keyof typeof BLOCK_LABEL] ?? k).join(', ') || 'None yet'}</p>
            <p className="text-xs text-fg-muted">{m.creator.workspace === 'Super Workspace' ? 'Only the Super Workspace changes its modules.' : 'Your Super Workspace has not let you edit this module.'}</p>
          </CardBody>
        </Card>
      ))}
      {tab === 'assign' && <AssignPanel module={m} options={options} access={access} />}
      {tab === 'learners' && learners && <LearnersTable module={m} data={learners} canAssign={access.caps.assign} />}
      {tab === 'versions' && (
        <Card>
          <CardHeader title="Published versions" description="Each publication is kept. People finish the version they were enrolled on, so their records never change." />
          {m.versions.length ? (
            <Table aria-label="Versions">
              <THead><TR><TH>Version</TH><TH>Title</TH><TH>Note</TH><TH>Published</TH></TR></THead>
              <TBody>{m.versions.map((v) => <TR key={v.version}><TD className="font-medium">{v.version}</TD><TD>{v.title}</TD><TD className="text-fg-muted">{v.note}</TD><TD className="text-fg-muted">{dateLabel(v.publishedAt)}</TD></TR>)}</TBody>
            </Table>
          ) : <p className="px-5 pb-5 text-[0.8125rem] text-fg-muted">Not published yet.</p>}
        </Card>
      )}
    </div>
  );
}
