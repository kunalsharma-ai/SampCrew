import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { Alignable, GoalDetail } from '../../talent/types';
import { GoalView } from './goal-view';

export const metadata: Metadata = { title: 'Goal' };

export default async function GoalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const goal = await loadOptional<GoalDetail>(`/goals/${id}`);
  if (!goal) notFound();
  const alignable = goal.can.manage ? await load<Alignable[]>(`/goals/alignable?employeeId=${goal.employeeId}`) : [];
  return (
    <>
      <PageHeader eyebrow={<Link href="/goals" className="hover:underline">Goals</Link>} title={goal.title} description={`${goal.employeeName} · ${goal.periodStart} to ${goal.periodEnd}`} />
      <GoalView goal={goal} alignable={alignable} />
    </>
  );
}
