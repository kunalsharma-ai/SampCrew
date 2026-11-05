import { Card, EmptyState, PageHeader, buttonClass } from '@crew/ui';
import { ClipboardList } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadOptional } from '@/lib/api';
import type { SurveyForm } from '../../talent/types';
import { SurveyFormView } from './survey-form';

export const metadata: Metadata = { title: 'Survey' };

export default async function SurveyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const form = await loadOptional<SurveyForm>(`/my-surveys/${id}`);
  if (form) {
    return (
      <>
        <PageHeader eyebrow={<Link href="/surveys" className="hover:underline">Surveys</Link>} title={form.title} description={form.description || undefined} />
        <SurveyFormView form={form} />
      </>
    );
  }
  // Not invited to it. People who run surveys see its anonymous results page instead of a dead end.
  if (await loadOptional<{ id: string }>(`/surveys/${id}`)) redirect(`/surveys/manage/${id}`);
  return (
    <>
      <PageHeader eyebrow={<Link href="/surveys" className="hover:underline">Surveys</Link>} title="Survey" />
      <Card data-testid="survey-not-invited">
        <EmptyState
          icon={<ClipboardList className="size-5" />}
          title="This survey is not open to you"
          description="You were not invited to it, or it is still a draft. Surveys you are invited to are listed on your Surveys page."
          action={<Link href="/surveys" className={buttonClass('primary', 'sm')}>Go to my surveys</Link>}
        />
      </Card>
    </>
  );
}
