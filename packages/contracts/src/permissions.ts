/**
 * CREW permission catalogue: the single source of truth for every permission
 * checked by the API, used by the web/mobile UIs to shape navigation, and
 * rendered into docs/architecture/05-roles-and-permissions.md.
 *
 * Format: `<resource>:<action>`. A role grants a permission together with a
 * scope (ABAC) that limits which records it applies to.
 */

export const SCOPES = ['own', 'team', 'department', 'entity', 'tenant'] as const;
export type Scope = (typeof SCOPES)[number];

/** Wider scopes include narrower ones. */
export const SCOPE_RANK: Record<Scope, number> = { own: 0, team: 1, department: 2, entity: 3, tenant: 4 };

export function widestScope(a: Scope, b: Scope): Scope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

export interface PermissionDefinition {
  key: string;
  module: string;
  description: string;
  /** Phase in which the protected functionality ships. */
  phase: number;
  /** Which scopes make sense for this permission. Tenant-wide administrative permissions only allow `tenant`. */
  scopes: readonly Scope[];
  /** Environmental ABAC condition: the session must have completed MFA. */
  requiresMfa?: boolean;
  /** Marks access to highly sensitive personal data (bank, national IDs, payroll, biometrics). */
  sensitive?: boolean;
}

const ALL: readonly Scope[] = SCOPES;
const TENANT_ONLY: readonly Scope[] = ['tenant'];

export const PERMISSIONS = [
  // Phase 1: foundation
  { key: 'tenant:read', module: 'Administration', description: 'View workspace settings', phase: 1, scopes: TENANT_ONLY },
  { key: 'tenant:manage', module: 'Administration', description: 'Change workspace settings (name, locale, timezone, branding)', phase: 1, scopes: TENANT_ONLY, requiresMfa: true },
  { key: 'org:read', module: 'Organization', description: 'View legal entities, business units, locations and departments', phase: 1, scopes: TENANT_ONLY },
  { key: 'org:manage', module: 'Organization', description: 'Create and change legal entities, business units, locations and departments', phase: 1, scopes: TENANT_ONLY },
  { key: 'users:read', module: 'Administration', description: 'View workspace members', phase: 1, scopes: ALL },
  { key: 'users:invite', module: 'Administration', description: 'Invite people to the workspace', phase: 1, scopes: TENANT_ONLY },
  { key: 'users:manage', module: 'Administration', description: 'Change member placement, suspend or reactivate members', phase: 1, scopes: ['department', 'entity', 'tenant'] },
  { key: 'roles:read', module: 'Administration', description: 'View roles and role assignments', phase: 1, scopes: TENANT_ONLY },
  { key: 'roles:manage', module: 'Administration', description: 'Create custom roles and assign roles to members', phase: 1, scopes: TENANT_ONLY, requiresMfa: true },
  { key: 'audit:read', module: 'Administration', description: 'View and verify the audit trail', phase: 1, scopes: TENANT_ONLY },
  { key: 'billing:read', module: 'Billing', description: 'View subscription, invoices and usage', phase: 1, scopes: TENANT_ONLY },
  { key: 'billing:manage', module: 'Billing', description: 'Change plan, seats, billing cycle and add-ons', phase: 1, scopes: TENANT_ONLY, requiresMfa: true },

  // Phase 2: core HRMS
  { key: 'employees:read', module: 'People', description: 'View employee profiles', phase: 2, scopes: ALL },
  { key: 'employees:create', module: 'People', description: 'Create employee records', phase: 2, scopes: ['entity', 'tenant'] },
  { key: 'employees:update', module: 'People', description: 'Update employee records', phase: 2, scopes: ALL },
  { key: 'employees:sensitive:read', module: 'People', description: 'View bank, tax and national ID details', phase: 2, scopes: ALL, requiresMfa: true, sensitive: true },
  { key: 'employees:lifecycle', module: 'People', description: 'Run confirmations, transfers, promotions and exits', phase: 2, scopes: ['department', 'entity', 'tenant'] },
  { key: 'documents:read', module: 'Documents', description: 'View employee documents', phase: 2, scopes: ALL },
  { key: 'documents:manage', module: 'Documents', description: 'Upload, generate and send documents for signature', phase: 2, scopes: ALL },
  { key: 'leave:read', module: 'Leave', description: 'View leave balances and requests', phase: 2, scopes: ALL },
  { key: 'leave:request', module: 'Leave', description: 'Apply for leave', phase: 2, scopes: ['own'] },
  { key: 'leave:approve', module: 'Leave', description: 'Approve or reject leave', phase: 2, scopes: ['team', 'department', 'entity', 'tenant'] },
  { key: 'leave:configure', module: 'Leave', description: 'Configure leave types, policies and holidays', phase: 2, scopes: TENANT_ONLY },

  // Phase 3: attendance and workforce
  { key: 'attendance:read', module: 'Attendance', description: 'View attendance records', phase: 3, scopes: ALL },
  { key: 'attendance:punch', module: 'Attendance', description: 'Record own attendance', phase: 3, scopes: ['own'] },
  { key: 'attendance:correct', module: 'Attendance', description: 'Request attendance corrections', phase: 3, scopes: ALL },
  { key: 'attendance:approve', module: 'Attendance', description: 'Approve corrections and overtime', phase: 3, scopes: ['team', 'department', 'entity', 'tenant'] },
  { key: 'attendance:configure', module: 'Attendance', description: 'Configure attendance policies, geofences and locks', phase: 3, scopes: TENANT_ONLY },
  { key: 'devices:manage', module: 'Attendance', description: 'Manage biometric devices and sync agents', phase: 3, scopes: ['entity', 'tenant'] },
  { key: 'shifts:read', module: 'Scheduling', description: 'View shifts and rosters', phase: 3, scopes: ALL },
  { key: 'shifts:manage', module: 'Scheduling', description: 'Create rosters, assign and swap shifts', phase: 3, scopes: ['team', 'department', 'entity', 'tenant'] },

  // Phase 4: recruitment
  { key: 'requisitions:read', module: 'Recruitment', description: 'View job requisitions', phase: 4, scopes: ALL },
  { key: 'requisitions:create', module: 'Recruitment', description: 'Raise job requisitions', phase: 4, scopes: ['team', 'department', 'entity', 'tenant'] },
  { key: 'requisitions:approve', module: 'Recruitment', description: 'Approve job requisitions and budgets', phase: 4, scopes: ['department', 'entity', 'tenant'] },
  { key: 'candidates:read', module: 'Recruitment', description: 'View candidates and applications', phase: 4, scopes: ALL },
  { key: 'candidates:manage', module: 'Recruitment', description: 'Manage candidates, move pipeline stages, communicate', phase: 4, scopes: ['own', 'department', 'entity', 'tenant'] },
  { key: 'interviews:feedback', module: 'Recruitment', description: 'Submit interview feedback and scorecards', phase: 4, scopes: ['own'] },
  { key: 'offers:manage', module: 'Recruitment', description: 'Draft and send offers', phase: 4, scopes: ['department', 'entity', 'tenant'] },
  { key: 'offers:approve', module: 'Recruitment', description: 'Approve offers', phase: 4, scopes: ['department', 'entity', 'tenant'], requiresMfa: true },
  { key: 'recruitment:configure', module: 'Recruitment', description: 'Configure pipeline stages, scorecards and the career site', phase: 4, scopes: ['tenant'] },

  // Phase 5: payroll and finance
  { key: 'payroll:read', module: 'Payroll', description: 'View payroll runs and reports', phase: 5, scopes: ['entity', 'tenant'], sensitive: true, requiresMfa: true },
  { key: 'payroll:run', module: 'Payroll', description: 'Prepare and compute payroll runs', phase: 5, scopes: ['entity', 'tenant'], sensitive: true, requiresMfa: true },
  { key: 'payroll:approve', module: 'Payroll', description: 'Approve and finalise payroll runs', phase: 5, scopes: ['entity', 'tenant'], sensitive: true, requiresMfa: true },
  { key: 'payroll:configure', module: 'Payroll', description: 'Configure salary components, structures and statutory settings', phase: 5, scopes: TENANT_ONLY, requiresMfa: true },
  { key: 'payslips:read', module: 'Payroll', description: 'View payslips', phase: 5, scopes: ALL, sensitive: true },
  { key: 'expenses:submit', module: 'Expenses', description: 'Submit expense claims', phase: 5, scopes: ['own'] },
  { key: 'expenses:approve', module: 'Expenses', description: 'Approve expense claims', phase: 5, scopes: ['team', 'department', 'entity', 'tenant'] },

  // Phase 6: talent and employee experience
  { key: 'performance:read', module: 'Performance', description: 'View goals and reviews', phase: 6, scopes: ALL },
  { key: 'performance:manage', module: 'Performance', description: 'Set goals for, write manager reviews of and request feedback on people in scope', phase: 6, scopes: ['team', 'department', 'entity', 'tenant'] },
  { key: 'performance:configure', module: 'Performance', description: 'Run review cycles, calibrate and release ratings', phase: 6, scopes: TENANT_ONLY },
  { key: 'learning:read', module: 'Learning', description: 'View courses and learning assignments', phase: 6, scopes: ALL },
  { key: 'learning:manage', module: 'Learning', description: 'Assign courses and track completion for people in scope', phase: 6, scopes: ['team', 'department', 'entity', 'tenant'] },
  { key: 'learning:configure', module: 'Learning', description: 'Manage the course catalogue and learning paths', phase: 6, scopes: TENANT_ONLY },
  { key: 'engagement:manage', module: 'Engagement', description: 'Run surveys, see anonymous results, manage company values and moderate recognition', phase: 6, scopes: TENANT_ONLY },
  { key: 'surveys:respond', module: 'Engagement', description: 'Answer anonymous surveys', phase: 6, scopes: ['own'] },
  { key: 'recognition:give', module: 'Engagement', description: 'Recognise colleagues on the recognition wall', phase: 6, scopes: ['own'] },

  // Phase 7: employee experience
  { key: 'helpdesk:use', module: 'Helpdesk', description: 'Raise HR helpdesk cases and read help articles', phase: 7, scopes: ['own'] },
  { key: 'helpdesk:manage', module: 'Helpdesk', description: 'Handle HR helpdesk cases for people in scope', phase: 7, scopes: ['entity', 'tenant'] },
  { key: 'helpdesk:configure', module: 'Helpdesk', description: 'Manage helpdesk categories, handlers, response targets and help articles', phase: 7, scopes: TENANT_ONLY },
  { key: 'announcements:read', module: 'Announcements', description: 'Read announcements addressed to you', phase: 7, scopes: ['own'] },
  { key: 'announcements:manage', module: 'Announcements', description: 'Publish announcements and see who has read them', phase: 7, scopes: TENANT_ONLY },

  // Phase 8-9: intelligence, automation, integrations
  { key: 'reports:read', module: 'Analytics', description: 'View workforce analytics and reports', phase: 8, scopes: ALL },
  { key: 'automation:manage', module: 'Automation', description: 'Build, test and activate workflows', phase: 8, scopes: TENANT_ONLY, requiresMfa: true },
  { key: 'ai:use', module: 'AI', description: 'Use CREW AI assistants (always limited to the user\'s own permissions)', phase: 8, scopes: ['own'] },
  { key: 'ai:configure', module: 'AI', description: 'Configure AI providers, features and limits', phase: 8, scopes: TENANT_ONLY, requiresMfa: true },
  { key: 'integrations:manage', module: 'Integrations', description: 'Connect and disconnect integrations', phase: 9, scopes: TENANT_ONLY, requiresMfa: true },
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

const BY_KEY = new Map<string, PermissionDefinition>(PERMISSIONS.map((p) => [p.key, p]));

export function getPermission(key: string): PermissionDefinition | undefined {
  return BY_KEY.get(key);
}

export function isPermissionKey(key: string): key is PermissionKey {
  return BY_KEY.has(key);
}
