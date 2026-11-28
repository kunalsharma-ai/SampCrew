import { type NavItem, flatNav, visibleNav } from './nav';
import type { Me } from './types';

/**
 * The central Settings dashboard: every settings page once, in one of a few categories, with words to search by.
 * Which pages a person sees comes from the menu rules (permission, plan, level and feature switches), so the hub and
 * the menu can never disagree; the API checks every page again.
 */
export interface SettingsCategory { key: string; label: string; description: string; items: (NavItem & { description: string })[] }

const CATEGORIES: { key: string; label: string; description: string }[] = [
  // The six groups of Kunal's spec (28 November 2026), then the modules and the person's own settings.
  { key: 'organization', label: 'Organization', description: 'Your company, its plan, lists and structure.' },
  { key: 'employee', label: 'Employee', description: 'Employee records, forms and onboarding.' },
  { key: 'attendance_leave', label: 'Attendance & Leave', description: 'Leave types, holidays, shifts, offices and devices.' },
  { key: 'requests', label: 'Request & Approval', description: 'Request categories, approval workflows and approval chains.' },
  { key: 'access', label: 'Workspace & Access', description: 'Workspace levels, who may do what, sign-in and security.' },
  { key: 'communication', label: 'Communication', description: 'Email, templates, notifications and help requests.' },
  { key: 'modules', label: 'Modules', description: 'Payroll, appraisals, recruitment, documents and AI.' },
  { key: 'you', label: 'Your account', description: 'Your notifications, look and sign-in.' },
];

const PAGES: Record<string, { category: string; description: string; keywords?: string }> = {
  '/settings/workspace': { category: 'organization', description: 'Company name, logo, time zone and working week.', keywords: 'company profile timezone logo' },
  '/settings/workspace-permissions': { category: 'access', description: 'What each HR Workspace and the Employee Workspaces may do, with templates.', keywords: 'permissions access templates select all hr employee rights' },
  '/settings/hr-admin': { category: 'access', description: 'Modules for each workspace level and the admin shortcuts.', keywords: 'features modules switch' },
  '/settings/roles': { category: 'access', description: 'Who holds Super, HR and Employee Workspace access.', keywords: 'roles levels users' },
  '/settings/requests': { category: 'requests', description: 'Request categories, who may raise them, one, all or one-by-one approval, reminders and leave cancellation.', keywords: 'request types categories workflow sequential any all cancellation reminder' },
  '/settings/approvals': { category: 'requests', description: 'Approval chains for expenses, documents and other approvals.', keywords: 'workflow approver' },
  '/settings/billing': { category: 'organization', description: 'Your plan, invoices and add-ons.', keywords: 'plan invoice subscription upgrade' },
  '/settings/support': { category: 'access', description: 'Let SampCrew support look at your workspace, for a while.', keywords: 'help access' },
  '/settings/mobile-app': { category: 'organization', description: 'What the mobile app shows to your people.', keywords: 'phone android ios' },
  '/settings/notifications/organisation': { category: 'communication', description: 'Which notifications the whole company gets, and which ones people may turn off.', keywords: 'notification policy company alerts' },
  '/settings/master-data': { category: 'organization', description: 'Departments, designations, locations and other lists.', keywords: 'department designation location lists' },
  '/settings/forms': { category: 'employee', description: 'Every form in one place: built-in fields shown, required, renamed; custom fields added, hidden or removed.', keywords: 'fields form custom extra add employee profile leave request work email domain' },
  '/settings/onboarding': { category: 'employee', description: 'Checklists new joiners and their HR work through.', keywords: 'joiner checklist' },
  '/settings/onboarding-documents': { category: 'employee', description: 'The onboarding document library, categories and templates HR assigns to new joiners.', keywords: 'documents library templates joining' },
  '/leave/manage': { category: 'attendance_leave', description: 'Create leave types, choose who sees them, assign quantities, approvals.', keywords: 'leave types visibility quantity casual sick' },
  '/settings/leave': { category: 'attendance_leave', description: 'Holiday calendars and the same-day leave rule.', keywords: 'holiday calendar weekly off' },
  '/settings/attendance': { category: 'attendance_leave', description: 'Shifts, late marks, rewards and attendance rules.', keywords: 'shift late punch' },
  '/settings/attendance-access': { category: 'access', description: 'Which HR Workspaces see and export each other’s attendance.', keywords: 'export visibility' },
  '/attendance/offices': { category: 'attendance_leave', description: 'Office addresses and the check-in radius around each.', keywords: 'office location geofence radius map' },
  '/attendance/work-mode/settings': { category: 'attendance_leave', description: 'Office, home and hybrid rules, and when a day needs checking.', keywords: 'wfh work from home hybrid office rules' },
  '/settings/devices': { category: 'attendance_leave', description: 'Biometric and kiosk devices.', keywords: 'biometric kiosk' },
  '/settings/payroll': { category: 'modules', description: 'Pay components, statutory schemes and payroll rules.', keywords: 'salary pf esi tax' },
  '/settings/appraisals': { category: 'modules', description: 'Appraisal forms and review cycles.', keywords: 'performance review' },
  '/settings/recruitment': { category: 'modules', description: 'Pipelines, sources and recruitment rules.', keywords: 'hiring ats candidates' },
  '/settings/helpdesk': { category: 'communication', description: 'Ticket categories and response targets.', keywords: 'tickets sla' },
  '/settings/document-access': { category: 'modules', description: 'Who may see which document categories.', keywords: 'documents files' },
  '/settings/ai': { category: 'modules', description: 'AI assistant settings.', keywords: 'copilot assistant' },
  '/settings/ai/activity': { category: 'modules', description: 'Everything the AI assistant did.', keywords: 'copilot log' },
  '/settings/single-sign-on': { category: 'access', description: 'Sign in with your company’s identity provider.', keywords: 'sso saml oidc' },
  '/settings/integrations': { category: 'access', description: 'API keys, webhooks and Slack.', keywords: 'api webhook slack keys' },
  '/settings/audit': { category: 'access', description: 'Every change, who made it and when.', keywords: 'log history' },
  '/settings/password-resets': { category: 'access', description: 'Password reset requests and who handled them.', keywords: 'forgot password' },
  '/settings/home': { category: 'you', description: 'Which count cards and sections your Home dashboard shows.', keywords: 'dashboard cards widgets home' },
  '/activity': { category: 'you', description: 'Your sign-ins with IP address and location, and what you did in each.', keywords: 'login ip location sessions access' },
  '/settings/email': { category: 'communication', description: 'Your company’s own email server for invitations and notices.', keywords: 'smtp mail' },
  '/settings/email-templates': { category: 'communication', description: 'Import your company’s own HTML design for the emails SampCrew sends.', keywords: 'email template html branding design layout' },
  '/settings/notifications': { category: 'you', description: 'Which notifications reach you, and where.', keywords: 'email alerts' },
  '/settings/appearance': { category: 'you', description: 'Theme, colours and density.', keywords: 'dark light theme' },
  '/settings/signature': { category: 'you', description: 'Your email signature.', keywords: 'outlook signature' },
  '/settings/security': { category: 'you', description: 'Password and two-step sign-in.', keywords: 'mfa password 2fa' },
};

export function settingsHub(me: Me): SettingsCategory[] {
  const seen = new Set<string>();
  const items = flatNav(visibleNav(me)).filter((i) => PAGES[i.href] && !i.locked && !seen.has(i.href) && seen.add(i.href));
  return CATEGORIES.map((c) => ({
    ...c,
    items: items.filter((i) => PAGES[i.href]!.category === c.key).map((i) => ({ ...i, description: PAGES[i.href]!.description, keywords: PAGES[i.href]!.keywords })),
  })).filter((c) => c.items.length);
}
