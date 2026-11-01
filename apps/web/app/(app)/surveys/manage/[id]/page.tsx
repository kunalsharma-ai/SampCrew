import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { Department, LegalEntity } from '@/lib/types';
import type { SurveyDetail, SurveyResults } from '../../../talent/types';
import { SurveyAdminView } from './survey-admin-view';

export const metadata: Metadata = { title: 'Survey' };

export default async function SurveyAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const survey = await loadOptional<SurveyDetail>(`/surveys/${id}`);
  if (!survey) notFound();
  const [results, entities, departments] = await Promise.all([
    survey.status === 'draft' ? Promise.resolve(null) : load<SurveyResults>(`/surveys/${id}/results`),
    survey.status === 'draft' ? load<LegalEntity[]>('/org/legal-entities') : Promise.resolve([]),
    survey.status === 'draft' ? load<Department[]>('/org/departments') : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader eyebrow={<Link href="/surveys/manage" className="hover:underline">Manage surveys</Link>} title={survey.title} description={survey.description || undefined} />
      <SurveyAdminView survey={survey} results={results} entities={entities} departments={departments} />
    </>
  );
}
