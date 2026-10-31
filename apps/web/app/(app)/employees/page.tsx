import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Department, Designation, Employee, LegalEntity, Location, Me, OnboardingTemplate, Page } from '@/lib/types';
import { EmployeesView } from './employees-view';

export const metadata: Metadata = { title: 'Employees' };

const STATUSES = ['pre_boarding', 'probation', 'active', 'notice', 'exited'];

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; departmentId?: string; cursor?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ limit: '50' });
  if (sp.q) qs.set('q', sp.q);
  if (sp.status && STATUSES.includes(sp.status)) qs.set('status', sp.status);
  if (sp.departmentId && /^[0-9a-f-]{36}$/.test(sp.departmentId)) qs.set('departmentId', sp.departmentId);
  if (sp.cursor) qs.set('cursor', sp.cursor);
  const me = await load<Me>('/me');
  const canHire = can(me, 'employees:create');
  const [page, departments, entities, locations, designations, managers, templates] = await Promise.all([
    load<Page<Employee>>(`/employees?${qs}`),
    loadOptional<Department[]>('/org/departments'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<Designation[]>('/designations'),
    canHire ? loadOptional<Page<Employee>>('/employees?limit=200') : null,
    canHire ? loadOptional<OnboardingTemplate[]>('/onboarding/templates') : null,
  ]);
  const scope = me.permissions['employees:read'];
  const note = scope === 'tenant' ? 'Everyone in the organization.' : scope === 'entity' ? 'Employees in your legal entity.' : scope === 'department' ? 'Employees in your department.' : scope === 'team' ? 'You and the people who report to you, including staff without a CREW login.' : 'Your own record.';
  return (
    <>
      <PageHeader title="Employees" description={`Employee records with job history, leave and documents. Showing: ${note}`} />
      <EmployeesView
        page={page}
        query={{ q: sp.q ?? '', status: sp.status ?? '', departmentId: sp.departmentId ?? '' }}
        departments={departments ?? []}
        entities={entities ?? []}
        locations={locations ?? []}
        designations={designations ?? []}
        managers={managers?.items ?? []}
        templates={templates ?? []}
        canHire={canHire}
      />
    </>
  );
}
