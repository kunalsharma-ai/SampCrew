import { z } from 'zod';
import { CENTRAL_GROUP, EMPLOYEE_LEVEL_PERMISSIONS, HR_LEVEL_PERMISSIONS } from './attendance-overview';
import { PERMISSIONS } from './permissions';
import { SYSTEM_ROLES } from './roles';

/**
 * Settings > Workspace Permissions: one place where the Super Workspace decides what HR Workspace and Employee
 * Workspace people may do, grouped by category, with Select all per category and default templates.
 *
 * Every switch maps onto what the API already checks, so switching one off is enforced on the server:
 *  - `permissions`: catalogue permissions (permissions.ts). Off, they are taken out of the level's grants when a
 *    person's access is loaded for each request (loadSubject), so the API refuses them and /me stops offering them.
 *  - `routes`: API routes with no permission of their own (creating a department, for example). Off, the API refuses
 *    them for people of that level.
 *  - neither: a setting a module reads itself (attendance: view other HR Workspaces, export) or one that is always on
 *    (`locked`, shown so the page is complete).
 *
 * A level can never get more than its access level gives it: the switches only take away. HR Workspace switches are
 * saved per HR Workspace (or "central" for company-wide HR people), Employee Workspace switches for every Employee
 * Workspace ("all"), in the level_permissions collection, next to the attendance settings that live there already. A
 * switch not saved has its default, so nothing changes for a workspace until someone saves.
 */

export const WORKSPACE_PERMISSION_LEVELS = ['hr', 'employee'] as const;
export type WorkspacePermissionLevel = (typeof WORKSPACE_PERMISSION_LEVELS)[number];
export const WORKSPACE_PERMISSION_LEVEL_LABEL: Record<WorkspacePermissionLevel, string> = { hr: 'HR Workspace', employee: 'Employee Workspace' };

export interface WorkspacePermissionRoute {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** An API path below /api/v1, with * for one id segment. */
  path: string;
}

export interface WorkspacePermissionItem {
  key: string;
  label: string;
  description: string;
  permissions: readonly string[];
  routes?: readonly WorkspacePermissionRoute[];
  /** On when nothing is saved (and in the default template). */
  default: boolean;
  /** Always on: follows from the level itself. Shown, never switchable. */
  locked?: boolean;
}

export interface WorkspacePermissionCategory {
  key: string;
  label: string;
  description: string;
  /** The module the category belongs to: while it is off for the level, the category has no effect and says so. */
  feature: string | null;
  items: readonly WorkspacePermissionItem[];
}

const item = (key: string, label: string, description: string, permissions: string[], opts: Partial<Pick<WorkspacePermissionItem, 'default' | 'locked' | 'routes'>> = {}): WorkspacePermissionItem => ({
  key, label, description, permissions, default: opts.default ?? true, ...(opts.locked ? { locked: true } : {}), ...(opts.routes ? { routes: opts.routes } : {}),
});

/** Settings modules already read on their own (attendance), folded in so there is one page for all of it. */
const attendanceFlags = (defs: readonly { key: string; label: string; description: string; default: boolean; locked: boolean }[]) =>
  defs.map((d) => item(d.key, d.label, d.description, [], { default: d.default, locked: d.locked }));

const HR_CURATED: WorkspacePermissionCategory[] = [
  {
    key: 'employee_management', label: 'Employee Management', feature: null,
    description: 'The employee records this HR Workspace looks after.',
    items: [
      item('employees.view', 'View employees', 'See the profiles of the people this HR Workspace looks after. An HR Workspace exists to look after its people, so this stays on.', ['employees:read'], { locked: true }),
      item('employees.create', 'Create employees', 'Add employee records (the hire form).', ['employees:create']),
      item('employees.edit', 'Edit employees', 'Change employee records.', ['employees:update']),
      item('employees.delete', 'Delete or exit employees', 'Run exits, confirmations, promotions and transfers inside the HR Workspace.', ['employees:lifecycle']),
      item('employees.profiles', 'Manage employee profiles', 'Review the profile changes employees submit: approve, reject or ask for more.', ['profiles:review']),
      item('employees.sensitive', 'View bank, tax and ID details', 'Sensitive personal data (needs two-step verification).', ['employees:sensitive:read']),
      item('employees.import', 'Import employee data', 'Bring employees in from Excel or CSV and see the import history.', ['imports:run', 'imports:read']),
      item('employees.export', 'Export employee data', 'Download the employee list as CSV or Excel.', ['employees:export']),
    ],
  },
  {
    key: 'leave_management', label: 'Leave Management', feature: 'leave',
    description: 'Leave types, applications and manually assigned quantities.',
    items: [
      item('leave.view', 'View Leave Management and applications', 'Open Leave Management and see the leave applications of the people this HR Workspace looks after.', ['leave:read']),
      item('leave.create_types', 'Create leave types', 'Allow HR Workspace to create its own leave types, visible only inside what the Super Workspace gave it.', ['leavetypes:create'], { default: false }),
      item('leave.edit_types', 'Edit leave types', 'Change the name, description and code of the leave types this HR Workspace created.', ['leavetypes:edit'], { default: false }),
      item('leave.disable_types', 'Disable leave types', 'Switch its own leave types off for new applications (history stays).', ['leavetypes:disable'], { default: false }),
      item('leave.visibility', 'Manage leave visibility', 'Choose where its own leave types appear (HR Workspace, Employee Workspace or both), never beyond its modules.', ['leavetypes:visibility'], { default: false }),
      item('leave.approve', 'Approve leave', 'Approve leave applications that come to this HR Workspace.', ['leave:approve']),
      item('leave.reject', 'Reject leave', 'Reject leave applications that come to this HR Workspace.', ['leave:reject']),
      item('leave.assign', 'Assign manual leave quantities', 'Type in how many days of a leave type an employee has for a year. Nothing is ever calculated.', ['leave:assign']),
      item('leave.calendars', 'Holiday calendars and leave reports', 'Manage holiday calendars and see leave reports.', ['leave:allocate']),
    ],
  },
  {
    key: 'attendance_management', label: 'Attendance Management', feature: 'attendance_basic',
    description: 'Attendance records, corrections and settings.',
    items: [
      item('attendance.view', 'View attendance', 'See the attendance of the people this HR Workspace looks after.', ['attendance:read']),
      item('attendance.edit', 'Mark and edit attendance', 'Mark attendance and correct attendance records.', ['attendance:correct']),
      item('attendance.approve', 'Approve attendance corrections', 'Approve correction and overtime requests.', ['attendance:approve']),
      item('attendance.manage', 'Manage attendance records and settings', 'Attendance policies, geofences, locks and devices.', ['attendance:configure', 'devices:manage']),
      ...attendanceFlags(HR_LEVEL_PERMISSIONS),
    ],
  },
  {
    key: 'department_management', label: 'Department Management', feature: null,
    description: 'The department structure of the company.',
    items: [
      item('departments.view', 'View departments', 'See departments, locations and legal entities. Many screens need them, so this stays on.', ['org:read'], { locked: true }),
      item('departments.create', 'Create departments', 'Add departments.', [], { routes: [{ method: 'POST', path: '/org/departments' }] }),
      item('departments.edit', 'Edit departments', 'Rename and move departments.', [], { routes: [{ method: 'PATCH', path: '/org/departments/*' }] }),
      item('departments.delete', 'Delete departments', 'Remove departments nobody is in.', [], { routes: [{ method: 'DELETE', path: '/org/departments/*' }] }),
      item('organization.manage', 'Manage locations and legal entities', 'Add and change locations, business units and legal entities.', [], {
        routes: ['legal-entities', 'business-units', 'locations'].flatMap((r) => [{ method: 'POST' as const, path: `/org/${r}` }, { method: 'PATCH' as const, path: `/org/${r}/*` }, { method: 'DELETE' as const, path: `/org/${r}/*` }]),
      }),
    ],
  },
  {
    key: 'reports_analytics', label: 'Reports and Analytics', feature: null,
    description: 'Workforce reports, analytics and the audit trail.',
    items: [
      item('reports.view', 'View reports and analytics', 'Workforce analytics and reports for the people in scope.', ['reports:read']),
      item('reports.attrition', 'View attrition analytics', 'Attrition risk scores and their factors.', ['insights:attrition']),
      item('reports.audit', 'View the audit trail', 'Company-wide HR only.', ['audit:read']),
    ],
  },
  {
    key: 'workspace_management', label: 'Workspace Management', feature: null,
    description: 'Users and modules inside the HR Workspace. Creating HR Workspaces stays with the Super Workspace.',
    items: [
      item('workspace.view', 'View workspaces', 'See the HR Workspaces of the company and their modules.', ['hierarchy:read']),
      item('workspace.users', 'Manage workspace users', 'Change placement, suspend or reactivate the people it looks after.', ['users:manage']),
      item('workspace.invite', 'Invite users', 'Invite people to sign in.', ['users:invite']),
      item('workspace.modules', 'Enable or disable modules for employees', "Choose which of the HR Workspace's modules each employee gets.", ['modules:assign']),
    ],
  },
  {
    key: 'settings_management', label: 'Settings Management', feature: null,
    description: 'Settings this HR Workspace may change.',
    items: [
      item('settings.general', 'View workspace settings', 'Read the company settings (name, time zone, branding).', ['tenant:read'], { locked: true }),
      item('settings.fields', 'Custom fields', 'Add and change custom fields on forms.', ['fields:manage']),
      item('settings.masterdata', 'Master data', 'Dropdown values such as job titles and skills.', ['masterdata:manage']),
    ],
  },
];

const EMPLOYEE_CURATED: WorkspacePermissionCategory[] = [
  {
    key: 'personal', label: 'Personal Dashboard and Profile', feature: null,
    description: 'What every employee sees about themselves.',
    items: [
      item('personal.dashboard', 'Personal dashboard', 'Their own Home page.', [], { locked: true }),
      item('personal.notifications', 'Notifications', 'Their notifications and notification settings.', [], { locked: true }),
      item('profile.view', 'View own profile', 'Their employee profile.', ['employees:read']),
      item('profile.edit', 'Edit own profile', 'Send profile changes for review.', ['employees:update']),
      item('profile.sensitive', 'View own bank, tax and ID details', 'Their own sensitive details.', ['employees:sensitive:read']),
      item('profile.documents', 'View own documents', 'Their letters and documents.', ['documents:read']),
    ],
  },
  {
    key: 'leave_management', label: 'Leave Management', feature: 'leave',
    description: 'Applying for leave and seeing their own applications.',
    items: [
      item('leave.view', 'Leave history', 'Open Leave Management, see their leave types, applications and history.', ['leave:read']),
      item('leave.apply', 'Apply for leave', 'Submit leave applications for the leave types visible to Employee Workspace.', ['leave:request']),
    ],
  },
  {
    key: 'attendance_management', label: 'Attendance Management', feature: 'attendance_basic',
    description: 'Their own attendance.',
    items: [
      item('attendance.view', 'View own attendance', 'Their attendance calendar and records.', ['attendance:read']),
      item('attendance.mark', 'Mark attendance', 'Punch in and out.', ['attendance:punch']),
      item('attendance.correct', 'Request attendance corrections', 'Ask for a correction of their own attendance.', ['attendance:correct']),
      ...attendanceFlags(EMPLOYEE_LEVEL_PERMISSIONS),
    ],
  },
];

/** Catalogue modules and the plan feature they belong to, for the categories built from the rest of the catalogue. */
const MODULE_FEATURE: Record<string, string | null> = {
  Recruitment: 'recruitment', Payroll: 'payroll', Expenses: 'expenses', Performance: 'performance', Learning: 'learning',
  Engagement: 'engagement', Helpdesk: 'helpdesk', Announcements: 'announcements', Documents: 'documents', Scheduling: 'shift_scheduling',
  'Background verification': 'background_verification', Assets: 'asset_management', 'Staffing bids': 'staffing_bids', AI: 'ai_copilot',
  Automation: 'automation', 'Data import': 'data_import', Analytics: 'workforce_analytics', Billing: null, People: null, Administration: null,
  Organization: null, Leave: 'leave', Attendance: 'attendance_basic',
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Curated categories first, then one category per remaining catalogue module the level's access gives, one switch per
 * permission, so every permission the level holds can be switched here and nothing is missing.
 */
function build(curated: WorkspacePermissionCategory[], roleKey: string): WorkspacePermissionCategory[] {
  const grants = Object.keys(SYSTEM_ROLES.find((r) => r.key === roleKey)?.grants ?? {});
  const covered = new Set(curated.flatMap((c) => c.items.flatMap((i) => i.permissions)));
  const rest = new Map<string, WorkspacePermissionItem[]>();
  for (const p of PERMISSIONS) {
    if (!grants.includes(p.key) || covered.has(p.key)) continue;
    const list = rest.get(p.module) ?? [];
    list.push(item(`perm.${p.key}`, p.description, p.key, [p.key]));
    rest.set(p.module, list);
  }
  const more = [...rest.entries()].map(([module, items]): WorkspacePermissionCategory => ({
    key: `module_${slug(module)}`, label: module, description: `${module}: one switch for each thing the level can do there.`, feature: MODULE_FEATURE[module] ?? null, items,
  }));
  return [...curated, ...more];
}

let cache: Record<WorkspacePermissionLevel, WorkspacePermissionCategory[]> | null = null;

/** The categories of a level, in page order. */
export function workspacePermissionCategories(level: WorkspacePermissionLevel): readonly WorkspacePermissionCategory[] {
  cache ??= { hr: build(HR_CURATED, 'hr_workspace'), employee: build(EMPLOYEE_CURATED, 'employee_workspace') };
  return cache[level];
}

export function workspacePermissionItems(level: WorkspacePermissionLevel): readonly WorkspacePermissionItem[] {
  return workspacePermissionCategories(level).flatMap((c) => c.items);
}

/** A switch's value from what is saved; locked ones are always their default. */
export function workspacePermissionOn(it: Pick<WorkspacePermissionItem, 'default' | 'locked' | 'key'>, saved: Record<string, unknown> | null | undefined): boolean {
  if (it.locked) return it.default;
  const v = saved?.[it.key];
  return typeof v === 'boolean' ? v : it.default;
}

/**
 * What the saved switches take away for a level: catalogue permissions and routes. With several saved sets (an HR
 * Workspace admin of two HR Workspaces), a permission is taken away only when it is off in all of them.
 */
export function workspacePermissionsOff(level: WorkspacePermissionLevel, saved: readonly (Record<string, unknown> | null | undefined)[]): { permissions: Set<string>; routes: WorkspacePermissionRoute[] } {
  const sets = saved.length ? saved : [null];
  const permissions = new Set<string>();
  const routes: WorkspacePermissionRoute[] = [];
  for (const it of workspacePermissionItems(level)) {
    if (sets.some((s) => workspacePermissionOn(it, s))) continue;
    it.permissions.forEach((p) => permissions.add(p));
    routes.push(...(it.routes ?? []));
  }
  return { permissions, routes };
}

/** Does a request match one of the routes (path below /api/v1, * matches one segment)? */
export function routeMatches(routes: readonly WorkspacePermissionRoute[], path: string, method: string): boolean {
  const norm = (p: string) => p.split('?')[0]!.replace(/^\/+|\/+$/g, '');
  const parts = norm(path).split('/');
  return routes.some((r) => {
    if (r.method !== method.toUpperCase()) return false;
    const want = norm(r.path).split('/');
    return want.length === parts.length && want.every((w, i) => w === '*' || w === parts[i]);
  });
}

// -------------------------------------------------------------------------------------------------------------
// Templates
// -------------------------------------------------------------------------------------------------------------

/**
 * Templates fill the switches in one click (when an HR Workspace is created, or on the page). The two defaults are
 * editable (saved in level_permissions with subject_type hr_template / employee_template, subject_id "default");
 * "all" switches on everything the level can have, "custom" leaves the switches as they are.
 */
export const PERMISSION_TEMPLATE_KEYS = ['hr_default', 'employee_default', 'all', 'custom'] as const;
export type PermissionTemplateKey = (typeof PERMISSION_TEMPLATE_KEYS)[number];
export const PERMISSION_TEMPLATE_LABEL: Record<PermissionTemplateKey, string> = {
  hr_default: 'Default HR template', employee_default: 'Default Employee template', all: 'All permitted permissions', custom: 'Custom permissions',
};
export const TEMPLATE_LEVEL: Record<'hr_default' | 'employee_default', WorkspacePermissionLevel> = { hr_default: 'hr', employee_default: 'employee' };

/** The switches of a template for a level: its saved values over the registry defaults. */
export function templatePermissions(level: WorkspacePermissionLevel, template: 'default' | 'all', saved?: Record<string, unknown> | null): Record<string, boolean> {
  return Object.fromEntries(workspacePermissionItems(level).filter((i) => !i.locked).map((i) => [i.key, template === 'all' ? true : workspacePermissionOn(i, saved)]));
}

const groupId = z.union([z.literal(CENTRAL_GROUP), z.literal('all'), z.uuid()]);
const switches = z.record(z.string().regex(/^[a-z_]+\.[a-z0-9_:.]+$/).max(80), z.boolean());

/** Saving the switches of one level for one group: an HR Workspace (or "central"), or "all" Employee Workspaces. */
export const workspacePermissionsInput = z.object({
  level: z.enum(WORKSPACE_PERMISSION_LEVELS),
  groupId,
  permissions: switches,
  /** The template the switches came from, recorded with the change. */
  template: z.enum(PERMISSION_TEMPLATE_KEYS).optional(),
}).strict().refine((v) => (v.level === 'employee') === (v.groupId === 'all'), { message: 'Employee Workspace permissions are set for all Employee Workspaces; HR Workspace permissions for one HR Workspace or central', path: ['groupId'] });
export type WorkspacePermissionsInput = z.infer<typeof workspacePermissionsInput>;

export const permissionTemplateInput = z.object({ permissions: switches }).strict();

/** What a template can be applied as when an HR Workspace is created. */
export const hrWorkspaceTemplateChoice = z.object({
  template: z.enum(PERMISSION_TEMPLATE_KEYS).default('hr_default'),
  /** With "custom": the switches as chosen on the form (anything left out has its default). */
  permissions: switches.optional(),
}).strict();
export type HrWorkspaceTemplateChoice = z.infer<typeof hrWorkspaceTemplateChoice>;

export interface WorkspacePermissionsView {
  level: WorkspacePermissionLevel;
  groupId: string;
  groupName: string;
  /** Who last saved, and the template they applied. */
  updatedAt: string | null;
  updatedBy: string | null;
  template: string | null;
  categories: {
    key: string; label: string; description: string; feature: string | null;
    /** The module is off for this level (Console or Super Workspace): switches have no effect until it is on. */
    moduleOff: boolean;
    items: { key: string; label: string; description: string; on: boolean; default: boolean; locked: boolean; enforced: 'permission' | 'route' | 'setting' | 'always' }[];
  }[];
  groups: { id: string; name: string; level: WorkspacePermissionLevel }[];
  templates: { key: PermissionTemplateKey; label: string; permissions: Record<string, boolean> | null }[];
}
