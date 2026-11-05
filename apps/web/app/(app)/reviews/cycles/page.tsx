import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { Department, LegalEntity } from '@/lib/types';
import type { CycleSummary } from '../../talent/types';
import { CyclesView } from './cycles-view';

export const metadata: Metadata = { title: 'Review cycles' };

export default async function CyclesPage() {
  const [cycles, entities, departments] = await Promise.all([
    load<CycleSummary[]>('/review-cycles'),
    load<LegalEntity[]>('/org/legal-entities'),
    load<Department[]>('/org/departments'),
  ]);
  return (
    <>
      <PageHeader eyebrow={<Link href="/reviews" className="hover:underline">Reviews</Link>} title="Review cycles" description="Launch a cycle, follow progress, calibrate ratings and release results." />
      <CyclesView cycles={cycles} entities={entities} departments={departments} />
    </>
  );
}
