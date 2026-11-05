import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { Department, LegalEntity } from '@/lib/types';
import type { CycleDetail } from '../../../talent/types';
import { CycleView } from './cycle-view';

export const metadata: Metadata = { title: 'Review cycle' };

export default async function CyclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cycle = await loadOptional<CycleDetail>(`/review-cycles/${id}`);
  if (!cycle) notFound();
  const [entities, departments] = cycle.status === 'draft'
    ? await Promise.all([load<LegalEntity[]>('/org/legal-entities'), load<Department[]>('/org/departments')])
    : [[], []];
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/reviews/cycles" className="hover:underline">Review cycles</Link>}
        title={cycle.name}
        description={`Period ${cycle.periodStart} to ${cycle.periodEnd} · ${[cycle.legalEntityName, cycle.departmentName].filter(Boolean).join(' · ') || 'everyone'}`}
      />
      <CycleView cycle={cycle} entities={entities} departments={departments} />
    </>
  );
}
