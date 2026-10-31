import { Card, CardHeader, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { OnboardingTask } from '@/lib/types';
import { TaskList } from '../employees/[id]/tabs';

export const metadata: Metadata = { title: 'My tasks' };

export default async function TasksPage() {
  const tasks = await load<OnboardingTask[]>('/onboarding/my-tasks');
  return (
    <>
      <PageHeader title="My tasks" description="Open onboarding tasks assigned to you, soonest first." />
      <Card>
        <CardHeader title={`${tasks.length} open`} />
        <TaskList tasks={tasks} showEmployee />
      </Card>
    </>
  );
}
