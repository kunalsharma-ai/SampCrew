import { EMPLOYEE_COLUMNS_CATALOGUE, EMPLOYEE_SORTS, type SavedView, type ViewState } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { can } from '@/lib/nav';
import type { Department, Designation, Employee, LegalEntity, Location, Me, OnboardingTemplate, Page } from '@/lib/types';
import type { Structure } from '../payroll/types';
import { type EmployeeDraft, EmployeesView } from './employees-view';
import { DEFAULT_COLUMNS, viewUrl } from './view-url';

export const metadata: Metadata = { title: 'Employees' };

const STATUSES = ['pre_boarding', 'probation', 'active', 'notice', 'exited'];
type Search = { q?: string; status?: string; departmentId?: string; cursor?: string; sort?: string; dir?: string; cols?: string; density?: string; view?: string };

/** The table state lives in the address bar, so a view can be bookmarked, shared and restored after a reload. */
function stateFrom(sp: Search): ViewState {
  const filters: Record<string, string> = {};
  if (sp.q) filters.q = sp.q.slice(0, 200);
  if (sp.status && STATUSES.includes(sp.status)) filters.status = sp.status;
  if (sp.departmentId && /^[0-9a-f-]{36}$/.test(sp.departmentId)) filters.departmentId = sp.departmentId;
  const cols = (sp.cols ?? '').split(',').filter((c) => (EMPLOYEE_COLUMNS_CATALOGUE as readonly string[]).includes(c));
  return {
    filters,
    sort: (EMPLOYEE_SORTS as readonly string[]).includes(sp.sort ?? '') ? sp.sort : 'name',
    dir: sp.dir === 'desc' ? 'desc' : 'asc',
    columns: cols.length ? (cols.includes('name') ? cols : ['name', ...cols]) : DEFAULT_COLUMNS,
    density: sp.density === 'compact' ? 'compact' : 'comfortable',
  };
}

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  const views = (await loadOptional<SavedView[]>('/me/views?page=employees')) ?? [];
  // Opening the list with nothing chosen opens the person's default view, if they have one.
  const def = views.find((v) => v.isDefault);
  if (def && Object.keys(sp).length === 0) redirect(viewUrl(def.state, def.id));

  const state = stateFrom(sp);
  const qs = new URLSearchParams({ limit: '50', sort: state.sort!, dir: state.dir! });
  for (const [k, v] of Object.entries(state.filters)) qs.set(k, v);
  if (sp.cursor) qs.set('cursor', sp.cursor.slice(0, 200));

  const canHire = can(me, 'employees:create');
  const canPay = can(me, 'payroll:run');
  const canDocs = can(me, 'documents:manage');
  const [page, departments, entities, locations, designations, managers, templates, drafts, structures] = await Promise.all([
    load<Page<Employee> & { total?: number }>(`/employees?${qs}`),
    loadOptional<Department[]>('/org/departments'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<Designation[]>('/designations'),
    canHire ? loadOptional<Page<Employee>>('/employees?limit=200') : null,
    canHire ? loadOptional<OnboardingTemplate[]>('/onboarding/templates') : null,
    canHire ? loadOptional<EmployeeDraft[]>('/employees/drafts') : null,
    canHire && canPay ? loadOptional<Structure[]>('/payroll/structures') : null,
  ]);
  const scope = me.permissions['employees:read'];
  const note = scope === 'tenant' ? 'Everyone in the organization.' : scope === 'entity' ? 'Employees in your legal entity.' : scope === 'department' ? 'Employees in your department.' : scope === 'team' ? 'You and the people who report to you, including staff without a CREW login.' : 'Your own record.';
  const activeView = sp.view && views.some((v) => v.id === sp.view) ? sp.view : null;
  return (
    <>
      <PageHeader title="Employees" description={`Employee records with job history, leave and documents. Showing: ${note}`} />
      <ModuleOverview module="employees" actions={allowed(me, [
        { label: 'Add employee', href: '/employees?create=employee', icon: 'user-plus', permission: 'employees:create' },
        { label: 'Structure', href: '/organization', icon: 'building', permission: 'org:read' },
        { label: 'Onboarding checklists', href: '/settings/onboarding', icon: 'list-checks', permission: 'employees:create' },
        { label: 'Logins & access', href: '/people', icon: 'users', permission: 'users:read' },
        { label: 'Workforce Universe', href: '/insights/universe', icon: 'orbit', permission: 'employees:read', feature: 'workforce_universe' },
      ])} />
      <EmployeesView
        page={page}
        state={state}
        cursor={sp.cursor ?? null}
        views={views}
        activeViewId={activeView}
        departments={departments ?? []}
        entities={entities ?? []}
        locations={locations ?? []}
        designations={designations ?? []}
        managers={managers?.items ?? []}
        templates={templates ?? []}
        drafts={drafts ?? []}
        structures={(structures ?? []).filter((s) => !s.archivedAt)}
        canHire={canHire}
        canPay={canPay}
        canDocs={canDocs}
      />
    </>
  );
}
