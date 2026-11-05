import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import type { Alignable, Goal } from '../talent/types';
import { GoalsView } from './goals-view';

export const metadata: Metadata = { title: 'Goals' };

export default async function GoalsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view: v } = await searchParams;
  const me = await load<Me>('/me');
  const manages = Boolean(me.permissions['performance:manage']);
  const view = manages && v === 'team' ? 'team' : 'mine';
  const [data, alignable, people] = await Promise.all([
    load<{ goals: Goal[]; overallProgress: number | null }>(`/goals?view=${view}`),
    load<Alignable[]>('/goals/alignable').catch(() => []),
    manages ? load<{ id: string; name: string }[]>('/talent/people?for=performance') : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader title="Goals" description="Measurable goals with key results. Update progress with a check-in; your manager sees it." />
      <GoalsView view={view} goals={data.goals} overall={data.overallProgress} alignable={alignable} people={people} manages={manages} />
    </>
  );
}
