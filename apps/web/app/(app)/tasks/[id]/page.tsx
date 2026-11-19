import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { WorkTaskDetail } from '@/lib/types';
import { TaskDetail } from './task-detail';

export const metadata: Metadata = { title: 'Task' };

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await load<WorkTaskDetail>(`/tasks/${id}`);
  const back = task.isMine ? `/tasks?tab=${task.category}` : task.kind === 'document' && task.status === 'pending_review' ? '/tasks?tab=verify' : '/tasks?tab=team';
  return (
    <>
      <PageHeader
        eyebrow={task.category === 'hr' ? 'HR task' : 'Manager task'}
        title={task.title}
        description={task.isMine ? `From ${task.assignedBy ?? 'HR'}` : `For ${task.employeeName ?? 'an employee'}${task.departmentName ? `, ${task.departmentName}` : ''}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href={back}>All tasks</Link>}
      />
      <TaskDetail task={task} />
    </>
  );
}
