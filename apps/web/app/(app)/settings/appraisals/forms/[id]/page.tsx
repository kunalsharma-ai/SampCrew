import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { AppraisalForm, Department, Designation } from '@/lib/types';
import { flatDepartments } from '../../departments';
import { FormBuilder } from './form-builder';

export const metadata: Metadata = { title: 'Appraisal form' };

export default async function AppraisalFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await loadOptional<AppraisalForm>(`/appraisals/forms/${id}`);
  if (!form) notFound();
  const [departments, designations] = await Promise.all([loadOptional<Department[]>('/org/departments'), loadOptional<Designation[]>('/designations')]);
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/settings/appraisals" className="hover:underline">Appraisal forms & cycles</Link>}
        title={form.name}
        description="Change the sections, questions, weights, scale and categories. Saving makes a new version for appraisals that start from now on."
      />
      <FormBuilder key={`${form.id}-${form.version}`} form={form} departments={flatDepartments(departments)} designations={(designations ?? []).map((d) => ({ id: d.id, name: d.name }))} />
    </>
  );
}
