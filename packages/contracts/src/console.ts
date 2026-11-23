import { z } from 'zod';

/**
 * The SampCrew Console (SAMPLEDGE staff): permissions, roles, clients, notifications, the command center, reports
 * and global search. Shared by the API (which enforces every permission) and the Console (which only hides what the
 * API would refuse anyway).
 */

// ---------------------------------------------------------------------------------------------------------------
// Permissions and roles
// ---------------------------------------------------------------------------------------------------------------

export const CONSOLE_PERMISSION_AREAS = ['companies', 'users', 'billing', 'plans', 'communication', 'reports', 'audit', 'platform', 'security'] as const;
export type ConsolePermissionArea = (typeof CONSOLE_PERMISSION_AREAS)[number];

export const CONSOLE_AREA_LABEL: Record<ConsolePermissionArea, string> = {
  companies: 'Companies and workspaces',
  users: 'Users',
  billing: 'Subscriptions and billing',
  plans: 'Plans and pricing',
  communication: 'Communication and support',
  reports: 'Reports',
  audit: 'Audit log',
  platform: 'Platform and settings',
  security: 'Console security',
};

export interface ConsolePermission {
  key: string;
  area: ConsolePermissionArea;
  label: string;
  description: string;
  /** Needs another permission to be useful (the editor ticks it too). */
  needs?: string;
}

/**
 * Every Console permission. The keys of the first release (tenants:read, billing:manage...) are kept as they are,
 * so older sessions, scripts and the audit trail keep their meaning.
 */
export const CONSOLE_PERMISSIONS: readonly ConsolePermission[] = [
  { key: 'tenants:read', area: 'companies', label: 'View companies', description: 'Clients, their Super, HR and Employee Workspaces, counts and status. No personal contact details.' },
  { key: 'tenants:manage', area: 'companies', label: 'Manage companies', description: 'Create companies and workspaces, edit company profiles, suspend, activate and archive.', needs: 'tenants:read' },
  { key: 'users:read', area: 'users', label: 'View users', description: 'Names, levels, status and last sign-in of people in client workspaces.', needs: 'tenants:read' },
  { key: 'users:pii', area: 'users', label: 'See contact details', description: 'Email addresses and phone numbers of client users and contacts. Without it they are masked.', needs: 'users:read' },
  { key: 'access:manage', area: 'users', label: 'Manage access', description: 'Switch features, permissions and apps for a workspace; suspend users, reset sign-ins; read activity contents.', needs: 'users:read' },
  { key: 'billing:read', area: 'billing', label: 'View billing', description: 'Revenue, subscriptions, invoices, payments and refunds.' },
  { key: 'billing:manage', area: 'billing', label: 'Manage subscriptions', description: 'Change, extend, suspend, reactivate or cancel subscriptions; discounts, invoices, coupons and add-ons.', needs: 'billing:read' },
  { key: 'billing:refund', area: 'billing', label: 'Refunds and credits', description: 'Record refunds and issue credit notes on paid invoices.', needs: 'billing:read' },
  { key: 'plans:manage', area: 'plans', label: 'Manage plans', description: 'Create, edit, duplicate, retire and archive plans and their prices and limits.', needs: 'billing:read' },
  { key: 'support:chat', area: 'communication', label: 'Client conversations', description: 'Read and answer conversations with client Super Workspaces; assign and resolve them.' },
  { key: 'help:answer', area: 'communication', label: 'Support tickets', description: 'Answer, assign and close help queries raised to SampCrew Support.' },
  { key: 'help:manage', area: 'communication', label: 'Help content', description: 'Write the help articles and FAQs every level sees.' },
  { key: 'support:request', area: 'communication', label: 'View as (support access)', description: 'Ask a client for time-boxed support access and open its read-only view once approved. Every view is logged.', needs: 'tenants:read' },
  { key: 'reports:read', area: 'reports', label: 'View reports', description: 'Business, workspace, subscription and payment reports.' },
  { key: 'reports:export', area: 'reports', label: 'Export reports', description: 'Download reports and lists as CSV, Excel or PDF.', needs: 'reports:read' },
  { key: 'audit:read', area: 'audit', label: 'View audit log', description: 'Every privileged action with before and after values, IP and device.' },
  { key: 'audit:export', area: 'audit', label: 'Export audit log', description: 'Download the audit log.', needs: 'audit:read' },
  { key: 'health:read', area: 'platform', label: 'System health', description: 'Service status, response times, errors, background jobs and backups.' },
  { key: 'integrations:manage', area: 'platform', label: 'Integrations', description: 'API keys of email, payments, push, AI, company data and other services.' },
  { key: 'statutory:manage', area: 'platform', label: 'Payroll country packs', description: 'Statutory rules per country.' },
  { key: 'settings:manage', area: 'platform', label: 'Global settings', description: 'Workspace and user defaults, notification, communication and security settings.' },
  { key: 'admins:manage', area: 'security', label: 'Console admins', description: 'Add, disable and reset Console admins.' },
  { key: 'roles:manage', area: 'security', label: 'Roles and permissions', description: 'Create custom Console roles and change what each role can do.', needs: 'admins:manage' },
  { key: 'security:manage', area: 'security', label: 'Sessions and security', description: 'See every admin\'s sign-ins and sessions and sign them out.' },
  { key: 'records:delete', area: 'security', label: 'Delete records', description: 'Delete or archive in the Console: client companies, plans, Console roles, help content, payroll country packs and integration keys (each also needs its own manage permission). Every delete asks for the admin\'s password.' },
];

export const CONSOLE_PERMISSION_KEYS = CONSOLE_PERMISSIONS.map((p) => p.key);
const ALL = CONSOLE_PERMISSION_KEYS;

export interface ConsoleSystemRole {
  key: string;
  name: string;
  description: string;
  permissions: readonly string[];
}

/**
 * The built-in Console roles. The first four keep the keys admins already hold (super_admin, support, billing_ops,
 * viewer), so every existing admin keeps a role; their permissions only grow where the new areas need them.
 */
export const CONSOLE_SYSTEM_ROLES: readonly ConsoleSystemRole[] = [
  { key: 'super_admin', name: 'Super Admin', description: 'Everything, including Console admins, roles and security.', permissions: ALL },
  {
    key: 'admin', name: 'Admin', description: 'Runs the platform day to day: everything except Console admins, roles and other admins\' sessions.',
    permissions: ALL.filter((k) => !['admins:manage', 'roles:manage', 'security:manage'].includes(k)),
  },
  {
    key: 'billing_ops', name: 'Finance Admin', description: 'Revenue, subscriptions, invoices, refunds, plans and financial reports.',
    permissions: ['tenants:read', 'billing:read', 'billing:manage', 'billing:refund', 'plans:manage', 'reports:read', 'reports:export', 'records:delete'],
  },
  {
    key: 'support', name: 'Support Admin', description: 'Client conversations, tickets and support access; reads companies, users and health.',
    permissions: ['tenants:read', 'users:read', 'users:pii', 'support:request', 'support:chat', 'help:answer', 'health:read', 'audit:read'],
  },
  {
    key: 'operations', name: 'Operations Admin', description: 'Companies, workspaces, access, onboarding, country packs and system health.',
    permissions: ['tenants:read', 'tenants:manage', 'users:read', 'access:manage', 'health:read', 'statutory:manage', 'audit:read', 'reports:read', 'records:delete'],
  },
  { key: 'viewer', name: 'Read Only Admin', description: 'Sees companies, billing, reports and health; changes nothing.', permissions: ['tenants:read', 'billing:read', 'health:read', 'reports:read'] },
];

export const CONSOLE_ROLE_NAME: Record<string, string> = Object.fromEntries(CONSOLE_SYSTEM_ROLES.map((r) => [r.key, r.name]));

/** A role key: lower case letters, digits and underscores. */
export const consoleRoleKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use 2-40 lower-case letters, digits or underscores');

export const consoleRoleInput = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).default(''),
    permissions: z.array(z.enum(CONSOLE_PERMISSION_KEYS as [string, ...string[]])).max(CONSOLE_PERMISSION_KEYS.length),
  })
  .strict();
export type ConsoleRoleInput = z.infer<typeof consoleRoleInput>;

export interface ConsoleRole {
  key: string;
  name: string;
  description: string;
  permissions: string[];
  system: boolean;
  admins: number;
  archived: boolean;
  updatedAt: string | null;
}

/** Adds the permissions each picked permission needs (the editor and the API both apply it). */
export function withNeededPermissions(keys: readonly string[]): string[] {
  const out = new Set(keys);
  let grew = true;
  while (grew) {
    grew = false;
    for (const k of [...out]) {
      const need = CONSOLE_PERMISSIONS.find((p) => p.key === k)?.needs;
      if (need && !out.has(need)) { out.add(need); grew = true; }
    }
  }
  return CONSOLE_PERMISSION_KEYS.filter((k) => out.has(k));
}

// ---------------------------------------------------------------------------------------------------------------
// Clients (companies)
// ---------------------------------------------------------------------------------------------------------------

export const CLIENT_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'] as const;
export const CLIENT_INDUSTRIES = ['it_services', 'manufacturing', 'retail', 'healthcare', 'staffing', 'financial_services', 'education', 'logistics', 'hospitality', 'construction', 'other'] as const;
export const CLIENT_INDUSTRY_LABEL: Record<(typeof CLIENT_INDUSTRIES)[number], string> = {
  it_services: 'IT services', manufacturing: 'Manufacturing', retail: 'Retail', healthcare: 'Healthcare', staffing: 'Staffing',
  financial_services: 'Financial services', education: 'Education', logistics: 'Logistics', hospitality: 'Hospitality', construction: 'Construction', other: 'Other',
};

/** Account status of a client, worked out from its Super Workspaces and subscriptions (never typed in). */
export const CLIENT_STATUSES = ['active', 'trial', 'payment_due', 'suspended', 'inactive', 'setup_pending', 'archived'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  active: 'Active', trial: 'Trial', payment_due: 'Payment due', suspended: 'Suspended', inactive: 'Inactive', setup_pending: 'Setup pending', archived: 'Archived',
};

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const optionalUrl = z.string().trim().max(200).regex(/^https?:\/\/\S+$/, 'Start with http:// or https://').nullable().optional().or(z.literal('').transform(() => null));
const optionalEmail = z.email('Enter a valid email').max(200).nullable().optional().or(z.literal('').transform(() => null));
const optionalPhone = z.string().trim().max(30).regex(/^[+0-9 ()-]*$/, 'Digits, spaces, + ( ) - only').nullable().optional().transform((v) => (v ? v : null));

export const clientAddress = z
  .object({
    line1: optionalText(160), line2: optionalText(160), city: optionalText(80), state: optionalText(80), postalCode: optionalText(20),
    country: z.string().regex(/^[A-Z]{2}$/, 'A 2-letter country code').nullable().optional(),
  })
  .strict();

export const clientProfileInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    legalName: optionalText(200),
    industry: z.enum(CLIENT_INDUSTRIES).nullable().optional(),
    description: optionalText(2000),
    website: optionalUrl,
    linkedin: optionalUrl,
    email: optionalEmail,
    phone: optionalPhone,
    whatsapp: optionalPhone,
    foundedYear: z.number().int().min(1800).max(2100).nullable().optional(),
    companySize: z.enum(CLIENT_SIZES).nullable().optional(),
    address: clientAddress.nullable().optional(),
    primaryContact: z.object({ name: optionalText(120), email: optionalEmail, phone: optionalPhone, title: optionalText(120) }).strict().nullable().optional(),
    accountManagerId: z.uuid().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .strict();
export type ClientProfileInput = z.infer<typeof clientProfileInput>;

export const clientsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
  plan: z.string().max(60).optional(),
  industry: z.enum(CLIENT_INDUSTRIES).optional(),
  size: z.enum(CLIENT_SIZES).optional(),
  paid: z.enum(['paid', 'free', 'enterprise']).optional(),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  subscribedFrom: z.iso.date().optional(),
  subscribedTo: z.iso.date().optional(),
  renewalWithinDays: z.coerce.number().int().min(0).max(365).optional(),
  sort: z.enum(['name', 'created', 'revenue', 'users', 'renewal', 'activity']).default('created'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  demo: z.enum(['include', 'exclude', 'only']).default('include'),
});
export type ClientsQuery = z.infer<typeof clientsQuery>;

export interface ClientRow {
  id: string;
  name: string;
  logoUrl: string | null;
  industry: string | null;
  location: string | null;
  companySize: string | null;
  plan: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  status: ClientStatus;
  users: number;
  hrUsers: number;
  employees: number;
  superWorkspaces: number;
  hrWorkspaces: number;
  employeeWorkspaces: number;
  /** Paid invoices to date, per currency. */
  revenue: Record<string, string>;
  mrr: Record<string, string>;
  paymentStatus: 'paid' | 'due' | 'overdue' | 'none';
  outstanding: Record<string, string>;
  subscriptionStart: string | null;
  nextRenewal: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  isDemo: boolean;
  primaryWorkspaceId: string | null;
}

export const clientBulkAction = z
  .object({
    action: z.enum(['suspend', 'activate', 'tag', 'assign_manager']),
    ids: z.array(z.uuid()).min(1).max(200),
    reason: z.string().trim().min(3).max(500).optional(),
    tag: z.string().trim().min(1).max(40).optional(),
    accountManagerId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => v.action !== 'suspend' || !!v.reason, { message: 'Give a reason for suspending', path: ['reason'] })
  .refine((v) => v.action !== 'tag' || !!v.tag, { message: 'Name the tag', path: ['tag'] });

// ---------------------------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------------------------

export const CONSOLE_NOTIFICATION_CATEGORIES = ['clients', 'workspaces', 'users', 'subscriptions', 'payments', 'support', 'security', 'system', 'admin'] as const;
export type ConsoleNotificationCategory = (typeof CONSOLE_NOTIFICATION_CATEGORIES)[number];
export const CONSOLE_NOTIFICATION_CATEGORY_LABEL: Record<ConsoleNotificationCategory, string> = {
  clients: 'New companies', workspaces: 'Workspaces', users: 'Users', subscriptions: 'Subscriptions and renewals', payments: 'Payments',
  support: 'Support messages and tickets', security: 'Security events', system: 'System health and errors', admin: 'Console admin actions',
};
/** The permission a category needs: admins without it never see those notifications. */
export const CONSOLE_NOTIFICATION_CAP: Record<ConsoleNotificationCategory, string> = {
  clients: 'tenants:read', workspaces: 'tenants:read', users: 'users:read', subscriptions: 'billing:read', payments: 'billing:read',
  support: 'support:chat', security: 'security:manage', system: 'health:read', admin: 'audit:read',
};
export const CONSOLE_NOTIFICATION_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type ConsoleNotificationPriority = (typeof CONSOLE_NOTIFICATION_PRIORITIES)[number];

export interface ConsoleNotification {
  id: string;
  category: ConsoleNotificationCategory;
  kind: string;
  priority: ConsoleNotificationPriority;
  title: string;
  body: string | null;
  href: string | null;
  clientId: string | null;
  tenantId: string | null;
  companyName: string | null;
  createdAt: string;
  read: boolean;
}

export interface ConsoleNotificationPrefs {
  /** Categories switched off for this admin (they still count in history, never in the badge or bell). */
  muted: ConsoleNotificationCategory[];
  /** A sound for new high and urgent notifications. Off unless the admin turns it on. */
  sound: boolean;
  /** A desktop notification (browser permission) for urgent ones. */
  desktop: boolean;
}

export const consoleNotificationPrefsInput = z
  .object({ muted: z.array(z.enum(CONSOLE_NOTIFICATION_CATEGORIES)).max(CONSOLE_NOTIFICATION_CATEGORIES.length), sound: z.boolean(), desktop: z.boolean() })
  .strict();

export const consoleNotificationsQuery = z.object({
  category: z.enum(CONSOLE_NOTIFICATION_CATEGORIES).optional(),
  unread: z.enum(['true', 'false']).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export interface ConsoleNotificationSummary {
  unread: number;
  byCategory: Partial<Record<ConsoleNotificationCategory, number>>;
  latest: ConsoleNotification[];
  prefs: ConsoleNotificationPrefs;
}

// ---------------------------------------------------------------------------------------------------------------
// Command center (dashboard)
// ---------------------------------------------------------------------------------------------------------------

export const COMMAND_RANGES = ['today', '7d', '30d', '3m', '6m', '1y', 'custom'] as const;
export type CommandRange = (typeof COMMAND_RANGES)[number];
export const COMMAND_RANGE_LABEL: Record<CommandRange, string> = { today: 'Today', '7d': '7 days', '30d': '30 days', '3m': '3 months', '6m': '6 months', '1y': '1 year', custom: 'Custom' };

export const commandCenterQuery = z
  .object({ range: z.enum(COMMAND_RANGES).default('30d'), from: z.iso.date().optional(), to: z.iso.date().optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional() })
  .refine((v) => v.range !== 'custom' || (v.from && v.to && v.from <= v.to), { message: 'Pick a start and an end date', path: ['from'] });
export type CommandCenterQuery = z.infer<typeof commandCenterQuery>;

export interface ConsoleSeriesPoint { label: string; start: string; values: Record<string, number> }

export interface CommandCenter {
  range: { key: CommandRange; from: string; to: string; bucket: 'hour' | 'day' | 'week' | 'month' };
  currency: string;
  currencies: string[];
  workspaces: {
    companies: number; superWorkspaces: number; hrWorkspaces: number; employeeWorkspaces: number;
    activeUsers: number; employees: number; hrAdminUsers: number;
    newCompanies: number; newWorkspaces: number; newCompaniesThisMonth: number; newWorkspacesThisMonth: number;
    active: number; inactive: number; suspended: number; setupPending: number; demo: number;
  };
  revenue: {
    total: string; mrr: string; arr: string; thisMonth: string; thisYear: string; previousMonth: string; inRange: string;
    outstanding: string; pending: string; failedPayments: number; failedAmount: string; refunded: string;
    activeSubscriptions: number; expiringSoon: number; renewalsDue: number; cancelled: number; trials: number;
    conversionRate: number | null; arpa: string; churnRate: number | null;
  };
  plans: { key: string; name: string; companies: number; paying: number; trialing: number; mrr: string }[];
  subscriptions: {
    mostPopular: string | null; free: number; paid: number; enterprise: number; trial: number;
    upcomingRenewals: { clientId: string | null; tenantId: string; name: string; on: string; plan: string | null; amount: string }[];
    expiring: { clientId: string | null; tenantId: string; name: string; on: string; plan: string | null; reason: 'trial' | 'cancelling' }[];
    upgraded: { clientId: string | null; tenantId: string; name: string; at: string; from: string | null; to: string | null }[];
    downgraded: { clientId: string | null; tenantId: string; name: string; at: string; from: string | null; to: string | null }[];
    cancelled: { clientId: string | null; tenantId: string; name: string; at: string; plan: string | null }[];
  };
  series: {
    growth: ConsoleSeriesPoint[];
    revenue: ConsoleSeriesPoint[];
    subscriptions: ConsoleSeriesPoint[];
    payments: ConsoleSeriesPoint[];
    outstanding: ConsoleSeriesPoint[];
  };
  growing: { clientId: string | null; tenantId: string; name: string; added: number; total: number }[];
  attention: { key: string; level: 'info' | 'warning' | 'critical'; title: string; detail: string | null; href: string; count: number | null }[];
  support: { openConversations: number; unread: number; openTickets: number; waitingTickets: number };
  system: { status: 'operational' | 'warning' | 'critical'; issues: string[] };
  activity: ActivityFeedItem[];
}

export interface ActivityFeedItem {
  id: string;
  at: string;
  kind: string;
  title: string;
  company: string | null;
  clientId: string | null;
  tenantId: string | null;
  user: string | null;
  status: 'success' | 'warning' | 'danger' | 'info';
  href: string | null;
  action: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Audit, sessions, search, reports
// ---------------------------------------------------------------------------------------------------------------

export const consoleAuditQuery = z.object({
  q: z.string().trim().max(120).optional(),
  action: z.string().trim().max(80).optional(),
  actorType: z.enum(['user', 'platform_admin', 'system', 'ai_agent', 'integration']).optional(),
  actorId: z.uuid().optional(),
  tenantId: z.uuid().optional(),
  /** A client company: its own Console events and everything in its Super Workspaces. */
  clientId: z.uuid().optional(),
  area: z.enum(['companies', 'workspaces', 'users', 'plans', 'billing', 'admins', 'security', 'communication', 'settings', 'other']).optional(),
  status: z.enum(['success', 'denied', 'failed']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  scope: z.enum(['platform', 'all']).default('platform'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ConsoleAuditQuery = z.infer<typeof consoleAuditQuery>;

export interface ConsoleAuditRow {
  id: string;
  at: string;
  action: string;
  label: string;
  area: string;
  status: 'success' | 'denied' | 'failed';
  actorType: string;
  actor: string | null;
  actorId: string | null;
  tenantId: string | null;
  company: string | null;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  changes: unknown;
  metadata: unknown;
  ip: string | null;
  device: string | null;
}

export interface ConsoleSessionRow {
  id: string;
  adminId: string;
  admin: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  ip: string | null;
  device: string | null;
  mfa: boolean;
  current: boolean;
  active: boolean;
}

export interface ConsoleLoginRow { at: string; adminId: string | null; admin: string | null; ok: boolean; ip: string | null; device: string | null; detail: string | null }

export interface SecurityOverview {
  sessions: ConsoleSessionRow[];
  logins: ConsoleLoginRow[];
  suspicious: { key: string; level: 'warning' | 'critical'; title: string; detail: string; at: string }[];
  admins: { total: number; withoutMfa: number; locked: number; disabled: number };
}

export const SEARCH_TYPES = ['company', 'workspace', 'hr_workspace', 'user', 'subscription', 'invoice', 'payment', 'plan', 'conversation', 'ticket', 'audit', 'admin'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export const SEARCH_TYPE_LABEL: Record<SearchType, string> = {
  company: 'Company', workspace: 'Super Workspace', hr_workspace: 'HR Workspace', user: 'User', subscription: 'Subscription', invoice: 'Invoice', payment: 'Payment',
  plan: 'Plan', conversation: 'Conversation', ticket: 'Ticket', audit: 'Audit log', admin: 'Console admin',
};
export const consoleSearchQuery = z.object({ q: z.string().trim().min(2).max(120), types: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(20).default(6) });
export interface SearchHit { type: SearchType; id: string; title: string; subtitle: string | null; href: string }
export interface SearchResults { q: string; hits: SearchHit[]; skipped: SearchType[] }

export const REPORT_KINDS = ['business', 'workspaces', 'subscriptions', 'payments'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_LABEL: Record<ReportKind, string> = { business: 'Business', workspaces: 'Workspaces', subscriptions: 'Subscriptions', payments: 'Payments' };
export const reportQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  clientId: z.uuid().optional(),
  plan: z.string().max(60).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
});
export type ReportQuery = z.infer<typeof reportQuery>;

export interface ReportResult {
  kind: ReportKind;
  title: string;
  from: string;
  to: string;
  currency: string;
  summary: { label: string; value: string; hint?: string }[];
  series: ConsoleSeriesPoint[];
  seriesKeys: { key: string; label: string }[];
  table: { columns: { key: string; label: string; align?: 'right' }[]; rows: Record<string, string | number | null>[] };
}

// ---------------------------------------------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------------------------------------------

export const consoleSettingsInput = z
  .object({
    workspaceDefaults: z.object({ trialDays: z.number().int().min(0).max(90), defaultPlan: z.string().max(60).nullable(), requireMfa: z.boolean(), region: z.enum(['in', 'eu', 'us', 'uk', 'me', 'sg', 'au']) }).strict(),
    userDefaults: z.object({ inviteExpiryDays: z.number().int().min(1).max(30), ownerAccess: z.enum(['invite', 'password']) }).strict(),
    communication: z.object({ supportHours: z.string().trim().max(120), autoReply: z.string().trim().max(1000), firstResponseHours: z.number().int().min(1).max(168) }).strict(),
    security: z.object({ sessionHours: z.number().int().min(1).max(72), lockoutAttempts: z.number().int().min(3).max(20), lockoutMinutes: z.number().int().min(1).max(1440), suspiciousFailedLogins: z.number().int().min(3).max(100) }).strict(),
    notifications: z.object({ renewalNoticeDays: z.number().int().min(1).max(60), inactiveAfterDays: z.number().int().min(7).max(365) }).strict(),
    branding: z.object({ consoleName: z.string().trim().min(1).max(60), supportEmail: z.email().nullable(), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable() }).strict(),
  })
  .strict();
export type ConsoleSettings = z.infer<typeof consoleSettingsInput>;

export const DEFAULT_CONSOLE_SETTINGS: ConsoleSettings = {
  workspaceDefaults: { trialDays: 14, defaultPlan: null, requireMfa: false, region: 'in' },
  userDefaults: { inviteExpiryDays: 7, ownerAccess: 'invite' },
  communication: { supportHours: 'Monday to Friday, 9:00 to 18:00 IST', autoReply: '', firstResponseHours: 24 },
  security: { sessionHours: 12, lockoutAttempts: 5, lockoutMinutes: 15, suspiciousFailedLogins: 10 },
  notifications: { renewalNoticeDays: 14, inactiveAfterDays: 30 },
  branding: { consoleName: 'SampCrew Console', supportEmail: null, accent: null },
};

// ---------------------------------------------------------------------------------------------------------------
// Refunds and credit notes
// ---------------------------------------------------------------------------------------------------------------

const money2 = z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, 'An amount like 1500 or 1500.50');

/**
 * A refund against a paid invoice. "gateway" returns the money through Razorpay or Stripe (the invoice must have been
 * paid there); "bank_transfer" records money SAMPLEDGE sent back by hand, with its reference. Either way a credit note
 * (CN-…) is issued. Needs billing:refund and the admin's two-step verification.
 */
export const refundInput = z.object({
  invoiceId: z.uuid(),
  amount: money2,
  method: z.enum(['gateway', 'bank_transfer']),
  reason: z.string().trim().min(3).max(500),
  reference: z.string().trim().max(120).optional(),
}).strict();
export type RefundInput = z.infer<typeof refundInput>;
export const creditNoteVoidInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export interface CreditNoteView {
  id: string; number: string; tenantId: string; workspace: string; clientId: string | null; invoiceId: string | null; invoiceNumber: string | null; kind: 'refund' | 'credit';
  method: 'gateway' | 'bank_transfer' | 'account_credit'; amount: string; currency: string; reason: string; providerRef: string | null; status: 'issued' | 'void'; voidReason: string | null;
  createdAt: string; createdBy: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Plan lifecycle
// ---------------------------------------------------------------------------------------------------------------

export const PLAN_LIFECYCLE = ['draft', 'active', 'archived', 'retired'] as const;
export type PlanLifecycle = (typeof PLAN_LIFECYCLE)[number];
export const PLAN_LIFECYCLE_LABEL: Record<PlanLifecycle, string> = {
  draft: 'Draft (hidden)', active: 'Active', archived: 'Archived (no new sign-ups)', retired: 'Retired (closed for good, subscribers keep it)',
};
export const planDuplicateInput = z.object({ key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Lower case letters, digits and _'), name: z.string().trim().min(2).max(60) }).strict();
export const planRetireInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/** What a change to a plan would touch, shown before it is saved. */
export interface PlanImpact {
  key: string;
  name: string;
  lifecycle: PlanLifecycle;
  subscribers: { total: number; active: number; trialing: number; pastDue: number; cancelled: number };
  companies: { clientId: string | null; tenantId: string; name: string; status: string; seats: number }[];
  mrr: Record<string, string>;
  revenue: Record<string, string>;
  invoices: number;
  billingEvents: number;
  canDelete: boolean;
  deleteBlockedBy: string[];
  /** Feature keys being removed and limits being lowered by the proposed change, with how many workspaces use them. */
  removed: { feature: string; label: string; workspaces: number }[];
  lowered: { limit: string; label: string; from: number; to: number; overLimit: number | null }[];
}

// ---------------------------------------------------------------------------------------------------------------
// System status (health roll-up)
// ---------------------------------------------------------------------------------------------------------------

export const SYSTEM_LEVELS = ['operational', 'warning', 'critical'] as const;
export type SystemLevel = (typeof SYSTEM_LEVELS)[number];
export const SYSTEM_LEVEL_LABEL: Record<SystemLevel, string> = { operational: 'Operational', warning: 'Warning', critical: 'Critical' };

export interface SystemComponent { key: string; name: string; level: SystemLevel; detail: string }
export interface SystemStatus {
  level: SystemLevel;
  checkedAt: string;
  components: SystemComponent[];
  /** API traffic per route group over the last hour and day (from platform_request_metrics). */
  traffic: { service: string; requests1h: number; errorRate1h: number; p95Ms1h: number | null; requests24h: number; errorRate24h: number }[];
  series: ConsoleSeriesPoint[];
}

// ---------------------------------------------------------------------------------------------------------------
// View as (read-only support view during a client-approved grant)
// ---------------------------------------------------------------------------------------------------------------

export interface ViewAsSession {
  grantId: string;
  tenantId: string;
  workspace: string;
  clientId: string | null;
  expiresAt: string;
  reason: string;
  approvedBy: string | null;
  /** What this view can show, given the admin's own permissions. */
  sections: ('overview' | 'structure' | 'users' | 'modules' | 'activity' | 'billing')[];
}
