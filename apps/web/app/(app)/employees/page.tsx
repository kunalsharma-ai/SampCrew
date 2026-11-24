import { type CustomFieldDefinition, EMPLOYEE_COLUMNS_CATALOGUE, EMPLOYEE_SORTS, type SavedView, type ViewState, type WorkspaceLimits, workspaceLimitMessage } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { AssetList } from '../assets/types';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { can } from '@/lib/nav';
import type { Department, Designation, Employee, LegalEntity, Location, Me, OnboardingTemplate, Page } from '@/lib/types';
import type { Structure } from '../payroll/types';
import { type EmployeeDraft, EmployeesView } from './employees-view';
import type { LeavePolicyOption } from './hire-wizard';
import type { LeaveType } from '@/lib/types';

/** Active leave types that keep a quantity (not work from home), one row per legal entity they are limited to (or one for everyone), for opening balances. */
const openingOptions = (types: LeaveType[]): LeavePolicyOption[] => types
  .filter((t) => t.active && t.kind !== 'wfh' && t.visibility !== 'hr')
  .flatMap((t) => (t.eligibility.legalEntityIds.length ? t.eligibility.legalEntityIds : [null]).map((legalEntityId) => ({ leaveTypeId: t.id, leaveTypeName: t.name, legalEntityId, accrualMethod: t.policy.accrualMethod, typeArchived: false, paid: t.paid, monthlyCredit: t.monthlyCredit ?? null })));
import type { DeviceOption, ShiftOption } from './[id]/profile-extras';
import { DEFAULT_COLUMNS, viewUrl } from './view-url';

export const metadata: Metadata = { title: 'Employees' };

const BULK_TYPES: string[] = ['short_text', 'number', 'decimal', 'date', 'dropdown', 'radio', 'yes_no', 'email', 'phone', 'url', 'currency'];
const STATUSES = ['pre_boarding', 'probation', 'active', 'notice', 'exited'];
type Search = { create?: string; q?: string; status?: string; departmentId?: string; importId?: string; cursor?: string; sort?: string; dir?: string; cols?: string; density?: string; view?: string };

/** The table state lives in the address bar, so a view can be bookmarked, shared and restored after a reload. */
function stateFrom(sp: Search): ViewState {
  const filters: Record<string, string> = {};
  if (sp.q) filters.q = sp.q.slice(0, 200);
  if (sp.status && STATUSES.includes(sp.status)) filters.status = sp.status;
  if (sp.departmentId && /^[0-9a-f-]{36}$/.test(sp.departmentId)) filters.departmentId = sp.departmentId;
  if (sp.importId && /^[0-9a-f-]{36}$/.test(sp.importId)) filters.importId = sp.importId;
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
  const canAttendance = me.features.includes('attendance_basic');
  const canOpenBalances = canHire && me.features.includes('leave') && can(me, 'leave:approve');
  const canHandOver = canHire && me.features.includes('asset_management') && can(me, 'assets:create');
  const [page, departments, entities, locations, designations, managers, templates, drafts, structures, shifts, devices, policies, freeAssets, spaces, limits] = await Promise.all([
    load<Page<Employee> & { total?: number }>(`/employees?${qs}`),
    loadOptional<Department[]>('/org/departments'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<Designation[]>('/designations'),
    canHire ? loadOptional<Page<Employee>>('/employees?limit=200') : null,
    canHire && me.features.includes('onboarding') ? loadOptional<OnboardingTemplate[]>('/onboarding/templates') : null,
    canHire ? loadOptional<EmployeeDraft[]>('/employees/drafts') : null,
    canHire && canPay ? loadOptional<Structure[]>('/payroll/structures') : null,
    canHire && canAttendance ? loadOptional<ShiftOption[]>('/shifts/templates') : null,
    canHire && canAttendance && can(me, 'devices:manage') ? loadOptional<DeviceOption[]>('/attendance/devices') : null,
    canOpenBalances ? loadOptional<LeaveType[]>('/leave/types') : null,
    canHandOver ? loadOptional<AssetList>('/assets?status=available&limit=500') : null,
    canHire && can(me, 'hierarchy:read') ? loadOptional<{ items: { id: string; name: string }[] }>('/hr-workspaces?status=active') : null,
    canHire ? loadOptional<WorkspaceLimits>('/workspace-limits') : null,
  ]);
  // Bulk changes: for people who change others' records (not only their own).
  const beyondOwn = (perm: string) => !!me.permissions[perm] && me.permissions[perm] !== 'own';
  const canMove = beyondOwn('employees:lifecycle');
  const canFields = beyondOwn('employees:update');
  const bulkFields = canFields ? ((await loadOptional<CustomFieldDefinition[]>('/custom-fields?entity=employee')) ?? []).filter((f) => f.enabled && !f.archivedAt && BULK_TYPES.includes(f.type)) : [];
  const loginsFull = limits?.employee.reached && limits.employee.limit !== null ? workspaceLimitMessage('employee', limits.employee.used, limits.employee.limit) : null;
  // Company-wide admins choose the central group or an HR Workspace; an HR Workspace admin only their own.
  const centralChoice = me.levels.super || me.levels.companyHr;
  const hrWorkspaces = spaces && (spaces.items.length || !centralChoice) ? { options: spaces.items.map((w) => ({ id: w.id, name: w.name })), central: centralChoice } : null;
  // A new workspace finishes company setup before its first hire; admins are sent there from Add employee.
  const setupPending = !me.tenant.setupCompletedAt;
  const canManageOrg = can(me, 'org:manage');
  if (setupPending && canManageOrg && sp.create === 'employee') redirect('/setup');
  const scope = me.permissions['employees:read'];
  const note = scope === 'tenant' ? 'Everyone in the organization.' : scope === 'entity' ? 'Employees in your legal entity.' : scope === 'department' ? 'Employees in your department.' : scope === 'team' ? 'You and the people who report to you, including staff without a SampCrew login.' : 'Your own record.';
  const activeView = sp.view && views.some((v) => v.id === sp.view) ? sp.view : null;
  return (
    <>
      <PageHeader title="Employees" description={`Employee records with job history, leave and documents. Showing: ${note}`} />
      <ModuleOverview module="employees" actions={allowed(me, [
        { label: 'Add employee', href: '/employees?create=employee', icon: 'user-plus', permission: 'employees:create' },
        { label: 'Structure', href: '/organization', icon: 'building', permission: 'org:read' },
        { label: 'Import existing employees', href: '/imports/new?type=employees', icon: 'upload', permission: 'imports:run', feature: 'data_import' },
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
        bulk={canMove || canFields ? { canMove, canFields, fields: bulkFields } : null}
        canPay={canPay}
        canDocs={canDocs}
        shifts={shifts}
        devices={devices}
        hrWorkspaces={hrWorkspaces}
        loginsFull={loginsFull}
        accessChoice={can(me, 'roles:manage') ? { canGiveSuper: me.levels.super, hrWorkspaces: spaces?.items.map((w) => ({ id: w.id, name: w.name })) ?? [] } : null}
        canManageOrg={canManageOrg}
        canAttendance={canAttendance}
        canConfigureShifts={canAttendance && can(me, 'attendance:configure')}
        leavePolicies={canOpenBalances ? openingOptions(policies ?? []) : null}
        availableAssets={canHandOver ? (freeAssets?.items ?? []).map((a) => ({ id: a.id, assetCode: a.assetCode, name: a.name, category: a.category })) : null}
        setupPending={setupPending}
      />
    </>
  );
}
