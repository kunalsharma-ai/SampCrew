import { Card, CardHeader, PageHeader, Stat } from '@crew/ui';
import { AlertTriangle, ClipboardCheck, FileSearch, ListTodo } from 'lucide-react';
import type { Metadata } from 'next';
import { SubNav, type SubNavItem } from '@/components/sub-nav';
import { load, loadOptional } from '@/lib/api';
import type { AssignablePerson, Me, OnboardingTask, TaskCounts, WorkTask } from '@/lib/types';
import { TaskList } from '../employees/[id]/tabs';
import { AssignTask, TaskCards } from './task-ui';

export const metadata: Metadata = { title: 'My tasks' };

type Tab = 'hr' | 'manager' | 'onboarding' | 'team' | 'verify' | 'done';

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const [me, counts, people] = await Promise.all([
    load<Me>('/me'),
    load<TaskCounts>('/tasks/counts'),
    load<{ hr: AssignablePerson[]; manager: AssignablePerson[] }>('/tasks/assignable'),
  ]);
  const assigns = people.hr.length > 0 || people.manager.length > 0;
  const onboarding = me.features.includes('onboarding') ? await loadOptional<OnboardingTask[]>('/onboarding/my-tasks') : null;
  const allowed: Tab[] = ['hr', 'manager', ...(onboarding?.length ? (['onboarding'] as Tab[]) : []), 'done', ...(assigns ? (['team'] as Tab[]) : []), ...(people.hr.length ? (['verify'] as Tab[]) : [])];
  const tab: Tab = allowed.includes(sp.tab as Tab) ? (sp.tab as Tab) : 'hr';

  const items: SubNavItem[] = [
    { href: '/tasks?tab=hr', label: 'HR tasks', count: counts.hr.open + counts.hr.review, alert: counts.hr.overdue > 0, testId: 'tab-hr' },
    { href: '/tasks?tab=manager', label: 'Manager tasks', count: counts.manager.open + counts.manager.review, alert: counts.manager.overdue > 0, testId: 'tab-manager' },
    ...(onboarding?.length ? [{ href: '/tasks?tab=onboarding', label: 'Onboarding', count: onboarding.length }] : []),
    { href: '/tasks?tab=done', label: 'Completed' },
    ...(assigns ? [{ href: '/tasks?tab=team', label: 'Tasks I assign', count: counts.toReview, alert: counts.toReview > 0, testId: 'tab-team' }] : []),
    ...(people.hr.length ? [{ href: '/tasks?tab=verify', label: 'Documents to verify', count: counts.documentsToVerify, alert: counts.documentsToVerify > 0, testId: 'tab-verify' }] : []),
  ];

  let body: React.ReactNode;
  if (tab === 'onboarding') {
    body = (
      <Card>
        <CardHeader title="Onboarding tasks" description="Checklist items for new joiners that are assigned to you, soonest first." />
        <TaskList tasks={onboarding ?? []} showEmployee />
      </Card>
    );
  } else {
    const query = tab === 'team' ? 'scope=assigned&status=all' : tab === 'verify' ? 'scope=assigned&category=hr&status=review' : tab === 'done' ? 'scope=mine&status=done' : `scope=mine&category=${tab}`;
    const all = await load<WorkTask[]>(`/tasks?${query}`);
    const tasks = tab === 'verify' ? all.filter((t) => t.kind === 'document') : tab === 'hr' || tab === 'manager' ? all.filter((t) => t.status !== 'completed' && t.status !== 'cancelled') : all;
    const copy: Record<Exclude<Tab, 'onboarding'>, { title: string; description: string; empty: { title: string; description: string } }> = {
      hr: { title: 'HR tasks', description: 'Documents, forms and acknowledgements HR needs from you. Uploaded documents go to HR to verify.', empty: { title: 'No HR tasks', description: 'When HR asks you for a document or form, it appears here.' } },
      manager: { title: 'Manager tasks', description: 'Work your reporting manager has assigned to you.', empty: { title: 'No manager tasks', description: 'Tasks from your manager appear here, with their due dates and priority.' } },
      done: { title: 'Completed and cancelled', description: 'Tasks you have finished, and ones that were called off.', empty: { title: 'Nothing completed yet', description: 'Finished tasks are kept here with their history.' } },
      team: { title: 'Tasks I assign', description: 'Tasks you gave to others, and those of the people you look after. Open one to review, reopen or cancel it.', empty: { title: 'No tasks assigned yet', description: 'Use "Assign a task" to give someone a task.' } },
      verify: { title: 'Documents to verify', description: 'Uploads from HR tasks waiting for a check. The same requests appear in Approvals.', empty: { title: 'Nothing to verify', description: 'Documents employees upload for HR tasks appear here.' } },
    };
    const c = copy[tab];
    body = (
      <Card>
        <CardHeader title={c.title} description={c.description} />
        <TaskCards tasks={tasks} showEmployee={tab === 'team' || tab === 'verify'} empty={c.empty} />
      </Card>
    );
  }

  const open = counts.hr.open + counts.manager.open;
  const overdue = counts.hr.overdue + counts.manager.overdue;
  return (
    <>
      <PageHeader title="My tasks" description="HR tasks and manager tasks in one place, with their deadlines, priority and progress." actions={assigns ? <AssignTask people={people} /> : undefined} />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open tasks" value={open} icon={<ListTodo className="size-4" />} />
        <Stat label="Overdue" value={overdue} icon={<AlertTriangle className="size-4" />} hint={overdue ? 'Past their due date' : 'Nothing late'} />
        <Stat label="Waiting for review" value={counts.hr.review + counts.manager.review} icon={<ClipboardCheck className="size-4" />} />
        {assigns ? <Stat label="For me to check" value={counts.toReview + counts.documentsToVerify} icon={<FileSearch className="size-4" />} /> : <Stat label="New" value={counts.hr.new + counts.manager.new} icon={<FileSearch className="size-4" />} />}
      </div>
      <SubNav label="Task lists" items={items} current={`/tasks?tab=${tab}`} />
      {body}
    </>
  );
}
