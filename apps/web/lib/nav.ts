import { partForWebPath } from '@crew/contracts';
import type { Me } from './types';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Visible when the user holds this permission (any scope). */
  permission?: string;
  /** Visible when the user holds any one of these (any scope), for pages that serve several jobs. */
  anyPermission?: string[];
  /** Hidden when the permission covers only the person's own record (an organization view of one person is empty). */
  beyondOwn?: boolean;
  /** Visible when the plan includes this feature. */
  feature?: string;
  /** Hidden when the user holds this permission (for example Ask HR is hidden from the HR team, who answer it). */
  hiddenWith?: string;
  /** Only for the Super Workspace level. */
  superOnly?: boolean;
  /** Only for Super Workspace and HR Workspace (Employee Workspace sees only its own records here). */
  adminOnly?: boolean;
  /** Only when Candidate CRM is open to the person (Super Workspace, or an HR Workspace it is switched on for). */
  candidateCrm?: boolean;
  /** Shown to billing admins when the plan lacks the feature: the link opens Plan & billing to upgrade. */
  locked?: boolean;
  /** Extra words the Settings search matches. */
  keywords?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Navigation, grouped by HR module. Every item is shown only when the member holds its permission and the plan
 * includes its feature, so each role sees a navigation that matches what it can do.
 */
export const NAV: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { href: '/', label: 'Home', icon: 'home' },
      { href: '/approvals', label: 'Approvals', icon: 'inbox' },
      { href: '/tasks', label: 'My tasks', icon: 'list-checks' },
      { href: '/documents', label: 'Documents', icon: 'file-stack', permission: 'documents:read', feature: 'documents' },
      { href: '/onboarding-documents/mine', label: 'My onboarding documents', icon: 'clipboard-list', permission: 'documents:read', feature: 'documents', keywords: 'joining documents upload aadhaar pan certificates' },
      { href: '/announcements', label: 'Announcements', icon: 'megaphone', permission: 'announcements:read', feature: 'announcements' },
      // Communication replaces Ask HR: chat, emails from HR and help requests (Ask HR cases, the queue for HR).
      { href: '/communication', label: 'Communication', icon: 'messages-square', permission: 'helpdesk:use', feature: 'helpdesk' },
      // The Super Workspace's private chat with the SampCrew Console Admin team (every plan; not a Communication part).
      { href: '/support', label: 'SampCrew Support', icon: 'headset', superOnly: true },
      // Help & Support: guides, FAQs and tutorials for what this person can use, and Raise a Query (every level).
      { href: '/help', label: 'Help & Support', icon: 'life-buoy' },
    ],
  },
  {
    label: 'My work',
    items: [
      { href: '/attendance', label: 'Attendance', icon: 'clock', permission: 'attendance:punch', feature: 'attendance_basic' },
      { href: '/leave', label: 'Leave', icon: 'calendar', permission: 'leave:request', feature: 'leave' },
      { href: '/payslips', label: 'Payslips', icon: 'file-text', permission: 'payslips:read', feature: 'payroll' },
      { href: '/expenses', label: 'Expenses', icon: 'receipt', permission: 'expenses:submit', feature: 'expenses' },
      { href: '/appraisal', label: 'Appraisal', icon: 'award', permission: 'performance:read', feature: 'performance' },
      { href: '/assets/mine', label: 'My assets', icon: 'laptop', permission: 'assets:view', feature: 'asset_management' },
    ],
  },
  {
    label: 'Employee management',
    items: [
      { href: '/employees', label: 'Employees', icon: 'contact', permission: 'employees:read', beyondOwn: true },
      { href: '/hr-workspaces', label: 'HR Workspaces', icon: 'network', permission: 'hierarchy:read' },
      { href: '/employee-features', label: 'Employee features', icon: 'toggle-right', permission: 'modules:assign' },
      { href: '/organization', label: 'Structure', icon: 'building', permission: 'org:read' },
      { href: '/people', label: 'Logins & access', icon: 'users', permission: 'users:read', beyondOwn: true },
      { href: '/profile/updates', label: 'Profile updates', icon: 'user-check', permission: 'profiles:review' },
      { href: '/settings/onboarding', label: 'Onboarding checklists', icon: 'list-checks', permission: 'employees:create', feature: 'onboarding' },
      { href: '/onboarding-documents', label: 'Onboarding documents', icon: 'clipboard-list', permission: 'documents:read', feature: 'documents', adminOnly: true, keywords: 'joining documents progress approve reject new joiner' },
      { href: '/imports', label: 'Data import', icon: 'upload', permission: 'imports:run', feature: 'data_import' },
      { href: '/verification', label: 'Background verification', icon: 'shield-check', permission: 'bgv:view', feature: 'background_verification' },
      { href: '/assets', label: 'Assets', icon: 'laptop', permission: 'assets:view', beyondOwn: true, feature: 'asset_management' },
    ],
  },
  {
    label: 'Recruitment & ATS',
    items: [
      { href: '/recruitment', label: 'Jobs', icon: 'briefcase', permission: 'requisitions:read', feature: 'recruitment' },
      { href: '/recruitment/candidates', label: 'Candidates', icon: 'user-search', permission: 'candidates:read', feature: 'recruitment' },
      { href: '/recruitment/crm', label: 'Candidate CRM', icon: 'contact', feature: 'recruitment', candidateCrm: true },
      // Interview panels: only for people who work in recruitment, not in every employee's menu (scorecards still open from notifications).
      { href: '/recruitment/interviews', label: 'My interviews', icon: 'message-square', permission: 'requisitions:read', feature: 'recruitment' },
      { href: '/settings/recruitment', label: 'Recruitment settings', icon: 'sliders', permission: 'recruitment:configure', feature: 'recruitment' },
    ],
  },
  {
    label: 'Staffing & bids',
    items: [
      { href: '/staffing/bids', label: 'Staffing bids', icon: 'handshake', permission: 'bids:read', feature: 'staffing_bids' },
      { href: '/staffing/clients', label: 'Clients', icon: 'building-office', permission: 'bids:read', feature: 'staffing_bids' },
      { href: '/staffing/templates', label: 'Proposal templates', icon: 'file-stack', permission: 'bids:manage', feature: 'staffing_bids' },
      { href: '/staffing/rate-cards', label: 'Rate cards', icon: 'tags', permission: 'bids:read', feature: 'staffing_bids' },
    ],
  },
  {
    label: 'Attendance & time',
    items: [
      { href: '/attendance/work-mode', label: 'Workforce attendance', icon: 'building', permission: 'attendance:read', feature: 'attendance_basic', adminOnly: true },
      { href: '/attendance/work-mode/register', label: 'Office and home register', icon: 'clipboard-list', permission: 'attendance:read', feature: 'attendance_basic', adminOnly: true },
      { href: '/attendance/employees', label: 'Employee Workspace attendance', icon: 'users-round', permission: 'attendance:read', feature: 'attendance_basic', adminOnly: true },
      { href: '/attendance/hr-workspaces', label: 'HR Workspace attendance', icon: 'network', permission: 'attendance:read', feature: 'attendance_basic', superOnly: true },
      { href: '/attendance/register', label: 'All employees attendance', icon: 'calendar-range', permission: 'attendance:approve', feature: 'attendance_basic', adminOnly: true },
      { href: '/attendance/team', label: 'Team attendance', icon: 'users-round', permission: 'attendance:approve', feature: 'attendance_basic', adminOnly: true },
      { href: '/attendance/late', label: 'Late coming & penalties', icon: 'alarm-clock', permission: 'attendance:approve', feature: 'attendance_basic', adminOnly: true },
      { href: '/settings/attendance-access', label: 'Attendance permissions', icon: 'shield-check', permission: 'hierarchy:manage', feature: 'attendance_basic', superOnly: true },
      { href: '/shifts', label: 'Shifts', icon: 'calendar-clock', permission: 'shifts:read', feature: 'shift_scheduling' },
      { href: '/attendance/offices', label: 'Office locations', icon: 'map-pin', permission: 'attendance:configure', feature: 'attendance_basic' },
      { href: '/attendance/work-mode/settings', label: 'Office and home rules', icon: 'sliders', permission: 'attendance:configure', feature: 'attendance_basic' },
      { href: '/settings/attendance', label: 'Attendance settings', icon: 'timer', permission: 'attendance:configure', feature: 'attendance_basic' },
      { href: '/settings/devices', label: 'Attendance devices', icon: 'fingerprint', permission: 'devices:manage', feature: 'attendance_advanced' },
      { href: '/leave/balances', label: 'Leave balances', icon: 'calendar-range', permission: 'leave:approve', feature: 'leave' },
      // Any of the leave jobs opens it: an HR Workspace the Super Workspace allowed to create leave types, assign
      // or assign quantities finds Leave management even without the calendars and reports switch.
      { href: '/leave/manage', label: 'Leave management', icon: 'sliders', anyPermission: ['leave:allocate', 'leave:assign', 'leavetypes:create'], feature: 'leave' },
      { href: '/settings/leave', label: 'Holidays and leave rules', icon: 'calendar-range', permission: 'leave:allocate', feature: 'leave' },
    ],
  },
  {
    label: 'Payroll',
    items: [
      { href: '/payroll', label: 'Payroll runs', icon: 'wallet', permission: 'payroll:read', feature: 'payroll' },
      { href: '/payroll/salaries', label: 'Salaries', icon: 'banknote', permission: 'payroll:read', feature: 'payroll' },
      { href: '/settings/payroll', label: 'Payroll settings', icon: 'landmark', permission: 'payroll:configure', feature: 'payroll' },
    ],
  },
  {
    label: 'Performance & learning',
    items: [
      { href: '/goals', label: 'Goals', icon: 'target', permission: 'performance:read', feature: 'performance' },
      { href: '/reviews', label: 'Reviews', icon: 'messages-square', permission: 'performance:read', feature: 'performance' },
      { href: '/settings/appraisals', label: 'Appraisal forms & cycles', icon: 'award', permission: 'performance:configure', feature: 'performance' },
      { href: '/learning', label: 'My learning', icon: 'graduation-cap', permission: 'learning:read', feature: 'learning' },
      { href: '/learning/manage', label: 'Learning management', icon: 'book-open', permission: 'learning:manage', feature: 'learning' },
      { href: '/learning/catalogue', label: 'Learning paths', icon: 'list-checks', permission: 'learning:configure', feature: 'learning' },
    ],
  },
  {
    label: 'Engagement & relations',
    items: [
      { href: '/recognition', label: 'Recognition', icon: 'heart', permission: 'recognition:give', feature: 'engagement' },
      { href: '/surveys', label: 'Surveys', icon: 'clipboard-list', permission: 'surveys:respond', feature: 'engagement' },
      { href: '/surveys/manage', label: 'Survey results', icon: 'chart', permission: 'engagement:manage', feature: 'engagement' },
      { href: '/announcements/manage', label: 'Manage announcements', icon: 'megaphone', permission: 'announcements:manage', feature: 'announcements', keywords: 'news create new announcement publish notice broadcast' },
      { href: '/settings/helpdesk', label: 'Helpdesk settings', icon: 'life-buoy', permission: 'helpdesk:configure', feature: 'helpdesk' },
    ],
  },
  {
    label: 'Analytics & AI',
    items: [
      { href: '/insights', label: 'HR analytics', icon: 'chart', permission: 'employees:read', beyondOwn: true },
      { href: '/insights/universe', label: 'Workforce Universe', icon: 'orbit', permission: 'employees:read', beyondOwn: true, feature: 'workforce_universe' },
      { href: '/insights/attrition', label: 'Attrition risk', icon: 'trending-down', permission: 'insights:attrition', feature: 'workforce_analytics' },
      { href: '/automation', label: 'Automation Studio', icon: 'workflow', permission: 'automation:manage', feature: 'automation' },
      { href: '/automation/runs', label: 'Workflow runs', icon: 'activity', permission: 'automation:manage', feature: 'automation' },
      { href: '/settings/ai', label: 'AI settings', icon: 'sparkles', permission: 'ai:configure', feature: 'ai_copilot' },
      { href: '/settings/ai/activity', label: 'AI activity', icon: 'bot', permission: 'audit:read', feature: 'ai_copilot' },
    ],
  },
  {
    label: 'Compliance',
    items: [
      { href: '/privacy', label: 'Privacy requests', icon: 'user-x', permission: 'privacy:manage' },
      { href: '/settings/audit', label: 'Audit trail', icon: 'scroll', permission: 'audit:read' },
      { href: '/settings/password-resets', label: 'Password resets', icon: 'key', permission: 'users:read', superOnly: true },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/settings', label: 'All settings', icon: 'layout-grid', adminOnly: true },
      { href: '/settings/workspace-permissions', label: 'Workspace Permissions', icon: 'shield-check', permission: 'hierarchy:read', adminOnly: true },
      { href: '/settings/hr-admin', label: 'Super Workspace Admin', icon: 'layout-grid', permission: 'tenant:read' },
      { href: '/settings/mobile-app', label: 'Mobile app', icon: 'smartphone', permission: 'mobileapp:manage', superOnly: true },
      { href: '/settings/roles', label: 'Access levels', icon: 'shield', permission: 'roles:read' },
      { href: '/settings/forms', label: 'Form management', icon: 'text-cursor-input', permission: 'fields:manage', keywords: 'forms fields custom fields extra fields add employee form employee profile leave request work email domain required hidden labels placeholder configuration' },
      { href: '/settings/onboarding-documents', label: 'Onboarding document library', icon: 'clipboard-list', permission: 'documents:read', feature: 'documents', adminOnly: true, keywords: 'onboarding documents library templates categories mandatory optional' },
      { href: '/settings/master-data', label: 'Master data', icon: 'list-tree', permission: 'org:read' },
      { href: '/settings/single-sign-on', label: 'Single sign-on', icon: 'lock-keyhole', permission: 'security:manage', feature: 'sso' },
      { href: '/settings/integrations', label: 'Integrations', icon: 'plug', permission: 'integrations:manage', feature: 'integrations_advanced' },
      { href: '/settings/billing', label: 'Plan & billing', icon: 'credit-card', permission: 'billing:read' },
      { href: '/settings/workspace', label: 'Workspace settings', icon: 'settings', permission: 'tenant:read' },
      { href: '/settings/email', label: 'Email setup', icon: 'mail', permission: 'mail:configure', keywords: 'smtp mail server outgoing email invitation verification password reset' },
      { href: '/settings/email-templates', label: 'Email templates', icon: 'mail', permission: 'mail:configure', keywords: 'email template html design branding import company layout' },
      { href: '/settings/support', label: 'Support access', icon: 'life-buoy', permission: 'tenant:read' },
      { href: '/settings/approvals', label: 'Approval settings', icon: 'inbox', permission: 'org:manage' },
      { href: '/settings/notifications/organisation', label: 'Notification policy', icon: 'bell', superOnly: true },
      { href: '/settings/document-access', label: 'Document access', icon: 'lock-keyhole', permission: 'documents:manage', feature: 'documents', superOnly: true },
    ],
  },
  {
    label: 'You',
    items: [
      { href: '/notifications', label: 'Notifications', icon: 'bell' },
      { href: '/activity', label: 'Activity log', icon: 'history', keywords: 'login sign in ip location sessions access audit what I did' },
      { href: '/settings/home', label: 'Home dashboard', icon: 'layout-grid', adminOnly: true, keywords: 'dashboard cards counts widgets home page setup' },
      { href: '/settings/notifications', label: 'Notification settings', icon: 'bell' },
      { href: '/settings/appearance', label: 'Appearance', icon: 'palette' },
      { href: '/settings/signature', label: 'Email signature', icon: 'mail', feature: 'email_signatures' },
      { href: '/settings/security', label: 'Security', icon: 'key' },
    ],
  },
];

/** `download` marks a file download: shown as a plain link so the browser never prefetches (and builds) the file. */
export interface QuickAction { key: string; label: string; href: string; icon: string; keywords?: string; download?: boolean }

/** "Create" menu and command palette actions; each opens the real form for that record. */
export function quickActions(me: Me): QuickAction[] {
  const has = (p: string, f?: string) => Boolean(me.permissions[p]) && (!f || me.features.includes(f));
  const out: QuickAction[] = [];
  if (has('employees:create')) out.push({ key: 'employee', label: 'Create employee', href: '/employees?create=employee', icon: 'user-plus', keywords: 'add hire new joiner' });
  if (has('users:invite')) out.push({ key: 'invite', label: 'Invite a colleague', href: '/people?create=invite', icon: 'users', keywords: 'login access' });
  if (has('requisitions:create', 'recruitment')) out.push({ key: 'requisition', label: 'Create job requisition', href: '/recruitment?create=requisition', icon: 'briefcase', keywords: 'job opening hiring position' });
  if (has('bids:manage', 'staffing_bids')) out.push({ key: 'bid', label: 'Create staffing bid', href: '/staffing/bids/new?mode=quick', icon: 'handshake', keywords: 'proposal quote client staffing rate margin' });
  if (has('leave:request', 'leave')) out.push({ key: 'leave', label: 'Request time off', href: '/leave?create=leave', icon: 'calendar', keywords: 'leave holiday vacation apply' });
  if (has('performance:read', 'performance')) out.push({ key: 'goal', label: 'Set a goal', href: '/goals?create=goal', icon: 'target', keywords: 'okr objective' });
  if (has('expenses:submit', 'expenses')) out.push({ key: 'expense', label: 'Claim an expense', href: '/expenses', icon: 'receipt', keywords: 'reimbursement receipt' });
  if (has('helpdesk:use', 'helpdesk') && !me.permissions['helpdesk:manage']) out.push({ key: 'ask', label: 'Ask HR a question', href: '/helpdesk', icon: 'life-buoy', keywords: 'helpdesk case ticket' });
  return out;
}

/** Palette-only shortcuts to common workflows. */
export function workflowActions(me: Me): QuickAction[] {
  const has = (p: string, f?: string) => Boolean(me.permissions[p]) && (!f || me.features.includes(f));
  const out: QuickAction[] = [{ key: 'approve', label: 'Approve requests', href: '/approvals', icon: 'inbox', keywords: 'approve leave approvals inbox' }];
  if (has('candidates:read', 'recruitment')) out.push({ key: 'find-candidate', label: 'Find candidate', href: '/recruitment/candidates', icon: 'user-search', keywords: 'search applicant' });
  if (has('payroll:read', 'payroll')) out.push({ key: 'payroll', label: 'Open payroll', href: '/payroll', icon: 'wallet', keywords: 'pay run salary' });
  if (has('attendance:approve', 'attendance_basic') && isAdminLevel(me)) out.push({ key: 'exceptions', label: 'Review attendance exceptions', href: '/attendance/team?status=missing_punch', icon: 'users-round', keywords: 'missing punch late absent' });
  if (has('insights:attrition', 'workforce_analytics')) out.push({ key: 'report', label: 'Open attrition report', href: '/insights/attrition', icon: 'trending-down', keywords: 'hr report analytics' });
  out.push({ key: 'theme', label: 'Open Theme Studio', href: '/settings/appearance', icon: 'palette', keywords: 'appearance theme dark light colour density' });
  return out;
}

/**
 * The member's own pages, shown in the avatar menu for everyone. Regular employees reach their own record and sign-in
 * settings here, since Employees and Logins & access are hidden from them when they can only see themselves.
 */
export function accountLinks(me: Pick<Me, 'employee'>): { key: string; label: string; href: string }[] {
  return [
    ...(me.employee ? [{ key: 'profile', label: 'My profile', href: '/profile' }] : []),
    { key: 'settings', label: 'Settings', href: '/settings' },
    { key: 'activity', label: 'Activity log', href: '/activity' },
    { key: 'security', label: 'Password & sign-in', href: '/settings/security' },
    { key: 'appearance', label: 'Appearance', href: '/settings/appearance' },
  ];
}

/**
 * My Day (issue #86): the pages about the person's own work and settings. Everything else in the menu waits until
 * they switch back to My Workforce.
 */
export const MY_DAY_HREFS: ReadonlySet<string> = new Set([
  '/', '/tasks', '/announcements', '/communication', '/help', '/attendance', '/leave', '/payslips', '/expenses', '/appraisal', '/assets/mine',
  '/goals', '/learning', '/onboarding-documents/mine', '/recognition', '/surveys', '/notifications', '/activity', '/settings/notifications', '/settings/appearance', '/settings/signature',
  '/settings/security', '/settings/home', '/profile',
]);

/** People who look after a workforce (Super Workspace and HR Workspace with more than their own record) can switch views. */
export const canSwitchWorkView = (me: Me) => isAdminLevel(me) && Boolean(me.employee) && (me.permissions['employees:read'] ?? 'own') !== 'own';

/** The menu for My Day: only the person's own pages, in the same groups. */
export function myDayNav(nav: NavGroup[]): NavGroup[] {
  return nav.map((g) => ({ ...g, items: g.items.filter((i) => MY_DAY_HREFS.has(i.href)) })).filter((g) => g.items.length);
}

/**
 * The views of Home and the menu, switched at the top of the sidebar (issue #89, replacing the menu filter): the Super
 * Workspace's Organization and Workforce, an HR Workspace's My Workforce, and My Day for anyone who can switch to their
 * own work. Empty or one entry means there is nothing to switch.
 */
export type HomeViewKey = 'organization' | 'workforce' | 'myday';
export const HOME_VIEW_COOKIE = 'crew_home_view';
export function homeViews(me: Me): { key: HomeViewKey; label: string }[] {
  const sup = Boolean(me.levels?.super);
  const seesWorkforce = isAdminLevel(me) && (me.permissions['employees:read'] ?? 'own') !== 'own';
  return [
    ...(sup ? [{ key: 'organization' as const, label: 'Organization' }] : []),
    ...(seesWorkforce ? [{ key: 'workforce' as const, label: sup ? 'Workforce' : 'My Workforce' }] : []),
    ...(canSwitchWorkView(me) ? [{ key: 'myday' as const, label: 'My Day' }] : []),
  ];
}

/** Super Workspace or HR Workspace (company-wide or for named HR Workspaces). */
export const isAdminLevel = (me: Me) => Boolean(me.levels?.super || me.levels?.companyHr || me.levels?.hrWorkspaces?.length);

export function visibleNav(me: Me): NavGroup[] {
  const allowed = (i: NavItem) =>
    (!i.permission || (me.permissions[i.permission] && !(i.beyondOwn && me.permissions[i.permission] === 'own'))) && (!i.anyPermission || i.anyPermission.some((p) => me.permissions[p] && me.permissions[p] !== 'own')) && !(i.hiddenWith && me.permissions[i.hiddenWith]) && !(i.superOnly && !me.levels?.super) && !(i.adminOnly && !isAdminLevel(me)) && !(i.candidateCrm && !me.candidateCrm);
  // A billing admin also sees each module the plan lacks once, with a lock, so they know it exists and can upgrade.
  const upsell = me.permissions['billing:manage'] ? new Set<string>() : null;
  return NAV.map((g) => ({
    ...g,
    items: g.items.flatMap((i): NavItem[] => {
      if (!allowed(i)) return [];
      // Feature management: a page switched off at any level (Console, Super Workspace, HR Workspace) leaves the menu.
      const part = partForWebPath(i.href);
      if (part && me.features.includes(part.feature) && !me.features.includes(part.key)) return [];
      if (!i.feature || me.features.includes(i.feature)) return [i];
      if (!upsell || upsell.has(i.feature) || NOT_SOLD.has(i.feature)) return [];
      upsell.add(i.feature);
      return [{ ...i, href: `/settings/billing?upgrade=${i.feature}`, locked: true }];
    }),
  })).filter((g) => g.items.length);
}

/** Modules agreed with SAMPLEDGE case by case rather than bought on Plan & billing. */
const NOT_SOLD = new Set(['email_signatures']);

export const can = (me: Me, permission: string) => Boolean(me.permissions[permission]);

/**
 * Quick actions on the HR and Super Workspace Home. Each one shows only when the person holds the permission and the
 * module behind it (the API refuses the rest anyway); Super Workspace actions need the Super Workspace level too.
 */
export function homeActions(me: Me, level: 'super' | 'hr'): QuickAction[] {
  const has = (p: string, f?: string) => Boolean(me.permissions[p]) && (!f || me.features.includes(f));
  const wide = (p: string) => Boolean(me.permissions[p]) && me.permissions[p] !== 'own';
  const out: QuickAction[] = [];
  if (level === 'super' && me.levels?.super && has('hierarchy:read')) out.push({ key: 'hr-workspaces', label: 'Manage HR Workspaces', href: '/hr-workspaces', icon: 'network' });
  if (level === 'super' && has('modules:assign')) out.push({ key: 'employee-features', label: 'Manage Employee Workspaces', href: '/employee-features', icon: 'toggle-right' });
  if (has('employees:create')) out.push({ key: 'employee', label: 'Add employee', href: '/employees?create=employee', icon: 'user-plus' });
  if (has('attendance:approve', 'attendance_basic')) out.push({ key: 'attendance', label: level === 'super' ? 'Manage attendance' : 'Mark attendance', href: '/attendance/team', icon: 'users-round' });
  if (has('leave:approve', 'leave')) out.push({ key: 'leave', label: 'Manage leave', href: '/leave/manage', icon: 'calendar' });
  if (has('leavetypes:create', 'leave')) out.push({ key: 'leave-type', label: 'Create leave type', href: '/leave/manage?tab=types', icon: 'calendar' });
  if (has('leave:assign', 'leave')) out.push({ key: 'leave-quantities', label: 'Assign leave quantities', href: '/leave/manage?tab=quantities', icon: 'calendar' });
  if (has('learning:configure', 'learning')) out.push({ key: 'learning-create', label: 'Create learning', href: '/learning/catalogue', icon: 'book-open' });
  if (has('learning:manage', 'learning')) out.push({ key: 'learning-assign', label: 'Assign learning', href: '/learning?view=team', icon: 'graduation-cap' });
  if (has('announcements:manage', 'announcements')) out.push({ key: 'announce', label: 'Send announcement', href: '/announcements/manage/new', icon: 'megaphone' });
  if (wide('employees:read')) out.push({ key: 'employees', label: 'View employees', href: '/employees', icon: 'contact' });
  if (level === 'super' && has('hierarchy:manage')) out.push({ key: 'workspace-permissions', label: 'Workspace Permissions', href: '/settings/workspace-permissions', icon: 'shield-check' });
  if (level === 'super' && has('roles:read')) out.push({ key: 'permissions', label: 'Manage access levels', href: '/people', icon: 'shield' });
  if (wide('employees:read')) out.push({ key: 'reports', label: 'View reports', href: '/insights', icon: 'chart' });
  if (wide('employees:read')) out.push({ key: 'export', label: 'Export report', href: '/employees-export?format=xlsx', icon: 'upload', download: true });
  return out;
}
