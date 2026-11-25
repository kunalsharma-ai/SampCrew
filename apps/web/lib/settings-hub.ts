import { type NavItem, visibleNav } from './nav';
import type { Me } from './types';

/**
 * The central Settings dashboard: every settings page once, in one of a few categories, with words to search by.
 * Which pages a person sees comes from the menu rules (permission, plan, level and feature switches), so the hub and
 * the menu can never disagree; the API checks every page again.
 */
export interface SettingsCategory { key: string; label: string; description: string; items: (NavItem & { description: string })[] }

const CATEGORIES: { key: string; label: string; description: string }[] = [
  { key: 'workspace', label: 'Workspace', description: 'Your company, its plan, structure and who may do what.' },
  { key: 'people', label: 'People and organization', description: 'Records, fields, lists and onboarding.' },
  { key: 'leave', label: 'Leave', description: 'Leave types, quantities, holidays and rules.' },
  { key: 'attendance', label: 'Attendance', description: 'Shifts, rules, devices and who sees what.' },
  { key: 'modules', label: 'Modules', description: 'Payroll, appraisals, recruitment, helpdesk, documents and AI.' },
  { key: 'security', label: 'Security and compliance', description: 'Sign-in, integrations, audit and password resets.' },
  { key: 'you', label: 'Your account', description: 'Your notifications, look and sign-in.' },
];

const PAGES: Record<string, { category: string; description: string; keywords?: string }> = {
  '/settings/workspace': { category: 'workspace', description: 'Company name, logo, time zone and working week.', keywords: 'company profile timezone logo' },
  '/settings/workspace-permissions': { category: 'workspace', description: 'What each HR Workspace and the Employee Workspaces may do, with templates.', keywords: 'permissions access templates select all hr employee rights' },
  '/settings/hr-admin': { category: 'workspace', description: 'Modules for each workspace level and the admin shortcuts.', keywords: 'features modules switch' },
  '/settings/roles': { category: 'workspace', description: 'Who holds Super, HR and Employee Workspace access.', keywords: 'roles levels users' },
  '/settings/approvals': { category: 'workspace', description: 'Approval chains for requests other than leave.', keywords: 'workflow approver' },
  '/settings/billing': { category: 'workspace', description: 'Your plan, invoices and add-ons.', keywords: 'plan invoice subscription upgrade' },
  '/settings/support': { category: 'workspace', description: 'Let SampCrew support look at your workspace, for a while.', keywords: 'help access' },
  '/settings/mobile-app': { category: 'workspace', description: 'What the mobile app shows to your people.', keywords: 'phone android ios' },
  '/settings/master-data': { category: 'people', description: 'Departments, designations, locations and other lists.', keywords: 'department designation location lists' },
  '/settings/custom-fields': { category: 'people', description: 'Extra fields on employee and other records.', keywords: 'fields form' },
  '/settings/onboarding': { category: 'people', description: 'Checklists new joiners and their HR work through.', keywords: 'joiner checklist' },
  '/leave/manage': { category: 'leave', description: 'Create leave types, choose who sees them, assign quantities, approvals.', keywords: 'leave types visibility quantity casual sick' },
  '/settings/leave': { category: 'leave', description: 'Holiday calendars and the same-day leave rule.', keywords: 'holiday calendar weekly off' },
  '/settings/attendance': { category: 'attendance', description: 'Shifts, late marks, rewards and attendance rules.', keywords: 'shift late punch' },
  '/settings/attendance-access': { category: 'attendance', description: 'Which HR Workspaces see and export each other’s attendance.', keywords: 'export visibility' },
  '/settings/devices': { category: 'attendance', description: 'Biometric and kiosk devices.', keywords: 'biometric kiosk' },
  '/settings/payroll': { category: 'modules', description: 'Pay components, statutory schemes and payroll rules.', keywords: 'salary pf esi tax' },
  '/settings/appraisals': { category: 'modules', description: 'Appraisal forms and review cycles.', keywords: 'performance review' },
  '/settings/recruitment': { category: 'modules', description: 'Pipelines, sources and recruitment rules.', keywords: 'hiring ats candidates' },
  '/settings/helpdesk': { category: 'modules', description: 'Ticket categories and response targets.', keywords: 'tickets sla' },
  '/settings/document-access': { category: 'modules', description: 'Who may see which document categories.', keywords: 'documents files' },
  '/settings/ai': { category: 'modules', description: 'AI assistant settings.', keywords: 'copilot assistant' },
  '/settings/ai/activity': { category: 'modules', description: 'Everything the AI assistant did.', keywords: 'copilot log' },
  '/settings/single-sign-on': { category: 'security', description: 'Sign in with your company’s identity provider.', keywords: 'sso saml oidc' },
  '/settings/integrations': { category: 'security', description: 'API keys, webhooks and Slack.', keywords: 'api webhook slack keys' },
  '/settings/audit': { category: 'security', description: 'Every change, who made it and when.', keywords: 'log history' },
  '/settings/password-resets': { category: 'security', description: 'Password reset requests and who handled them.', keywords: 'forgot password' },
  '/settings/home': { category: 'you', description: 'Which count cards and sections your Home dashboard shows.', keywords: 'dashboard cards widgets home' },
  '/activity': { category: 'you', description: 'Your sign-ins with IP address and location, and what you did in each.', keywords: 'login ip location sessions access' },
  '/settings/email': { category: 'workspace', description: 'Your company’s own email server for invitations and notices.', keywords: 'smtp mail' },
  '/settings/notifications': { category: 'you', description: 'Which notifications reach you, and where.', keywords: 'email alerts' },
  '/settings/appearance': { category: 'you', description: 'Theme, colours and density.', keywords: 'dark light theme' },
  '/settings/signature': { category: 'you', description: 'Your email signature.', keywords: 'outlook signature' },
  '/settings/security': { category: 'you', description: 'Password and two-step sign-in.', keywords: 'mfa password 2fa' },
};

export function settingsHub(me: Me): SettingsCategory[] {
  const seen = new Set<string>();
  const items = visibleNav(me).flatMap((g) => g.items).filter((i) => PAGES[i.href] && !i.locked && !seen.has(i.href) && seen.add(i.href));
  return CATEGORIES.map((c) => ({
    ...c,
    items: items.filter((i) => PAGES[i.href]!.category === c.key).map((i) => ({ ...i, description: PAGES[i.href]!.description, keywords: PAGES[i.href]!.keywords })),
  })).filter((c) => c.items.length);
}
