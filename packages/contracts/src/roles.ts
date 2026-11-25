import { CONSOLE_SYSTEM_ROLES } from './console';
import { PERMISSION_ACTIONS, PERMISSIONS, permissionAction, SCOPE_RANK, type PermissionAction, type PermissionKey, type Scope } from './permissions';

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  grants: Partial<Record<PermissionKey, Scope>>;
}

const everything = (scope: Scope = 'tenant'): Partial<Record<PermissionKey, Scope>> =>
  Object.fromEntries(
    PERMISSIONS.map((p) => [p.key, (p.scopes as readonly Scope[]).includes(scope) ? scope : p.scopes[p.scopes.length - 1]!]),
  ) as Partial<Record<PermissionKey, Scope>>;

/** Self-service grants every member receives through the Employee role. */
const EMPLOYEE_SELF: Partial<Record<PermissionKey, Scope>> = {
  'users:read': 'own',
  'employees:read': 'own',
  'employees:update': 'own',
  'employees:sensitive:read': 'own',
  'documents:read': 'own',
  'leave:read': 'own',
  'leave:request': 'own',
  'attendance:read': 'own',
  'attendance:punch': 'own',
  'attendance:correct': 'own',
  'shifts:read': 'own',
  'payslips:read': 'own',
  'expenses:submit': 'own',
  'performance:read': 'own',
  'learning:read': 'own',
  'recognition:give': 'own',
  'surveys:respond': 'own',
  'helpdesk:use': 'own',
  'announcements:read': 'own',
  'ai:use': 'own',
  'interviews:feedback': 'own',
  'assets:view': 'own',
};

const MANAGER_TEAM: Partial<Record<PermissionKey, Scope>> = {
  'users:read': 'team',
  'employees:read': 'team', 'employees:export': 'team',
  'documents:read': 'team',
  'leave:read': 'team',
  'leave:approve': 'team',
  'leave:reject': 'team',
  'attendance:read': 'team',
  'attendance:approve': 'team',
  'shifts:read': 'team',
  'shifts:manage': 'team',
  'expenses:approve': 'team',
  'performance:read': 'team',
  'performance:manage': 'team',
  'learning:read': 'team',
  'learning:manage': 'team',
  'requisitions:read': 'team',
  'requisitions:create': 'team',
  'reports:read': 'team',
  'tasks:assign': 'team',
  'assets:view': 'team',
};

/**
 * SampCrew has exactly four access categories: Console Admin (SAMPLEDGE staff, in the Console, not a workspace role)
 * and three inside each company. Every member holds Employee Workspace; Super Workspace and HR Workspace add to it.
 * What a person can actually use is then decided by the modules given to them (company > HR Workspace > person),
 * never by their job title or designation.
 */
export const ACCESS_LEVEL_ROLES = ['super_workspace', 'hr_workspace', 'employee_workspace'] as const;
export type AccessLevelRole = (typeof ACCESS_LEVEL_ROLES)[number];
export const ACCESS_LEVEL_LABEL: Record<AccessLevelRole, string> = { super_workspace: 'Super Workspace', hr_workspace: 'HR Workspace', employee_workspace: 'Employee Workspace' };

/** Super Workspace: the whole company, every setting. Same reach the old Workspace Owner had. */
const SUPER_GRANTS = everything('tenant');

const HR_WORKSPACE_EXCLUDED = new Set<string>([
  // Leave types, policies and approval rules belong to the Super Workspace; HR Workspaces allocate and approve.
  'leave:configure',
  'tenant:manage', 'roles:manage', 'billing:manage', 'hierarchy:manage', 'employees:transfer', 'modules:manage', 'mobileapp:manage',
  'integrations:manage', 'security:manage', 'ai:configure', 'audit:export',
]);

const EMPLOYEE_WORKSPACE_GRANTS = (): Partial<Record<PermissionKey, Scope>> => ({ ...EMPLOYEE_SELF, 'org:read': 'tenant', ...MANAGER_TEAM });

/**
 * What Employee Workspace gives a person nobody reports to: their own records only. The team part of Employee
 * Workspace (approving leave, schedules, reviews and so on for their reports) follows from the reporting lines, never
 * from a job title, so it applies once someone reports to them.
 */
export const EMPLOYEE_SELF_GRANTS: Readonly<Partial<Record<PermissionKey, Scope>>> = { ...EMPLOYEE_SELF };

/**
 * The built-in roles before the four access levels (kept in the database only so the change can be rolled back).
 * They are never shown, never assigned and give no access. The level each one became is LEGACY_ROLE_LEVEL.
 */
export const LEGACY_ROLE_LEVEL: Record<string, 'super' | 'hr' | 'employee'> = {
  tenant_owner: 'super', org_admin: 'super',
  hr_admin: 'hr', hr_workspace_admin: 'hr', hr_manager: 'hr', hr_executive: 'hr', recruiter: 'hr', payroll_admin: 'hr', finance_manager: 'hr', attendance_admin: 'hr',
  hiring_manager: 'hr', department_manager: 'employee', reporting_manager: 'employee', employee: 'employee', auditor: 'hr',
};

export const LEVEL_ROLE_KEY: Record<'super' | 'hr' | 'employee', AccessLevelRole> = { super: 'super_workspace', hr: 'hr_workspace', employee: 'employee_workspace' };

export const SYSTEM_ROLES: readonly RoleTemplate[] = [
  {
    key: 'super_workspace',
    name: 'Super Workspace',
    description: 'Runs the whole company in SampCrew: every setting, every person, its HR Workspaces and its subscription.',
    grants: SUPER_GRANTS,
  },
  {
    key: 'hr_workspace',
    name: 'HR Workspace',
    description: 'Looks after people: records, attendance, leave, documents, payroll, recruitment and requests, for the whole company or only the HR Workspaces named. What they use is limited by the modules given to them.',
    get grants() { return HR_WORKSPACE_GRANTS; },
  },
  {
    key: 'employee_workspace',
    name: 'Employee Workspace',
    description: 'Every person: their own profile, attendance, leave, payslips, requests and learning, and approvals for the people who report to them.',
    grants: EMPLOYEE_WORKSPACE_GRANTS(),
  },
  {
    key: 'tenant_owner',
    name: 'Workspace Owner',
    description: 'Owns the SampCrew workspace, its subscription and every setting. Cannot be removed while they are the last owner.',
    grants: everything('tenant'),
  },
  {
    key: 'org_admin',
    name: 'Organization Admin',
    description: 'Administers organisation structure, members, roles and settings. No payroll data by default.',
    grants: {
      'tenant:read': 'tenant', 'tenant:manage': 'tenant', 'org:read': 'tenant', 'org:manage': 'tenant',
      'users:read': 'tenant', 'users:invite': 'tenant', 'users:manage': 'tenant',
      'roles:read': 'tenant', 'roles:manage': 'tenant', 'audit:read': 'tenant', 'billing:read': 'tenant',
      'employees:read': 'tenant', 'employees:export': 'tenant', 'integrations:manage': 'tenant', 'automation:manage': 'tenant', 'ai:configure': 'tenant',
      'reports:read': 'tenant', 'modules:manage': 'tenant', 'fields:manage': 'tenant',
      'hierarchy:read': 'tenant', 'hierarchy:manage': 'tenant', 'employees:transfer': 'tenant', 'modules:assign': 'tenant',
    },
  },
  {
    key: 'hr_admin',
    name: 'HR Admin',
    description: 'Runs day-to-day HR operations across the organisation.',
    grants: {
      ...EMPLOYEE_SELF,
      'tenant:read': 'tenant', 'org:read': 'tenant', 'org:manage': 'tenant',
      'users:read': 'tenant', 'users:invite': 'tenant', 'users:manage': 'tenant', 'roles:read': 'tenant', 'mail:configure': 'tenant',
      'employees:read': 'tenant', 'employees:create': 'tenant', 'employees:update': 'tenant', 'employees:sensitive:read': 'tenant',
      'employees:lifecycle': 'tenant', 'documents:read': 'tenant', 'documents:manage': 'tenant',
      'leave:read': 'tenant', 'leave:approve': 'tenant', 'leave:configure': 'tenant', 'leave:allocate': 'tenant',
      'attendance:read': 'tenant', 'attendance:correct': 'tenant', 'attendance:approve': 'tenant', 'attendance:configure': 'tenant',
      'devices:manage': 'tenant', 'shifts:read': 'tenant', 'shifts:manage': 'tenant',
      'performance:read': 'tenant', 'performance:manage': 'tenant', 'performance:configure': 'tenant',
      'learning:read': 'tenant', 'learning:manage': 'tenant', 'learning:configure': 'tenant',
      'engagement:manage': 'tenant', 'helpdesk:manage': 'tenant', 'helpdesk:configure': 'tenant', 'announcements:manage': 'tenant', 'reports:read': 'tenant', 'automation:manage': 'tenant', 'insights:attrition': 'tenant',
      'requisitions:read': 'tenant', 'requisitions:approve': 'tenant', 'candidates:read': 'tenant', 'offers:approve': 'tenant', 'recruitment:configure': 'tenant',
      'privacy:manage': 'tenant', 'bids:read': 'tenant', 'bids:approve': 'tenant',
      'tasks:assign': 'tenant', 'tasks:hr': 'tenant', 'profiles:review': 'tenant',
      'fields:manage': 'tenant', 'masterdata:manage': 'tenant', 'imports:read': 'tenant', 'imports:run': 'tenant', 'employees:export': 'tenant',
      'bgv:view': 'tenant', 'bgv:create': 'tenant', 'bgv:edit': 'tenant', 'bgv:delete': 'tenant', 'bgv:approve': 'tenant', 'bgv:export': 'tenant', 'bgv:manage': 'tenant',
      'assets:view': 'tenant', 'assets:create': 'tenant', 'assets:edit': 'tenant', 'assets:delete': 'tenant', 'assets:approve': 'tenant', 'assets:export': 'tenant', 'assets:manage': 'tenant',
      'hierarchy:read': 'tenant', 'modules:assign': 'tenant',
    },
  },
  {
    key: 'hr_workspace_admin',
    name: 'HR Workspace Admin',
    description: 'Runs one or more HR Workspaces: their employees, attendance, leave, documents, tasks and requests, and which of the HR Workspace\'s modules each employee gets. Given by the Super Workspace when it names the admins of an HR Workspace, and limited to the people in it. No company-wide settings, roles, billing or payroll.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant', 'users:read': 'tenant', 'users:invite': 'tenant', 'users:manage': 'tenant',
      'employees:read': 'tenant', 'employees:export': 'tenant', 'employees:create': 'tenant', 'employees:update': 'tenant', 'employees:lifecycle': 'tenant',
      'documents:read': 'tenant', 'documents:manage': 'tenant',
      'leave:read': 'tenant', 'leave:approve': 'tenant', 'leave:allocate': 'tenant',
      'attendance:read': 'tenant', 'attendance:correct': 'tenant', 'attendance:approve': 'tenant', 'shifts:read': 'tenant', 'shifts:manage': 'tenant',
      'performance:read': 'tenant', 'performance:manage': 'tenant', 'learning:read': 'tenant', 'learning:manage': 'tenant',
      'helpdesk:manage': 'tenant', 'announcements:manage': 'tenant', 'reports:read': 'tenant',
      'tasks:assign': 'tenant', 'tasks:hr': 'tenant', 'profiles:review': 'tenant',
      'bgv:view': 'tenant', 'bgv:create': 'tenant', 'assets:view': 'tenant', 'assets:create': 'tenant', 'assets:edit': 'tenant', 'assets:approve': 'tenant',
      'hierarchy:read': 'tenant', 'modules:assign': 'tenant',
    },
  },
  {
    key: 'hr_manager',
    name: 'HR Manager',
    description: 'HR business partner for one legal entity: people, leave, attendance and talent within that entity.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant', 'users:read': 'entity', 'users:manage': 'entity',
      'employees:read': 'entity', 'employees:export': 'entity', 'employees:create': 'entity', 'employees:update': 'entity', 'employees:lifecycle': 'entity',
      'documents:read': 'entity', 'documents:manage': 'entity', 'leave:read': 'entity', 'leave:approve': 'entity',
      'attendance:read': 'entity', 'attendance:approve': 'entity', 'shifts:read': 'entity', 'shifts:manage': 'entity',
      'performance:read': 'entity', 'performance:manage': 'entity', 'learning:read': 'entity', 'learning:manage': 'entity',
      'requisitions:read': 'entity', 'requisitions:approve': 'entity', 'offers:approve': 'entity', 'reports:read': 'entity',
      'helpdesk:manage': 'entity', 'tasks:assign': 'entity', 'tasks:hr': 'entity', 'profiles:review': 'entity',
      'bgv:view': 'entity', 'bgv:create': 'entity', 'bgv:edit': 'entity', 'bgv:approve': 'entity', 'bgv:export': 'entity',
      'assets:view': 'entity', 'assets:create': 'entity', 'assets:edit': 'entity', 'assets:approve': 'entity', 'assets:export': 'entity',
    },
  },
  {
    key: 'hr_executive',
    name: 'HR Executive',
    description: 'Day-to-day HR work across the organisation: employee records, documents, background checks and assets. No approvals, settings or payroll.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant', 'users:read': 'tenant',
      'employees:read': 'tenant', 'employees:export': 'tenant', 'employees:create': 'tenant', 'employees:update': 'tenant',
      'documents:read': 'tenant', 'documents:manage': 'tenant', 'leave:read': 'tenant', 'attendance:read': 'tenant', 'shifts:read': 'tenant',
      'helpdesk:manage': 'tenant', 'tasks:hr': 'tenant',
      'bgv:view': 'tenant', 'bgv:create': 'tenant', 'bgv:edit': 'tenant',
      'assets:view': 'tenant', 'assets:create': 'tenant', 'assets:edit': 'tenant',
    },
  },
  {
    key: 'recruiter',
    name: 'Recruiter',
    description: 'Manages requisitions, candidates, interviews and offers.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant', 'users:read': 'tenant',
      'requisitions:read': 'tenant', 'requisitions:create': 'tenant', 'candidates:read': 'tenant', 'candidates:manage': 'tenant',
      'offers:manage': 'tenant', 'recruitment:configure': 'tenant', 'reports:read': 'own',
      'bids:read': 'tenant', 'bids:manage': 'tenant',
    },
  },
  {
    key: 'hiring_manager',
    name: 'Hiring Manager',
    description: 'Raises requisitions for their department and evaluates candidates.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant',
      'requisitions:read': 'department', 'requisitions:create': 'department', 'candidates:read': 'department', 'candidates:manage': 'own',
    },
  },
  {
    key: 'payroll_admin',
    name: 'Payroll Admin',
    description: 'Prepares and runs payroll; finalisation still needs an approver.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant', 'users:read': 'tenant', 'employees:read': 'tenant', 'employees:export': 'tenant', 'employees:sensitive:read': 'tenant',
      'attendance:read': 'tenant', 'leave:read': 'tenant',
      'payroll:read': 'tenant', 'payroll:run': 'tenant', 'payroll:configure': 'tenant', 'payslips:read': 'tenant',
      'expenses:approve': 'tenant', 'reports:read': 'tenant',
    },
  },
  {
    key: 'finance_manager',
    name: 'Finance Manager',
    description: 'Approves payroll and expenses, views costs and billing.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant', 'billing:read': 'tenant', 'payroll:read': 'tenant', 'payroll:approve': 'tenant',
      'expenses:approve': 'tenant', 'requisitions:read': 'tenant', 'requisitions:approve': 'tenant', 'reports:read': 'tenant',
      'bids:read': 'tenant', 'bids:approve': 'tenant',
    },
  },
  {
    key: 'attendance_admin',
    name: 'Attendance Admin',
    description: 'Configures attendance policies, devices, shifts and corrections.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant', 'users:read': 'tenant', 'employees:read': 'tenant', 'employees:export': 'tenant',
      'attendance:read': 'tenant', 'attendance:correct': 'tenant', 'attendance:approve': 'tenant', 'attendance:configure': 'tenant',
      'devices:manage': 'tenant', 'shifts:read': 'tenant', 'shifts:manage': 'tenant',
    },
  },
  {
    key: 'department_manager',
    name: 'Department Manager',
    description: 'Manages their reporting team: approvals, schedules, performance.',
    grants: { ...EMPLOYEE_SELF, 'org:read': 'tenant', ...MANAGER_TEAM },
  },
  {
    key: 'reporting_manager',
    name: 'Reporting Manager',
    description: 'Approves leave, attendance and expenses for their direct and indirect reports and sees their records. No rosters, requisitions or settings.',
    grants: {
      ...EMPLOYEE_SELF, 'org:read': 'tenant',
      'users:read': 'team', 'employees:read': 'team', 'employees:export': 'team', 'documents:read': 'team', 'leave:read': 'team', 'leave:approve': 'team',
      'attendance:read': 'team', 'attendance:approve': 'team', 'shifts:read': 'team', 'expenses:approve': 'team',
      'performance:read': 'team', 'performance:manage': 'team', 'assets:view': 'team',
    },
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Self-service for every member: profile, attendance, leave, payslips, expenses, learning, helpdesk.',
    grants: { ...EMPLOYEE_SELF },
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to configuration and the audit trail. No sensitive personal data.',
    grants: {
      'tenant:read': 'tenant', 'org:read': 'tenant', 'users:read': 'tenant', 'roles:read': 'tenant', 'audit:read': 'tenant',
      'billing:read': 'tenant', 'reports:read': 'tenant',
    },
  },
];

export type SystemRoleKey = (typeof SYSTEM_ROLES)[number]['key'];

/** Old built-in role keys: hidden everywhere and giving no access (see LEGACY_ROLE_LEVEL). */
export const RETIRED_ROLE_KEYS: ReadonlySet<string> = new Set(Object.keys(LEGACY_ROLE_LEVEL));

/** HR Workspace: everything the old HR, recruiting, hiring, payroll, finance, attendance and auditor roles held, at company scope. */
const HR_WORKSPACE_GRANTS: Partial<Record<PermissionKey, Scope>> = (() => {
  // The audit trail too (company-wide HR only, see COMPANY_HR_ONLY), which the old Auditor role read.
  const out: Partial<Record<PermissionKey, Scope>> = { ...EMPLOYEE_WORKSPACE_GRANTS(), 'audit:read': 'tenant' };
  for (const r of SYSTEM_ROLES) {
    if (LEGACY_ROLE_LEVEL[r.key] !== 'hr') continue;
    for (const k of Object.keys(r.grants) as PermissionKey[]) {
      if (HR_WORKSPACE_EXCLUDED.has(k)) continue;
      const p = PERMISSIONS.find((x) => x.key === k);
      if (p) out[k] = (p.scopes as readonly Scope[]).includes('tenant') ? 'tenant' : p.scopes[p.scopes.length - 1]!;
    }
  }
  // Simplified leave: HR Workspace approves and rejects, assigns quantities, and may manage its own leave types while
  // the Super Workspace allows it (Settings > Workspace Permissions; those switches start off).
  for (const k of ['leave:reject', 'leave:assign', 'leavetypes:create', 'leavetypes:edit', 'leavetypes:disable', 'leavetypes:visibility'] as const) out[k] = 'tenant';
  return out;
})();

/** Permissions only company-wide HR holds: an HR Workspace admin of named HR Workspaces does not see the whole company's audit trail. */
export const COMPANY_HR_ONLY: ReadonlySet<string> = new Set(['audit:read', 'masterdata:manage', 'mail:configure']);

/**
 * Permissions added after people's old roles were migrated to the levels (LevelConstraints.grants keeps exactly what
 * they had). Each follows the permission it was split from, so nobody loses what they could already do: export came
 * with reading the employee list, import came with adding employees one by one, master data with the organisation.
 */
export const SPLIT_PERMISSIONS: Record<string, string> = {
  'employees:export': 'employees:read',
  'imports:read': 'employees:create',
  'imports:run': 'employees:create',
  'masterdata:manage': 'org:manage',
  // The company's email server (issue #83): whoever could invite people company-wide sets up the mail they go out by.
  'mail:configure': 'users:invite',
};

/**
 * Limits on a Super Workspace or HR Workspace assignment (role_assignments.constraints). Besides the record limits
 * the policy engine already applies (legal entities, departments, locations, HR Workspaces):
 *  - areas: the permission modules (People, Leave, Payroll...) the person looks after in full;
 *  - viewAreas: modules the person can only view (not change or approve anything there).
 *  - areaActions: modules where only the actions named apply (view, create, edit, delete, approve, export, manage).
 * With none of them set, the level covers every area. With any set, other areas are left out.
 * These limit only what the level adds: everyone keeps their own Employee Workspace.
 */
export interface LevelConstraints {
  legalEntityIds?: string[];
  departmentIds?: string[];
  locationIds?: string[];
  hrWorkspaceIds?: string[];
  areas?: string[];
  viewAreas?: string[];
  /** Modules where only some actions apply (for example Payroll: view and approve, not run). */
  areaActions?: Record<string, PermissionAction[]>;
  /** With areas or viewAreas set: may also read the audit trail. */
  auditTrail?: boolean;
  /**
   * Exactly what the person could do before the four access levels (permission > scope), kept when they were moved
   * so that nobody gained or lost access. Set, it is the whole of what the level gives them; changing their areas on
   * People replaces it.
   */
  grants?: Record<string, Scope>;
}

const AUDIT_TRAIL = new Set(['audit:read']);

/** Permissions added after the four access levels, and the earlier ones whose holders get them too. */
const FOLLOWS: Record<string, string[]> = {
  'leave:allocate': ['leave:configure', 'leave:approve'],
  'leave:reject': ['leave:approve'],
  'leave:assign': ['leave:allocate', 'leave:configure', 'leave:approve'],
  'leavetypes:create': ['leave:allocate', 'leave:configure'],
  'leavetypes:edit': ['leave:allocate', 'leave:configure'],
  'leavetypes:disable': ['leave:allocate', 'leave:configure'],
  'leavetypes:visibility': ['leave:allocate', 'leave:configure'],
  ...Object.fromEntries(Object.entries(SPLIT_PERMISSIONS).map(([k, from]) => [k, [from]])),
};

/** Every area (permission module) a level can look after, in catalogue order. */
export const ACCESS_AREAS: readonly string[] = [...new Set(PERMISSIONS.map((p) => p.module))];

/**
 * The scope a level grant has for this assignment, or null when its limits leave it out: the person's kept grants
 * (see LevelConstraints.grants), else their areas and actions. Never wider than the level's own scope.
 */
export function levelGrantScope(permission: string, scope: Scope, c: LevelConstraints | null | undefined): Scope | null {
  if (!c) return scope;
  const p = PERMISSIONS.find((x) => x.key === permission);
  if (!p) return null;
  if (c.hrWorkspaceIds?.length && COMPANY_HR_ONLY.has(permission)) return null;
  if (c.grants) {
    // A permission added after the person's grants were kept follows the ones it was split from.
    const kept = c.grants[permission] ?? (FOLLOWS[permission] ?? []).map((k) => c.grants![k]).find(Boolean);
    if (!kept) return null;
    return SCOPE_RANK[kept] < SCOPE_RANK[scope] ? kept : scope;
  }
  if (c.areas?.length || c.viewAreas?.length || (c.areaActions && Object.keys(c.areaActions).length)) {
    if (AUDIT_TRAIL.has(permission)) return c.auditTrail ? scope : null;
    const action = permissionAction(p);
    if (c.areas?.includes(p.module)) return scope;
    if (c.viewAreas?.includes(p.module) && action === 'view') return scope;
    return c.areaActions?.[p.module]?.includes(action) ? scope : null;
  }
  return scope;
}

/** Does a level grant survive the assignment's limits (any scope)? */
export function levelGrantAllowed(permission: string, c: LevelConstraints | null | undefined): boolean {
  return levelGrantScope(permission, 'tenant', c) !== null;
}

/** The areas (and actions in them) a set of kept grants covers, for showing on People. */
export function areasOfGrants(grants: Record<string, Scope>): { area: string; actions: PermissionAction[] }[] {
  const by = new Map<string, Set<PermissionAction>>();
  for (const key of Object.keys(grants)) {
    const p = PERMISSIONS.find((x) => x.key === key);
    if (p) by.set(p.module, (by.get(p.module) ?? new Set()).add(permissionAction(p)));
  }
  return ACCESS_AREAS.filter((a) => by.has(a)).map((area) => ({ area, actions: PERMISSION_ACTIONS.filter((x) => by.get(area)!.has(x)) }));
}

export interface LegacyAssignment {
  key: string;
  isSystem: boolean;
  /** What the role held when it was migrated (role_permissions). */
  grants: { permission: string; scope: Scope }[];
  constraints?: Record<string, unknown> | null;
}

export interface AccessLevelMapping {
  level: 'super' | 'hr' | 'employee';
  /** Constraints for the Super or HR Workspace assignment (none for Employee Workspace). */
  constraints: LevelConstraints;
  /** Plain-language notes for the migration report (access the old roles gave that the level does not). */
  notes: string[];
}

const LEVEL_RANK = { employee: 0, hr: 1, super: 2 } as const;

/**
 * Maps the roles a person held before the four access levels to one level, keeping what they could do and no more:
 *  - the highest level any of their roles maps to (a custom role is HR Workspace when it gives more than Employee
 *    Workspace does, otherwise Employee Workspace);
 *  - exactly the permissions and scopes their roles gave beyond Employee Workspace (LevelConstraints.grants), unless
 *    that is everything the level gives;
 *  - the records their roles were limited to (legal entities, departments, locations or HR Workspaces).
 * Pure, so the migration and its tests use the same rules.
 */
export function mapLegacyAccess(assignments: readonly LegacyAssignment[], _member: { legalEntityId: string | null; departmentId: string | null }): AccessLevelMapping {
  const base = SYSTEM_ROLES.find((r) => r.key === 'employee_workspace')!.grants as Record<string, Scope>;
  const beyond = (g: { permission: string; scope: Scope }) => !base[g.permission] || SCOPE_RANK[g.scope] > SCOPE_RANK[base[g.permission]!];
  const levelOf = (a: LegacyAssignment): 'super' | 'hr' | 'employee' => {
    if (a.key === 'super_workspace') return 'super';
    if (a.key === 'hr_workspace') return 'hr';
    if (a.key === 'employee_workspace') return 'employee';
    if (a.isSystem && LEGACY_ROLE_LEVEL[a.key]) return LEGACY_ROLE_LEVEL[a.key]!;
    return a.grants.some(beyond) ? 'hr' : 'employee';
  };
  const notes: string[] = [];
  const classified = assignments.map((a) => ({ a, level: levelOf(a), extra: a.grants.filter(beyond) }));
  const level = classified.reduce<'super' | 'hr' | 'employee'>((top, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[top] ? c.level : top), 'employee');
  for (const c of classified) {
    if (c.level === 'employee' && c.extra.length && level === 'employee') notes.push(`${c.a.key} gave ${c.extra.map((g) => g.permission).join(', ')}, which Employee Workspace does not`);
  }
  if (level === 'employee') return { level, constraints: {}, notes };

  // Already on the new levels: keep what is there.
  const current = classified.find((c) => c.level === level && ACCESS_LEVEL_ROLES.includes(c.a.key as AccessLevelRole));
  if (current) return { level, constraints: (current.a.constraints ?? {}) as LevelConstraints, notes };

  const top = classified.filter((c) => c.level !== 'employee');
  const constraints: LevelConstraints = {};
  if (!top.some((c) => c.a.key === 'tenant_owner')) {
    // Exactly what their roles gave, at the widest scope any of them gave it. Everything is kept, not only what goes
    // beyond Employee Workspace: someone with nobody reporting to them gets only the self-service part of it.
    const template = (level === 'super' ? SUPER_GRANTS : HR_WORKSPACE_GRANTS) as Record<string, Scope>;
    const self = EMPLOYEE_SELF as Record<string, Scope>;
    const kept: Record<string, Scope> = {};
    for (const c of top) {
      for (const g of c.a.grants) {
        if (!template[g.permission]) {
          if (beyond(g)) notes.push(`${c.a.key} gave ${g.permission}, which ${level === 'super' ? 'Super' : 'HR'} Workspace does not`);
          continue;
        }
        if (!kept[g.permission] || SCOPE_RANK[g.scope] > SCOPE_RANK[kept[g.permission]!]) kept[g.permission] = g.scope;
      }
    }
    const everything = Object.entries(template).every(([k, sc]) => (self[k] && SCOPE_RANK[self[k]!] >= SCOPE_RANK[sc]) || (kept[k] && SCOPE_RANK[kept[k]!] >= SCOPE_RANK[sc]));
    if (!everything) constraints.grants = Object.fromEntries(Object.entries(kept).sort(([x], [y]) => x.localeCompare(y)));
  }
  // The records their roles were limited to (legal entities, departments, locations, HR Workspaces).
  const limits = top.map((c) => (c.a.constraints ?? {}) as LevelConstraints);
  const limitKeys = ['hrWorkspaceIds', 'legalEntityIds', 'departmentIds', 'locationIds'] as const;
  const limited = (l: LevelConstraints) => limitKeys.some((k) => l[k]?.length);
  if (limits.length && limits.every(limited)) {
    for (const key of limitKeys) {
      const ids = [...new Set(limits.flatMap((l) => l[key] ?? []))];
      if (ids.length) constraints[key] = ids;
    }
  } else if (limits.some(limited)) {
    notes.push('Some roles were limited to part of the company and others were not: the access now covers the whole company. Limit it on People if needed.');
  }
  return { level, constraints, notes };
}

/**
 * The level role a stored role key stands for: level keys as they are, old built-in keys by LEGACY_ROLE_LEVEL, and
 * anything else (a custom role) as HR Workspace. Used where a role key was saved before the levels (approval steps,
 * automation recipients, custom field rules), so they keep reaching the same people.
 */
export function levelRoleKeyFor(key: string): AccessLevelRole {
  if ((ACCESS_LEVEL_ROLES as readonly string[]).includes(key)) return key as AccessLevelRole;
  if (key === 'tenant_owner' || key === 'org_admin') return 'super_workspace';
  const legacy = LEGACY_ROLE_LEVEL[key];
  return legacy ? LEVEL_ROLE_KEY[legacy] : 'hr_workspace';
}

/** The level keys a person on a level also counts as (Super Workspace covers HR and Employee Workspace). */
export function impliedLevelKeys(level: 'super' | 'hr' | 'employee'): AccessLevelRole[] {
  return level === 'super' ? ['super_workspace', 'hr_workspace', 'employee_workspace'] : level === 'hr' ? ['hr_workspace', 'employee_workspace'] : ['employee_workspace'];
}

/** The access level a set of role keys gives (the highest one held). */
export function accessLevelOf(roleKeys: readonly string[]): 'super' | 'hr' | 'employee' {
  if (roleKeys.includes('super_workspace')) return 'super';
  if (roleKeys.includes('hr_workspace')) return 'hr';
  return 'employee';
}

/**
 * Platform (SAMPLEDGE staff) roles for the Console. Separate realm from tenant roles. These are the built-in roles
 * (console.ts CONSOLE_SYSTEM_ROLES); admins can also hold a custom role stored in platform_roles, so a role key is
 * any string at run time. The API reads a role's permissions from the database on every request.
 */
export const PLATFORM_ROLES = ['super_admin', 'admin', 'billing_ops', 'support', 'operations', 'viewer'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Built-in role permissions (the fallback when the database has no row for a built-in role yet). */
export const PLATFORM_ROLE_CAPABILITIES: Record<string, readonly string[]> = Object.fromEntries(CONSOLE_SYSTEM_ROLES.map((r) => [r.key, r.permissions]));
