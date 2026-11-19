import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { AppraisalDetail } from '@/lib/types';
import { AppraisalForm } from './appraisal-form';

export const metadata: Metadata = { title: 'Appraisal' };

export default async function AppraisalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await load<AppraisalDetail>(`/appraisals/${id}`);
  const back = detail.role === 'employee' ? '/appraisal' : detail.role === 'manager' ? '/appraisal?tab=team' : '/appraisal?tab=hr';
  return (
    <>
      <PageHeader
        eyebrow={detail.cycle.name}
        title={detail.definition.title}
        description={detail.role === 'employee' ? 'Your self-appraisal, then your manager and HR.' : `For ${detail.employee.name}${detail.employee.department ? `, ${detail.employee.department}` : ''}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href={back}>All appraisals</Link>}
      />
      <AppraisalForm key={`${detail.id}-${detail.stage}`} detail={detail} />
    </>
  );
}
