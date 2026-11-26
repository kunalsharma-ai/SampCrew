import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { LiveDocuments } from '../../documents/ui';
import { ChecklistView } from '../checklist-view';
import { AssignDialog } from '../document-picker';
import type { Checklist } from '../types';

export const metadata: Metadata = { title: 'Onboarding checklist' };

export default async function OnboardingChecklistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await load<Checklist>(`/onboarding-documents/checklists/${id}`);
  return (
    <>
      <LiveDocuments />
      <PageHeader
        eyebrow={c.status === 'completed' ? 'Onboarding documents · completed' : 'Onboarding documents'}
        title={c.employee?.name ?? 'Employee'}
        description={[c.employee?.code, c.hrWorkspace, c.employee ? `joined ${c.employee.dateOfJoining}` : null].filter(Boolean).join(' · ')}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {c.employee && <Link className="text-sm font-medium text-accent hover:underline" href={`/employees/${c.employee.id}`}>Profile</Link>}
            <Link className="text-sm font-medium text-accent hover:underline" href="/onboarding-documents">All onboarding</Link>
            {c.canReview && c.status === 'active' && c.employee && <AssignDialog employeeId={c.employee.id} already={[]} label="Add documents" />}
          </div>
        }
      />
      <ChecklistView c={c} />
    </>
  );
}
