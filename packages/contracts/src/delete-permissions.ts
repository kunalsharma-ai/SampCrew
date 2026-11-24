import { z } from 'zod';

/**
 * Password-confirmed, permission-gated deletion (2026-11-23).
 *
 * Every delete action, at every level, passes two checks on the server before it runs:
 *  1. Permission, from the level above:
 *     - Console Admin decides, per Super Workspace (company workspace), which areas it may delete in
 *       (tenant_access_controls.delete_areas_off, Console > Workspaces > Features & permissions > Delete permissions).
 *     - The Super Workspace decides, per area, what HR Workspace people (per HR Workspace, or company-wide HR) and
 *       Employee Workspace people may delete (Settings > Workspace Permissions > Delete permissions). Off by default:
 *       without a switch on, HR and Employee Workspace people have no delete option and the API refuses.
 *     - A Console Admin deletes in the Console only with the "Delete records" Console permission (records:delete).
 *     A level never gets more than the level above it gave: what the Console switched off is off for everyone below.
 *  2. The person's own password, typed just before the delete. POST /me/delete-confirmation (Console:
 *     /platform/auth/delete-confirmation) checks it and marks the session for ONE delete in the next two minutes.
 *     Wrong passwords count toward the account lock like sign-in.
 * Every delete that runs is written to the audit trail (delete.performed); every refusal too (delete.denied).
 *
 * The registry below lists every delete action of the API: each DELETE route, plus the archive, erase and
 * body-dependent routes that remove records (apps/api/test/delete-permissions.spec.ts fails when a new DELETE route is
 * neither listed nor exempted with a reason). The web and mobile apps hide the delete buttons of areas the person may
 * not delete in (data-delete-area) and ask for the password before the delete is sent.
 */

export const DELETE_AREAS = [
  'people', 'organization', 'leave', 'attendance', 'payroll', 'recruitment', 'performance', 'learning', 'documents', 'communication', 'assets', 'settings', 'personal',
] as const;
export type DeleteArea = (typeof DELETE_AREAS)[number];

export interface DeleteAreaInfo {
  key: DeleteArea;
  label: string;
  description: string;
  /** The plan module the area belongs to (null: always present). Shown as "module off" while it is off. */
  feature: string | null;
  /** The levels below the Super Workspace the area can be given to. */
  levels: readonly ('hr' | 'employee')[];
}

export const DELETE_AREA_INFO: Record<DeleteArea, DeleteAreaInfo> = {
  people: { key: 'people', label: 'Employees and profiles', description: 'Profile photos, onboarding checklists, background verification files, custom fields, skills and erasing personal data on request. For Employee Workspace: removing their own profile photo.', feature: null, levels: ['hr', 'employee'] },
  organization: { key: 'organization', label: 'Company structure', description: 'Departments, locations, business units, legal entities, job titles and archiving HR Workspaces.', feature: null, levels: ['hr'] },
  leave: { key: 'leave', label: 'Leave', description: 'Leave types, holiday calendars and holidays.', feature: 'leave', levels: ['hr'] },
  attendance: { key: 'attendance', label: 'Attendance and shifts', description: 'Location attendance rules, shift templates, draft rosters and attendance devices. For Employee Workspace: draft rosters of their own team.', feature: 'attendance_basic', levels: ['hr', 'employee'] },
  payroll: { key: 'payroll', label: 'Payroll and expenses', description: 'Salary components and structures, statutory settings, salary revisions, run adjustments and expense categories.', feature: 'payroll', levels: ['hr'] },
  recruitment: { key: 'recruitment', label: 'Recruitment and staffing', description: 'Pipeline stages, candidates (archive and erase), CRM documents, references, fields and import templates, staffing clients, bids and rate cards.', feature: 'recruitment', levels: ['hr'] },
  performance: { key: 'performance', label: 'Performance and engagement', description: 'Goals, review cycles, feedback requests, appraisal forms, surveys, company values and workforce scenarios.', feature: 'performance', levels: ['hr', 'employee'] },
  learning: { key: 'learning', label: 'Learning', description: 'Courses, learning paths, categories and modules.', feature: 'learning', levels: ['hr'] },
  documents: { key: 'documents', label: 'Documents and email signatures', description: 'Documents, signature logo and banners, and Outlook signature add-ins of other people.', feature: null, levels: ['hr', 'employee'] },
  communication: { key: 'communication', label: 'Communication and help', description: 'Chat messages, email drafts, groups, announcements and helpdesk articles and categories.', feature: null, levels: ['hr', 'employee'] },
  assets: { key: 'assets', label: 'Assets', description: 'Assets and their files.', feature: 'asset_management', levels: ['hr'] },
  settings: { key: 'settings', label: 'Workspace settings', description: 'Custom roles, add-ons, webhooks, single sign-on, reward rules, approval categories and automation workflows.', feature: null, levels: ['hr'] },
  personal: { key: 'personal', label: 'Own saved items', description: 'Their own saved list views and AI assistant conversations.', feature: null, levels: ['hr', 'employee'] },
};

export const DELETE_AREA_LIST: readonly DeleteAreaInfo[] = DELETE_AREAS.map((a) => DELETE_AREA_INFO[a]);

export interface DeleteAction {
  method: 'DELETE' | 'POST' | 'PUT' | 'PATCH';
  /** An API path below /api/v1, with * for one id segment. */
  path: string;
  area: DeleteArea;
  /** What is deleted, for the password prompt and the audit trail. */
  label: string;
  /** Only when the body asks for it (archiving through a status change, a bulk archive). null matches a field left out. */
  when?: { field: string; values: readonly (string | boolean | null)[] };
}

const d = (path: string, area: DeleteArea, label: string): DeleteAction => ({ method: 'DELETE', path, area, label });
const p = (path: string, area: DeleteArea, label: string, when?: DeleteAction['when']): DeleteAction => ({ method: 'POST', path, area, label, ...(when ? { when } : {}) });

/** Every delete action of a workspace (Super, HR and Employee Workspace). */
export const WORKSPACE_DELETE_ACTIONS: readonly DeleteAction[] = [
  // people
  d('employees/*/photo', 'people', 'Profile photo'),
  d('onboarding/templates/*', 'people', 'Onboarding checklist'),
  d('bgv/files/*', 'people', 'Background verification file'),
  d('custom-fields/*', 'people', 'Custom field'),
  p('custom-fields/*/archive', 'people', 'Custom field (archive)', { field: 'archived', values: [true] }),
  d('skills/*', 'people', 'Skill'),
  p('privacy/requests/*/erase', 'people', 'Personal data (erasure request)'),
  // organization
  d('org/legal-entities/*', 'organization', 'Legal entity'),
  d('org/business-units/*', 'organization', 'Business unit'),
  d('org/locations/*', 'organization', 'Location'),
  d('org/departments/*', 'organization', 'Department'),
  d('designations/*', 'organization', 'Job title'),
  p('hr-workspaces/*/status', 'organization', 'HR Workspace (archive)', { field: 'status', values: ['archived'] }),
  // leave
  d('leave/types/*', 'leave', 'Leave type'),
  d('leave/calendars/*', 'leave', 'Holiday calendar'),
  d('leave/calendars/*/holidays/*', 'leave', 'Holiday'),
  // attendance
  d('attendance/policies/*', 'attendance', 'Location attendance rules'),
  d('shifts/templates/*', 'attendance', 'Shift template'),
  d('shifts/rosters/*', 'attendance', 'Draft roster'),
  d('attendance/devices/mappings/*', 'attendance', 'Device mapping'),
  d('attendance/devices/*', 'attendance', 'Attendance device'),
  // payroll
  d('payroll/components/*', 'payroll', 'Salary component'),
  d('payroll/structures/*', 'payroll', 'Salary structure'),
  d('payroll/statutory/*', 'payroll', 'Statutory settings'),
  d('payroll/salary-revisions/*', 'payroll', 'Salary revision'),
  d('payroll/runs/*/adjustments/*', 'payroll', 'Payroll adjustment'),
  d('expenses/categories/*', 'payroll', 'Expense category'),
  // recruitment
  d('recruitment/settings/stages/*', 'recruitment', 'Pipeline stage'),
  p('recruitment/candidates/*/erase', 'recruitment', 'Candidate (erase)'),
  p('recruitment/crm/candidates/bulk', 'recruitment', 'Candidates (bulk archive)', { field: 'action', values: ['archive'] }),
  p('recruitment/crm/candidates/*/archive', 'recruitment', 'Candidate (archive)', { field: 'archived', values: [true] }),
  p('recruitment/crm/candidates/*/erase', 'recruitment', 'Candidate (erase)'),
  d('recruitment/crm/candidates/*/photo', 'recruitment', 'Candidate photo'),
  d('recruitment/crm/references/*', 'recruitment', 'Candidate reference'),
  d('recruitment/crm/documents/*', 'recruitment', 'Candidate document'),
  p('recruitment/crm/fields/*/archive', 'recruitment', 'Candidate field (archive)', { field: 'archived', values: [true] }),
  d('recruitment/crm/import-templates/*', 'recruitment', 'Import template'),
  d('staffing/clients/*', 'recruitment', 'Staffing client'),
  d('staffing/clients/*/contacts/*', 'recruitment', 'Client contact'),
  d('staffing/templates/*', 'recruitment', 'Proposal template'),
  d('staffing/rate-cards/*', 'recruitment', 'Rate card'),
  d('staffing/bids/*', 'recruitment', 'Bid'),
  // performance
  d('goals/*', 'performance', 'Goal'),
  d('review-cycles/*', 'performance', 'Review cycle'),
  d('reviews/*/feedback-requests/*', 'performance', 'Feedback request'),
  d('appraisals/forms/*', 'performance', 'Appraisal form'),
  d('surveys/*', 'performance', 'Survey'),
  d('company-values/*', 'performance', 'Company value'),
  d('insights/scenarios/*', 'performance', 'Workforce scenario'),
  // learning
  d('learning/courses/*', 'learning', 'Course'),
  d('learning/paths/*', 'learning', 'Learning path'),
  d('learning/categories/*', 'learning', 'Learning category'),
  p('learning/modules/*/archive', 'learning', 'Learning module (archive)', { field: 'restore', values: [false, null] }),
  // documents
  d('documents/*', 'documents', 'Document'),
  d('signatures/settings/logo', 'documents', 'Signature logo'),
  d('signatures/banners/*', 'documents', 'Signature banner'),
  d('signatures/banners/*/image', 'documents', 'Signature banner image'),
  d('signatures/agents/*', 'documents', 'Outlook signature add-in'),
  // communication
  d('communication/conversations/*/messages/*', 'communication', 'Chat message'),
  d('communication/emails/*', 'communication', 'Email draft'),
  d('communication/groups/*', 'communication', 'Communication group'),
  p('announcements/*/archive', 'communication', 'Announcement (archive)'),
  d('announcements/*', 'communication', 'Announcement'),
  p('helpdesk/categories/*/archive', 'communication', 'Helpdesk category (archive)'),
  d('helpdesk/articles/*', 'communication', 'Helpdesk article'),
  // assets
  d('assets/*', 'assets', 'Asset'),
  d('assets/files/*', 'assets', 'Asset file'),
  // settings
  d('roles/*', 'settings', 'Custom role'),
  d('billing/addons/*', 'settings', 'Add-on'),
  d('integrations/webhooks/*', 'settings', 'Webhook'),
  d('security/sso', 'settings', 'Single sign-on settings'),
  d('workspace/reward-rules/*', 'settings', 'Reward rule'),
  d('approvals/categories/*', 'settings', 'Approval category'),
  p('automation/workflows/*/archive', 'settings', 'Automation workflow (archive)'),
  // personal
  d('me/views/*', 'personal', 'Saved view'),
  d('iq/conversations/*', 'personal', 'AI conversation'),
  d('iq/conversations', 'personal', 'All AI conversations'),
];

/** DELETE routes that do not delete a record, with the reason. No permission or password is asked for them. */
export const NOT_DELETE_ACTIONS: readonly { method: 'DELETE'; path: string; reason: string }[] = [
  { method: 'DELETE', path: 'me/sessions/*', reason: 'Signs one of your own devices out' },
  { method: 'DELETE', path: 'employees/drafts/*', reason: 'Discards your own unfinished hire form (no record was saved yet); also done automatically once the hire is saved' },
  { method: 'DELETE', path: 'billing/scheduled-change', reason: 'Cancels a plan change that has not happened yet' },
  { method: 'DELETE', path: 'workspace-permissions/templates/*', reason: 'Resets a permission template to its defaults' },
  { method: 'DELETE', path: 'signatures/me/agents/*', reason: 'Disconnects your own Outlook signature add-in' },
  { method: 'DELETE', path: 'scim/v2/Users/*', reason: 'SCIM provisioning from the identity provider (token, no person signed in); it deactivates, never deletes' },
  { method: 'DELETE', path: 'scim/v2/Groups/*', reason: 'SCIM provisioning from the identity provider (token, no person signed in)' },
];

/** Every delete action of the Console (Console Admins). They need records:delete and the admin's password. */
export const CONSOLE_DELETE_ACTIONS: readonly DeleteAction[] = [
  p('platform/clients/*/archive', 'settings', 'Client company (archive)', { field: 'archived', values: [true] }),
  d('platform/plans/*', 'settings', 'Plan'),
  p('platform/plans/*/archive', 'settings', 'Plan (archive)'),
  d('platform/statutory-packs/*', 'settings', 'Payroll country pack'),
  d('platform/integrations/*', 'settings', 'Integration keys'),
  d('platform/roles/*', 'settings', 'Console role'),
  d('platform/help/manage/categories/*', 'settings', 'Help category'),
  d('platform/help/manage/articles/*', 'settings', 'Help article'),
  d('platform/help/manage/query-categories/*', 'settings', 'Help query category'),
];

/** The Console permission a Console Admin needs to delete anything in the Console. */
export const CONSOLE_DELETE_PERMISSION = 'records:delete';

/** How long a typed password allows one delete. */
export const DELETE_CONFIRMATION_TTL_MS = 2 * 60_000;

/** The error code the API answers with when a delete needs the password first. */
export const DELETE_PASSWORD_REQUIRED = 'delete_password_required';

const norm = (s: string) => s.split('?')[0]!.replace(/^.*?\/api\/v\d+\//, '').replace(/^\/+|\/+$/g, '');

function pathMatches(pattern: string, path: string): boolean {
  const want = norm(pattern).split('/');
  const parts = norm(path).split('/');
  return want.length === parts.length && want.every((w, i) => w === '*' || w === parts[i]);
}

/**
 * The delete action a request is, or null. Literal segments win over `*` (attendance/devices/mappings/x before
 * attendance/devices/x). With `when`, the body decides (an HR Workspace status change is a delete only when it archives).
 */
export function deleteActionFor(actions: readonly DeleteAction[], path: string, method: string, body?: unknown): DeleteAction | null {
  const m = method.toUpperCase();
  const hits = actions.filter((a) => a.method === m && pathMatches(a.path, path));
  hits.sort((a, b) => a.path.split('*').length - b.path.split('*').length);
  for (const a of hits) {
    if (!a.when) return a;
    const v = (body as Record<string, unknown> | null | undefined)?.[a.when.field] ?? null;
    if (a.when.values.includes(v as string | boolean | null)) return a;
    return null;
  }
  return null;
}

/** Is this DELETE route listed as not deleting anything? */
export function isNotDeleteAction(path: string, method: string): boolean {
  return method.toUpperCase() === 'DELETE' && NOT_DELETE_ACTIONS.some((a) => pathMatches(a.path, path));
}

/** Workspace Permissions switch key of an area (Settings > Workspace Permissions > Delete permissions). */
export const deleteSwitchKey = (area: DeleteArea) => `delete.${area}`;

/** Console > Features & permissions > Delete permissions: the areas switched off for one Super Workspace. */
export const deleteRightsInput = z.object({
  areasOff: z.array(z.enum(DELETE_AREAS)).max(DELETE_AREAS.length),
  reason: z.string().trim().min(3).max(300).optional(),
}).strict();
export type DeleteRightsInput = z.infer<typeof deleteRightsInput>;

export const deleteConfirmationInput = z.object({ password: z.string().min(1).max(200) }).strict();
export type DeleteConfirmationInput = z.infer<typeof deleteConfirmationInput>;

export interface DeleteRightsView {
  areas: { key: DeleteArea; label: string; description: string; allowed: boolean }[];
  updatedAt: string | null;
}
