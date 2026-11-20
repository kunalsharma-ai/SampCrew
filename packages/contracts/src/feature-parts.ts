import { FEATURES } from './features';

/**
 * Feature management below the module: every menu and page of the app belongs to one part, and every part belongs to
 * one module (a boolean feature). A part is on only while its module is on and no level switched the part off, so the
 * same switches work for a whole module ("leave") and for one page of it ("leave.settings").
 *
 *  - `web`: the pages of the part (the path and everything under it; the longest matching path wins, so
 *    /payroll/salaries is the Salaries part and /payroll/runs/1 is the Payroll runs part).
 *  - `api`: API routes only this part's pages use (relative to /api/v1, same longest-match rule). The server refuses
 *    them while the part is off. Data other pages also read stays behind the module switch and the person's permissions.
 *
 * New parts added here show up in the Console's Feature management as Pending and stay off until SAMPLEDGE activates them.
 */
export interface FeaturePart {
  key: string;
  feature: string;
  name: string;
  /** Who mostly uses it, shown as a hint next to the switch. */
  audience: 'employee' | 'hr' | 'admin';
  web: readonly string[];
  api?: readonly string[];
}

export const FEATURE_PARTS = [
  // People (core records are always on; these pages around them can be switched)
  { key: 'core_hr.structure', feature: 'core_hr', name: 'Company structure', audience: 'hr', web: ['/organization'] },
  { key: 'core_hr.import', feature: 'core_hr', name: 'Import employees', audience: 'hr', web: ['/employees/import'], api: ['employees/import'] },
  { key: 'core_hr.custom_fields', feature: 'core_hr', name: 'Custom fields', audience: 'admin', web: ['/settings/custom-fields'] },
  { key: 'core_hr.tasks', feature: 'core_hr', name: 'My tasks', audience: 'employee', web: ['/tasks'] },
  { key: 'core_hr.analytics', feature: 'core_hr', name: 'HR analytics', audience: 'hr', web: ['/insights'] },
  { key: 'core_hr.privacy', feature: 'core_hr', name: 'Privacy requests', audience: 'admin', web: ['/privacy'], api: ['privacy/requests'] },
  { key: 'core_hr.audit', feature: 'core_hr', name: 'Audit trail', audience: 'admin', web: ['/settings/audit'], api: ['audit-events'] },
  { key: 'core_hr.approval_settings', feature: 'core_hr', name: 'Approval settings', audience: 'admin', web: ['/settings/approvals'] },
  { key: 'self_service.profile_updates', feature: 'self_service', name: 'Profile update reviews', audience: 'hr', web: ['/profile/updates'] },
  { key: 'onboarding.checklists', feature: 'onboarding', name: 'Onboarding checklists', audience: 'hr', web: ['/settings/onboarding'] },
  // Leave
  { key: 'leave.requests', feature: 'leave', name: 'My leave and requests', audience: 'employee', web: ['/leave'] },
  { key: 'leave.balances', feature: 'leave', name: 'Leave balances (team view)', audience: 'hr', web: ['/leave/balances'] },
  { key: 'leave.settings', feature: 'leave', name: 'Leave settings', audience: 'admin', web: ['/settings/leave'] },
  // Attendance
  { key: 'attendance_basic.mine', feature: 'attendance_basic', name: 'My attendance', audience: 'employee', web: ['/attendance'] },
  { key: 'attendance_basic.register', feature: 'attendance_basic', name: 'All employees attendance', audience: 'hr', web: ['/attendance/register'] },
  { key: 'attendance_basic.team', feature: 'attendance_basic', name: 'Team attendance', audience: 'hr', web: ['/attendance/team'] },
  { key: 'attendance_basic.late', feature: 'attendance_basic', name: 'Late coming and penalties', audience: 'hr', web: ['/attendance/late'] },
  { key: 'attendance_basic.settings', feature: 'attendance_basic', name: 'Attendance settings', audience: 'admin', web: ['/settings/attendance'] },
  { key: 'attendance_advanced.devices', feature: 'attendance_advanced', name: 'Attendance devices', audience: 'admin', web: ['/settings/devices'] },
  { key: 'shift_scheduling.shifts', feature: 'shift_scheduling', name: 'Shifts and rosters', audience: 'hr', web: ['/shifts'] },
  // Payroll and expenses
  { key: 'payroll.runs', feature: 'payroll', name: 'Payroll runs', audience: 'hr', web: ['/payroll'] },
  { key: 'payroll.salaries', feature: 'payroll', name: 'Salaries', audience: 'hr', web: ['/payroll/salaries'] },
  { key: 'payroll.settings', feature: 'payroll', name: 'Payroll settings', audience: 'admin', web: ['/settings/payroll'] },
  { key: 'payroll.payslips', feature: 'payroll', name: 'Payslips', audience: 'employee', web: ['/payslips'] },
  { key: 'expenses.claims', feature: 'expenses', name: 'Expense claims', audience: 'employee', web: ['/expenses'] },
  // Recruitment
  { key: 'recruitment.jobs', feature: 'recruitment', name: 'Jobs', audience: 'hr', web: ['/recruitment'] },
  { key: 'recruitment.candidates', feature: 'recruitment', name: 'Candidates', audience: 'hr', web: ['/recruitment/candidates'] },
  { key: 'recruitment.interviews', feature: 'recruitment', name: 'My interviews', audience: 'employee', web: ['/recruitment/interviews'] },
  { key: 'recruitment.settings', feature: 'recruitment', name: 'Recruitment settings', audience: 'admin', web: ['/settings/recruitment'] },
  // Staffing bids
  { key: 'staffing_bids.bids', feature: 'staffing_bids', name: 'Staffing bids', audience: 'hr', web: ['/staffing/bids'] },
  { key: 'staffing_bids.clients', feature: 'staffing_bids', name: 'Clients', audience: 'hr', web: ['/staffing/clients'] },
  { key: 'staffing_bids.templates', feature: 'staffing_bids', name: 'Proposal templates', audience: 'hr', web: ['/staffing/templates'] },
  { key: 'staffing_bids.rate_cards', feature: 'staffing_bids', name: 'Rate cards', audience: 'hr', web: ['/staffing/rate-cards'] },
  // Performance and learning
  { key: 'performance.goals', feature: 'performance', name: 'Goals', audience: 'employee', web: ['/goals'] },
  { key: 'performance.reviews', feature: 'performance', name: 'Reviews', audience: 'employee', web: ['/reviews'] },
  { key: 'performance.cycles', feature: 'performance', name: 'Review cycles', audience: 'admin', web: ['/reviews/cycles'] },
  { key: 'performance.my_appraisal', feature: 'performance', name: 'My appraisal', audience: 'employee', web: ['/appraisal'], api: ['appraisals/mine'] },
  { key: 'performance.appraisal_setup', feature: 'performance', name: 'Appraisal forms and cycles', audience: 'admin', web: ['/settings/appraisals'] },
  { key: 'learning.mine', feature: 'learning', name: 'My learning', audience: 'employee', web: ['/learning'] },
  { key: 'learning.catalogue', feature: 'learning', name: 'Course catalogue', audience: 'admin', web: ['/learning/catalogue'] },
  // Engagement and communication
  { key: 'engagement.recognition', feature: 'engagement', name: 'Recognition', audience: 'employee', web: ['/recognition'] },
  { key: 'engagement.surveys', feature: 'engagement', name: 'Surveys', audience: 'employee', web: ['/surveys'] },
  { key: 'engagement.survey_results', feature: 'engagement', name: 'Survey results', audience: 'hr', web: ['/surveys/manage'] },
  { key: 'announcements.read', feature: 'announcements', name: 'Announcements', audience: 'employee', web: ['/announcements'] },
  { key: 'announcements.manage', feature: 'announcements', name: 'Manage announcements', audience: 'hr', web: ['/announcements/manage'], api: ['announcements/manage'] },
  { key: 'helpdesk.communication', feature: 'helpdesk', name: 'Communication and Ask HR', audience: 'employee', web: ['/communication', '/helpdesk'] },
  { key: 'helpdesk.settings', feature: 'helpdesk', name: 'Helpdesk settings', audience: 'admin', web: ['/settings/helpdesk'] },
  { key: 'email_signatures.mine', feature: 'email_signatures', name: 'My email signature', audience: 'employee', web: ['/settings/signature'] },
  { key: 'email_signatures.company', feature: 'email_signatures', name: 'Company signature', audience: 'admin', web: ['/settings/signature/company'] },
  // Assets and verification
  { key: 'asset_management.mine', feature: 'asset_management', name: 'My assets', audience: 'employee', web: ['/assets/mine'], api: ['assets/mine'] },
  { key: 'asset_management.inventory', feature: 'asset_management', name: 'Asset inventory', audience: 'hr', web: ['/assets'] },
  { key: 'background_verification.cases', feature: 'background_verification', name: 'Background verification', audience: 'hr', web: ['/verification'] },
  // Analytics, automation and AI
  { key: 'workforce_universe.universe', feature: 'workforce_universe', name: 'Workforce Universe', audience: 'hr', web: ['/insights/universe'] },
  { key: 'workforce_analytics.attrition', feature: 'workforce_analytics', name: 'Attrition risk', audience: 'hr', web: ['/insights/attrition'] },
  { key: 'automation.studio', feature: 'automation', name: 'Automation Studio', audience: 'admin', web: ['/automation'] },
  { key: 'automation.runs', feature: 'automation', name: 'Workflow runs', audience: 'admin', web: ['/automation/runs'] },
  { key: 'ai_copilot.settings', feature: 'ai_copilot', name: 'AI settings', audience: 'admin', web: ['/settings/ai'] },
  { key: 'ai_copilot.activity', feature: 'ai_copilot', name: 'AI activity', audience: 'admin', web: ['/settings/ai/activity'] },
  // Administration
  { key: 'sso.settings', feature: 'sso', name: 'Single sign-on settings', audience: 'admin', web: ['/settings/single-sign-on'] },
  { key: 'integrations_advanced.settings', feature: 'integrations_advanced', name: 'Integrations', audience: 'admin', web: ['/settings/integrations'] },
] as const satisfies readonly FeaturePart[];

export type FeaturePartKey = (typeof FEATURE_PARTS)[number]['key'];

const PARTS = FEATURE_PARTS as readonly FeaturePart[];
const PART_BY_KEY = new Map(PARTS.map((p) => [p.key, p]));
/** The modules that can be switched (boolean, not planned). */
const MODULE_KEYS = new Set<string>(FEATURES.filter((f) => f.kind === 'boolean' && !('planned' in f && f.planned)).map((f) => f.key));

export const isFeaturePart = (key: string) => PART_BY_KEY.has(key);
export const featurePart = (key: string): FeaturePart | undefined => PART_BY_KEY.get(key);
/** The module a key belongs to: itself for a module, its parent for a part. */
export const moduleOfFeature = (key: string) => PART_BY_KEY.get(key)?.feature ?? key;
/** Every key a feature switch can name: the switchable modules and every part. */
export const isSwitchableFeature = (key: string) => MODULE_KEYS.has(key) || PART_BY_KEY.has(key);
export const SWITCHABLE_FEATURE_KEYS: readonly string[] = [...MODULE_KEYS, ...PARTS.map((p) => p.key)];
export const partsOfModule = (module: string) => PARTS.filter((p) => p.feature === module);

const normalise = (path: string) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);
const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);

function longest(path: string, pick: (p: FeaturePart) => readonly string[] | undefined): FeaturePart | undefined {
  let best: FeaturePart | undefined;
  let size = -1;
  for (const p of PARTS) {
    for (const prefix of pick(p) ?? []) {
      if (under(path, prefix) && prefix.length > size) {
        best = p;
        size = prefix.length;
      }
    }
  }
  return best;
}

/** The part a page of the web app belongs to (for example /payroll/salaries/123 → payroll.salaries), if any. */
export const partForWebPath = (path: string) => longest(normalise(path.split('?')[0] ?? '/'), (p) => p.web);

/** The part an API route belongs to, given the path after /api/v1/ (for example "employees/import/preview"). */
export const partForApiPath = (path: string) => longest(normalise((path.split('?')[0] ?? '').replace(/^\/+/, '')), (p) => p.api);

/** The states a feature has in the Console for the whole application. */
export const PLATFORM_FEATURE_STATES = ['active', 'off', 'pending'] as const;
export type PlatformFeatureState = (typeof PLATFORM_FEATURE_STATES)[number];

/**
 * How a switch looks to the person managing it:
 *  - active: on here and above;
 *  - inactive: switched off at this level (it can be switched back on here);
 *  - restricted: switched off above (by the Console, the plan or the Super Workspace), so it cannot be switched on here;
 *  - inherited: on because the level above has it on, and this level has not changed it.
 */
export type FeatureIndicator = 'active' | 'inactive' | 'restricted' | 'inherited';
