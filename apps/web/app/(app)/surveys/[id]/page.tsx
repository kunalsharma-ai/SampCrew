import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadOptional } from '@/lib/api';
import type { SurveyForm } from '../../talent/types';
import { SurveyFormView } from './survey-form';

export const metadata: Metadata = { title: 'Survey' };

export default async function SurveyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await loadOptional<SurveyForm>(`/my-surveys/${id}`);
  if (!form) notFound();
  return (
    <>
      <PageHeader eyebrow={<Link href="/surveys" className="hover:underline">Surveys</Link>} title={form.title} description={form.description || undefined} />
      <SurveyFormView form={form} />
    </>
  );
}
