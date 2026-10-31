import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import type { SalaryRevision, Structure } from '../../types';
import { SalaryView } from './salary-view';

export const metadata: Metadata = { title: 'Salary' };

export default async function SalaryPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const { employeeId } = await params;
  const [me, data, structures] = await Promise.all([
    load<Me>('/me'),
    load<{ employee: { id: string; name: string; code: string }; revisions: SalaryRevision[] }>(`/payroll/salaries/${employeeId}`),
    load<Structure[]>('/payroll/structures'),
  ]);
  return (
    <>
      <PageHeader
        eyebrow={<span className="font-mono">{data.employee.code}</span>}
        title={data.employee.name}
        description="Salary revisions, newest first. Each revision keeps the breakdown it was given, so later structure changes never rewrite history."
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/payroll/salaries">All salaries</Link>}
      />
      <SalaryView employeeId={employeeId} revisions={data.revisions} structures={structures.filter((s) => !s.archivedAt)} canEdit={Boolean(me.permissions['payroll:run'])} />
    </>
  );
}
