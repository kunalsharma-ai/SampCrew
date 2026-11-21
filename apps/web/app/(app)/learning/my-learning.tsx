'use client';
import { Alert, Badge, Button, Card, EmptyState, Input, Select, buttonClass } from '@crew/ui';
import { Award, BookOpen, Clock, GraduationCap, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { KpiRow } from '@/components/neon';
import { SubNav } from '@/components/sub-nav';
import { useRunner } from '../recruitment/use-runner';
import { enrolModuleAction } from './actions';
import { Cover, creatorLabel, dateLabel, difficultyLabel, DueLabel, formatLabel, LearnerStatusBadge, minutesLabel, ProgressBar, scoreLabel } from './labels';
import type { MyItem, MyLearning, MyTab } from './types';


function ItemCard({ item }: { item: MyItem }) {
  const action = item.status === 'completed' ? 'Review' : item.status === 'not_started' ? 'Start' : 'Continue';
  return (
    <Card className="flex flex-col overflow-hidden" data-testid="my-learning-item">
      <Cover fileId={item.coverFileId} title={item.title} className="rounded-none" />
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <LearnerStatusBadge status={item.status} />
          <Badge>{item.category}</Badge>
          {item.newerVersion && <Badge tone="info">Updated since you finished</Badge>}
        </div>
        <div>
          <h3 className="text-[0.9375rem] font-semibold leading-snug">{item.title}</h3>
          {item.shortDescription && <p className="mt-1 line-clamp-2 text-[0.8125rem] text-fg-muted">{item.shortDescription}</p>}
        </div>
        <dl className="grid gap-1 text-xs text-fg-muted">
          <div><dt className="sr-only">Created by</dt><dd>{creatorLabel(item.creator)}</dd></div>
          <div className="flex flex-wrap gap-x-3">
            <span>{formatLabel(item.format)}</span>
            <span>{difficultyLabel(item.difficulty)}</span>
            {minutesLabel(item.durationMinutes) && <span>{minutesLabel(item.durationMinutes)}</span>}
            <span>{item.itemCount} item{item.itemCount === 1 ? '' : 's'}</span>
          </div>
          {item.assignedBy && <div>Assigned by {item.assignedBy}</div>}
        </dl>
        <ProgressBar value={item.progressPercent} label={`${item.title} progress`} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          {item.status === 'completed' ? <span className="text-fg-muted">Completed {dateLabel(item.completedOn)}{item.scorePercent !== null ? ` · Score ${scoreLabel(item.scorePercent)}` : ''}</span> : <DueLabel dueOn={item.dueOn} due={item.due} />}
        </div>
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Link href={`/learning/my/${item.id}`} className={buttonClass(item.status === 'completed' ? 'secondary' : 'primary', 'sm')} data-testid="open-learning">{action}</Link>
          {item.certificateNo && <Link href={`/learning/my/${item.id}/certificate`} className={buttonClass('ghost', 'sm')}><Award className="size-4" aria-hidden />Certificate</Link>}
        </div>
      </div>
    </Card>
  );
}

export function MyLearningView({ my, tab, learner }: { my: MyLearning; tab: MyTab; learner: boolean }) {
  const { pending, notice, run } = useRunner();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const s = my.summary;
  const items = useMemo(() => my.items.filter((i) => (tab === 'all' || tab === 'library' || i.status === tab)), [my.items, tab]);
  const needle = q.trim().toLowerCase();
  const match = (x: { title: string; shortDescription: string; category: string }) => (!needle || [x.title, x.shortDescription, x.category].some((v) => v.toLowerCase().includes(needle))) && (!category || x.category === category);
  const categories = [...new Set([...my.items, ...my.available].map((i) => i.category))].sort();
  const tabs = [
    { href: '/learning', label: 'All', count: s.total },
    { href: '/learning?tab=not_started', label: 'Not started', count: s.notStarted },
    { href: '/learning?tab=in_progress', label: 'In progress', count: s.inProgress },
    { href: '/learning?tab=completed', label: 'Completed', count: s.completed },
    { href: '/learning?tab=overdue', label: 'Overdue', count: s.overdue, alert: true },
    { href: '/learning?tab=library', label: 'Learning library', count: my.available.length },
  ];
  return (
    <div className="grid gap-5">
      {!learner && <Alert tone="warning">Your login is not linked to an employee record yet, so nothing can be assigned to you. Ask HR to link it.</Alert>}
      <KpiRow tiles={[
        { key: 'assigned', label: 'My learning', value: s.total, tone: 'violet', icon: 'graduation-cap' },
        { key: 'progress', label: 'In progress', value: s.inProgress, tone: 'blue', icon: 'clock' },
        { key: 'done', label: 'Completed', value: s.completed, tone: 'green', icon: 'check' },
        { key: 'overdue', label: 'Overdue', value: s.overdue, tone: 'orange', icon: 'alarm-clock', invert: true },
        { key: 'score', label: 'Average score', value: s.averageScore, unit: 'percent', tone: 'teal', icon: 'award', hint: `${minutesLabel(s.timeSpentMinutes) ?? '0 min'} spent learning` },
      ]} />
      <SubNav label="My learning views" items={tabs} current={tab === 'all' ? '/learning' : `/learning?tab=${tab}`} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Search learning</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or category" className="max-w-72 pl-8" />
        </label>
        <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="max-w-56">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </Select>
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {tab !== 'library' && (
        items.filter(match).length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.filter(match).map((i) => <ItemCard key={i.id} item={i} />)}</div>
        ) : (
          <EmptyState icon={<GraduationCap className="size-5" />} title={tab === 'overdue' ? 'Nothing overdue' : tab === 'completed' ? 'Nothing completed yet' : 'No learning here'} description={tab === 'all' ? 'When HR assigns learning to you, it shows here. You can also enrol in modules from the learning library.' : undefined}
            action={my.available.length ? <Link href="/learning?tab=library" className={buttonClass('secondary', 'sm')}>Open the learning library</Link> : undefined} />
        )
      )}
      {tab === 'library' && (
        my.available.filter(match).length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {my.available.filter(match).map((m) => (
              <Card key={m.id} className="flex flex-col overflow-hidden" data-testid="library-item">
                <Cover fileId={m.coverFileId} title={m.title} className="rounded-none" />
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <div className="flex flex-wrap gap-1.5"><Badge>{m.category}</Badge><Badge tone="neutral">{difficultyLabel(m.difficulty)}</Badge></div>
                  <h3 className="text-[0.9375rem] font-semibold">{m.title}</h3>
                  {m.shortDescription && <p className="line-clamp-3 text-[0.8125rem] text-fg-muted">{m.shortDescription}</p>}
                  <p className="text-xs text-fg-muted">{creatorLabel(m.creator)}</p>
                  <p className="flex flex-wrap gap-x-3 text-xs text-fg-muted"><span>{formatLabel(m.format)}</span>{minutesLabel(m.durationMinutes) && <span className="inline-flex items-center gap-1"><Clock className="size-3" aria-hidden />{minutesLabel(m.durationMinutes)}</span>}</p>
                  {m.skills.length > 0 && <p className="text-xs text-fg-subtle">Skills: {m.skills.join(', ')}</p>}
                  <div className="mt-auto pt-2">
                    <Button size="sm" loading={pending} disabled={!learner} onClick={() => run(() => enrolModuleAction(m.id))}>Enrol</Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState icon={<BookOpen className="size-5" />} title="Nothing to enrol in" description="Modules HR opens for everyone to join show here." />
        )
      )}
    </div>
  );
}
