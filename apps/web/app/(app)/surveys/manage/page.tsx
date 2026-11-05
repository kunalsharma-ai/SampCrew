import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { Department, LegalEntity } from '@/lib/types';
import type { SurveySummary } from '../../talent/types';
import { ManageSurveysView } from './manage-view';

export const metadata: Metadata = { title: 'Manage surveys' };

export default async function ManageSurveysPage() {
  const [surveys, entities, departments] = await Promise.all([
    load<SurveySummary[]>('/surveys'),
    load<LegalEntity[]>('/org/legal-entities'),
    load<Department[]>('/org/departments'),
  ]);
  return (
    <>
      <PageHeader eyebrow={<Link href="/surveys" className="hover:underline">Surveys</Link>} title="Manage surveys" description="Every survey is anonymous. Results stay hidden until enough people answer, and small groups are never shown on their own." />
      <ManageSurveysView surveys={surveys} entities={entities} departments={departments} />
    </>
  );
}
