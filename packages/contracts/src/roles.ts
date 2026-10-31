import { PERMISSIONS, type PermissionKey, type Scope } from './permissions';

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
  'helpdesk:use': 'own',
  'ai:use': 'own',
  'interviews:feedback': 'own',
};

const MANAGER_TEAM: Partial<Record<PermissionKey, Scope>> = {
  'users:read': 'team',
  'employees:read': 'team',
  'documents:read': 'team',
  'leave:read': 'team',
  'leave:approve': 'team',
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
};

export const SYSTEM_ROLES: readonly RoleTemplate[] = [
  {
    key: 'tenant_owner',
    name: 'Tenant Owner',
    description: 'Owns the CREW workspace, its subscription and every setting. Cannot be removed while they are the last owner.',
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
      'employees:read': 'tenant', 'integrations:manage': 'tenant', 'automation:manage': 'tenant', 'ai:configure': 'tenant',
      'reports:read': 'tenant',
    },
  },
  {
    key: 'hr_admin',
    name: 'HR Admin',
    description: 'Runs day-to-day HR operations across the organisation.',
    grants: {
      ...EMPLOYEE_SELF,
      'tenant:read': 'tenant', 'org:read': 'tenant', 'org:manage': 'tenant',
      'users:read': 'tenant', 'users:invite': 'tenant', 'users:manage': 'tenant', 'roles:read': 'tenant',
      'employees:read': 'tenant', 'employees:create': 'tenant', 'employees:update': 'tenant', 'employees:sensitive:read': 'tenant',
      'employees:lifecycle': 'tenant', 'documents:read': 'tenant', 'documents:manage': 'tenant',
      'leave:read': 'tenant', 'leave:approve': 'tenant', 'leave:configure': 'tenant',
      'attendance:read': 'tenant', 'attendance:approve': 'tenant', 'attendance:configure': 'tenant',
      'shifts:read': 'tenant', 'shifts:manage': 'tenant',
      'performance:read': 'tenant', 'performance:manage': 'tenant', 'learning:read': 'tenant', 'learning:manage': 'tenant',
      'engagement:manage': 'tenant', 'helpdesk:manage': 'tenant', 'reports:read': 'tenant', 'automation:manage': 'tenant',
    },
  },
  {
    key: 'hr_manager',
    name: 'HR Manager',
    description: 'HR business partner for one legal entity: people, leave, attendance and talent within that entity.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant', 'users:read': 'entity', 'users:manage': 'entity',
      'employees:read': 'entity', 'employees:create': 'entity', 'employees:update': 'entity', 'employees:lifecycle': 'entity',
      'documents:read': 'entity', 'documents:manage': 'entity', 'leave:read': 'entity', 'leave:approve': 'entity',
      'attendance:read': 'entity', 'attendance:approve': 'entity', 'shifts:read': 'entity', 'shifts:manage': 'entity',
      'performance:read': 'entity', 'performance:manage': 'entity', 'learning:read': 'entity', 'learning:manage': 'entity',
      'requisitions:read': 'entity', 'requisitions:approve': 'entity', 'offers:approve': 'entity', 'reports:read': 'entity',
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
      'offers:manage': 'tenant', 'reports:read': 'own',
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
      'org:read': 'tenant', 'users:read': 'tenant', 'employees:read': 'tenant', 'employees:sensitive:read': 'tenant',
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
    },
  },
  {
    key: 'attendance_admin',
    name: 'Attendance Admin',
    description: 'Configures attendance policies, devices, shifts and corrections.',
    grants: {
      ...EMPLOYEE_SELF,
      'org:read': 'tenant', 'users:read': 'tenant', 'employees:read': 'tenant',
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

/** Platform (SAMPLEDGE staff) roles for the Super Admin Console. Separate realm from tenant roles. */
export const PLATFORM_ROLES = ['super_admin', 'support', 'billing_ops', 'viewer'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_ROLE_CAPABILITIES: Record<PlatformRole, readonly string[]> = {
  super_admin: ['tenants:read', 'tenants:manage', 'billing:read', 'billing:manage', 'plans:manage', 'support:request', 'admins:manage', 'audit:read', 'health:read'],
  support: ['tenants:read', 'support:request', 'health:read', 'audit:read'],
  billing_ops: ['tenants:read', 'billing:read', 'billing:manage', 'plans:manage'],
  viewer: ['tenants:read', 'billing:read', 'health:read'],
};
