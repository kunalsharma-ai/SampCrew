import { buttonClass, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import type { Me } from '@/lib/types';
import type { Assignment, Course, LearningPath } from '../talent/types';
import { LearningView } from './learning-view';

export const metadata: Metadata = { title: 'Learning' };

export default async function LearningPage({ searchParams }: { searchParams: Promise<{ view?: string; status?: string }> }) {
  const { view: v, status } = await searchParams;
  const me = await load<Me>('/me');
  const manages = Boolean(me.permissions['learning:manage']);
  const view = v === 'catalogue' ? 'catalogue' : manages && v === 'team' ? 'team' : 'mine';
  const filter = view === 'team' && status === 'overdue' ? 'overdue' : undefined;
  const [assignments, courses, paths, people] = await Promise.all([
    view === 'catalogue' ? Promise.resolve([]) : load<Assignment[]>(`/learning/assignments?view=${view}${filter ? `&status=${filter}` : ''}`),
    load<Course[]>('/learning/courses'),
    load<LearningPath[]>('/learning/paths'),
    manages && view === 'team' ? load<{ id: string; name: string; departmentName: string | null }[]>('/talent/people?for=learning') : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader
        title="Learning"
        description="Courses assigned to you, the catalogue you can enrol in, and your team's progress."
        actions={me.permissions['learning:configure'] ? <Link className={buttonClass('secondary', 'sm')} href="/learning/catalogue">Manage catalogue</Link> : undefined}
      />
      {view === 'mine' && <ModuleOverview module="learning" actions={allowed(me, [
        { label: 'Course library', href: '/learning?view=catalogue', icon: 'book-open', permission: 'learning:read' },
        { label: 'Team progress', href: '/learning?view=team', icon: 'users', permission: 'learning:manage' },
        { label: 'Manage catalogue', href: '/learning/catalogue', icon: 'graduation-cap', permission: 'learning:configure' },
      ])} />}
      <LearningView view={view} filter={filter} assignments={assignments} courses={courses} paths={paths} people={people} manages={manages} />
    </>
  );
}
