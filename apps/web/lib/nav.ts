import type { Me } from './types';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Visible when the user holds this permission (any scope). */
  permission?: string;
  /** Hidden when the permission covers only the person's own record (an organization view of one person is empty). */
  beyondOwn?: boolean;
  /** Visible when the plan includes this feature. */
  feature?: string;
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
      { href: '/tasks', label: 'My tasks', icon: 'list-checks', feature: 'onboarding' },
      { href: '/announcements', label: 'Announcements', icon: 'megaphone', permission: 'announcements:read', feature: 'announcements' },
      { href: '/helpdesk', label: 'Ask HR', icon: 'life-buoy', permission: 'helpdesk:use', feature: 'helpdesk' },
    ],
  },
  {
    label: 'My work',
    items: [
      { href: '/attendance', label: 'Attendance', icon: 'clock', permission: 'attendance:punch', feature: 'attendance_basic' },
      { href: '/leave', label: 'Leave', icon: 'calendar', permission: 'leave:request', feature: 'leave' },
      { href: '/payslips', label: 'Payslips', icon: 'file-text', permission: 'payslips:read', feature: 'payroll' },
      { href: '/expenses', label: 'Expenses', icon: 'receipt', permission: 'expenses:submit', feature: 'expenses' },
      { href: '/recruitment/interviews', label: 'My interviews', icon: 'message-square', permission: 'interviews:feedback', feature: 'recruitment' },
    ],
  },
  {
    label: 'Employee management',
    items: [
      { href: '/employees', label: 'Employees', icon: 'contact', permission: 'employees:read', beyondOwn: true },
      { href: '/organization', label: 'Structure', icon: 'building', permission: 'org:read' },
      { href: '/people', label: 'Logins & access', icon: 'users', permission: 'users:read', beyondOwn: true },
      { href: '/settings/onboarding', label: 'Onboarding checklists', icon: 'list-checks', permission: 'employees:create', feature: 'onboarding' },
    ],
  },
  {
    label: 'Recruitment & ATS',
    items: [
      { href: '/recruitment', label: 'Jobs', icon: 'briefcase', permission: 'requisitions:read', feature: 'recruitment' },
      { href: '/recruitment/candidates', label: 'Candidates', icon: 'user-search', permission: 'candidates:read', feature: 'recruitment' },
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
      { href: '/attendance/team', label: 'Team attendance', icon: 'users-round', permission: 'attendance:approve', feature: 'attendance_basic' },
      { href: '/shifts', label: 'Shifts', icon: 'calendar-clock', permission: 'shifts:read', feature: 'shift_scheduling' },
      { href: '/settings/attendance', label: 'Attendance settings', icon: 'timer', permission: 'attendance:configure', feature: 'attendance_basic' },
      { href: '/settings/devices', label: 'Attendance devices', icon: 'fingerprint', permission: 'devices:manage', feature: 'attendance_advanced' },
      { href: '/settings/leave', label: 'Leave settings', icon: 'sliders', permission: 'leave:configure', feature: 'leave' },
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
      { href: '/reviews/cycles', label: 'Review cycles', icon: 'calendar-range', permission: 'performance:configure', feature: 'performance' },
      { href: '/learning', label: 'Learning', icon: 'graduation-cap', permission: 'learning:read', feature: 'learning' },
      { href: '/learning/catalogue', label: 'Course catalogue', icon: 'book-open', permission: 'learning:configure', feature: 'learning' },
    ],
  },
  {
    label: 'Engagement & relations',
    items: [
      { href: '/recognition', label: 'Recognition', icon: 'heart', permission: 'recognition:give', feature: 'engagement' },
      { href: '/surveys', label: 'Surveys', icon: 'clipboard-list', permission: 'surveys:respond', feature: 'engagement' },
      { href: '/surveys/manage', label: 'Survey results', icon: 'chart', permission: 'engagement:manage', feature: 'engagement' },
      { href: '/announcements/manage', label: 'Manage announcements', icon: 'megaphone', permission: 'announcements:manage', feature: 'announcements' },
      { href: '/helpdesk/queue', label: 'HR helpdesk queue', icon: 'headset', permission: 'helpdesk:manage', feature: 'helpdesk' },
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
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/settings/roles', label: 'Roles & permissions', icon: 'shield', permission: 'roles:read' },
      { href: '/settings/single-sign-on', label: 'Single sign-on', icon: 'lock-keyhole', permission: 'security:manage', feature: 'sso' },
      { href: '/settings/integrations', label: 'Integrations', icon: 'plug', permission: 'integrations:manage', feature: 'integrations_advanced' },
      { href: '/settings/billing', label: 'Plan & billing', icon: 'credit-card', permission: 'billing:read' },
      { href: '/settings/workspace', label: 'Workspace settings', icon: 'settings', permission: 'tenant:read' },
      { href: '/settings/signature/company', label: 'Email signatures', icon: 'mail', permission: 'org:manage', feature: 'email_signatures' },
      { href: '/settings/support', label: 'Support access', icon: 'life-buoy', permission: 'tenant:read' },
    ],
  },
  {
    label: 'You',
    items: [
      { href: '/settings/appearance', label: 'Appearance', icon: 'palette' },
      { href: '/settings/signature', label: 'Email signature', icon: 'mail', feature: 'email_signatures' },
      { href: '/settings/security', label: 'Security', icon: 'key' },
    ],
  },
];

export interface QuickAction { key: string; label: string; href: string; icon: string; keywords?: string }

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
  if (has('helpdesk:use', 'helpdesk')) out.push({ key: 'ask', label: 'Ask HR a question', href: '/helpdesk', icon: 'life-buoy', keywords: 'helpdesk case ticket' });
  return out;
}

/** Palette-only shortcuts to common workflows. */
export function workflowActions(me: Me): QuickAction[] {
  const has = (p: string, f?: string) => Boolean(me.permissions[p]) && (!f || me.features.includes(f));
  const out: QuickAction[] = [{ key: 'approve', label: 'Approve requests', href: '/approvals', icon: 'inbox', keywords: 'approve leave approvals inbox' }];
  if (has('candidates:read', 'recruitment')) out.push({ key: 'find-candidate', label: 'Find candidate', href: '/recruitment/candidates', icon: 'user-search', keywords: 'search applicant' });
  if (has('payroll:read', 'payroll')) out.push({ key: 'payroll', label: 'Open payroll', href: '/payroll', icon: 'wallet', keywords: 'pay run salary' });
  if (has('attendance:approve', 'attendance_basic')) out.push({ key: 'exceptions', label: 'Review attendance exceptions', href: '/attendance/team?status=missing_punch', icon: 'users-round', keywords: 'missing punch late absent' });
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
    ...(me.employee ? [{ key: 'profile', label: 'My profile', href: `/employees/${me.employee.id}` }] : []),
    { key: 'security', label: 'Password & sign-in', href: '/settings/security' },
    { key: 'appearance', label: 'Appearance', href: '/settings/appearance' },
  ];
}

export function visibleNav(me: Me): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => (!i.permission || (me.permissions[i.permission] && !(i.beyondOwn && me.permissions[i.permission] === 'own'))) && (!i.feature || me.features.includes(i.feature))) })).filter((g) => g.items.length);
}

export const can = (me: Me, permission: string) => Boolean(me.permissions[permission]);
