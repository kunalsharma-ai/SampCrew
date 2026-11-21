import { z } from 'zod';

/**
 * The centralized SampCrew mobile app: one app for Super Workspace, HR Workspace and Employee Workspace people.
 *
 * Two layers decide what a person sees on the phone:
 *  1. the mobile app configuration the Super Workspace publishes (Settings > Mobile app): which modules and features
 *     the phone offers, to which level, where they sit in the menu, the quick actions and the home widgets;
 *  2. the access the person already has: the plan and every feature switch above (entitlements) and their own
 *     permissions. The configuration can only hide; it never grants anything.
 *
 * The server applies layer 1 to every request a phone sends (MOBILE_ROUTES), so a hidden module stays closed when
 * its address is typed in or its API is called directly. The web app is never affected by this configuration.
 */

export const MOBILE_LEVELS = ['super', 'hr', 'employee'] as const;
export type MobileLevel = (typeof MOBILE_LEVELS)[number];
export const MOBILE_LEVEL_LABEL: Record<MobileLevel, string> = { super: 'Super Workspace', hr: 'HR Workspace', employee: 'Employee Workspace' };

export const MOBILE_PLACEMENTS = ['tab', 'more'] as const;
export type MobilePlacement = (typeof MOBILE_PLACEMENTS)[number];
/** The bottom bar holds Home, up to this many modules, and More. */
export const MOBILE_MAX_TABS = 3;
export const MOBILE_MAX_QUICK_ACTIONS = 8;
export const MOBILE_MAX_WIDGETS = 10;

type Levels = Record<MobileLevel, boolean>;
const ALL: Levels = { super: true, hr: true, employee: true };
const ADMINS: Levels = { super: true, hr: true, employee: false };

export interface MobileFeatureDef {
  key: string;
  name: string;
  description: string;
  /** Levels it is offered to when the Super Workspace has not changed it. */
  levels?: Levels;
  /** Another feature of the same module this one needs (Breaks need Check in and out). */
  requires?: string;
  /** The person needs one of these permissions to see it (their own access decides, never the configuration). */
  permissionsAny?: readonly string[];
}

export interface MobileShortcutDef {
  key: string;
  name: string;
  /** Ionicons glyph name. */
  icon: string;
  /** The module.feature it belongs to: it shows only while that is on for the person. */
  feature: string;
  /** Where it opens in the app. */
  route: string;
  levels?: Levels;
  permissionsAny?: readonly string[];
}

export interface MobileModuleDef {
  key: string;
  name: string;
  description: string;
  icon: string;
  /** Where the module opens in the app. */
  route: string;
  /** The feature (module or page key in features.ts / feature-parts.ts) the plan and switches above must leave on. */
  entitlement: string | null;
  /** The person needs one of these permissions to see the module. */
  permissionsAny?: readonly string[];
  /** Always on (the app cannot work without it). */
  locked?: boolean;
  /** Other modules this one needs. */
  requires?: readonly string[];
  defaultPlacement: MobilePlacement;
  /** Whether the module can sit in the bottom bar (it has a main screen of its own there). */
  tabbable?: boolean;
  defaultLevels?: Levels;
  features: readonly MobileFeatureDef[];
}

export const MOBILE_MODULES = [
  {
    key: 'home', name: 'Home dashboard', icon: 'home', route: '/', entitlement: null, locked: true, defaultPlacement: 'tab',
    description: 'A personal start screen: greeting, quick actions and the widgets you choose for each level.',
    features: [{ key: 'search', name: 'Search', description: 'Search people, messages, documents, learning and announcements the person can see.' }],
  },
  {
    key: 'attendance', tabbable: true, name: 'Attendance', icon: 'time', route: '/attendance', entitlement: 'attendance_basic.mine', permissionsAny: ['attendance:punch', 'attendance:read'], defaultPlacement: 'tab',
    description: 'Check in and out (also offline), breaks, today’s hours, the month calendar and history.',
    features: [
      { key: 'punch', name: 'Check in and out', description: 'Record attendance from the phone, with the workplace’s location rules.', permissionsAny: ['attendance:punch'] },
      { key: 'breaks', name: 'Breaks', description: 'Start and end a break during the day.', requires: 'punch', permissionsAny: ['attendance:punch'] },
      { key: 'calendar', name: 'Attendance calendar', description: 'The month with present, late, leave, holiday and missing punch days.' },
      { key: 'history', name: 'Attendance history', description: 'Past days with check-in, check-out, breaks and worked hours.' },
      { key: 'summary', name: 'Monthly summary', description: 'Present, late, absent and worked hours for the month.' },
      { key: 'corrections', name: 'Correction requests', description: 'Ask to fix a missed or wrong punch.', permissionsAny: ['attendance:correct'] },
      { key: 'team', name: 'Team and company attendance', description: 'Today’s attendance of the people the person may see (their permissions decide whom).', levels: ADMINS, permissionsAny: ['attendance:read'] },
    ],
  },
  {
    key: 'leave', tabbable: true, name: 'Leave', icon: 'sunny', route: '/leave', entitlement: 'leave.requests', permissionsAny: ['leave:request', 'leave:read'], defaultPlacement: 'more',
    description: 'Balances and quotas, apply, track and cancel requests, and the leave calendar.',
    features: [
      { key: 'balance', name: 'Leave balance and quota', description: 'Entitlement, used, pending and available days for each leave type.' },
      { key: 'history', name: 'Leave history', description: 'Pending, approved, rejected and cancelled requests.' },
      { key: 'apply', name: 'Apply for leave', description: 'Choose a type, dates and reason, with the days worked out by the leave rules.', permissionsAny: ['leave:request'] },
      { key: 'cancel', name: 'Cancel a request', description: 'Cancel a pending or future request where the leave rules allow.', requires: 'history', permissionsAny: ['leave:request'] },
      { key: 'calendar', name: 'Leave calendar', description: 'Upcoming approved leave and holidays.' },
      { key: 'team', name: 'Team leave', description: 'Leave balances of the people the person may see.', levels: ADMINS, permissionsAny: ['leave:approve', 'leave:configure'] },
    ],
  },
  {
    key: 'chat', tabbable: true, name: 'Chat', icon: 'chatbubbles', route: '/chat', entitlement: 'helpdesk.communication', permissionsAny: ['helpdesk:use'], defaultPlacement: 'tab',
    description: 'One-to-one and group conversations with colleagues, with unread counts, read receipts and files.',
    features: [
      { key: 'direct', name: 'One-to-one messages', description: 'Message a colleague the person is allowed to reach.' },
      { key: 'groups', name: 'Group conversations', description: 'Group and department conversations the person belongs to.' },
      { key: 'attachments', name: 'Files and photos', description: 'Send and open files in conversations.' },
      { key: 'search', name: 'Message search', description: 'Search the person’s own conversations.' },
    ],
  },
  {
    key: 'email', tabbable: true, name: 'Email', icon: 'mail', route: '/email', entitlement: 'helpdesk.communication', permissionsAny: ['helpdesk:use'], defaultPlacement: 'more',
    description: 'Work email sent through SampCrew: the inbox for everyone, and sent, drafts and compose for HR.',
    features: [
      { key: 'inbox', name: 'Inbox', description: 'Emails from HR the person was sent.' },
      { key: 'compose', name: 'Compose and send', description: 'Write to employees, with CC, BCC and attachments (people who may email employees).', levels: ADMINS, permissionsAny: ['helpdesk:manage'] },
      { key: 'sent', name: 'Sent and drafts', description: 'Emails already sent with delivery status, and saved drafts.', levels: ADMINS, permissionsAny: ['helpdesk:manage'] },
    ],
  },
  {
    key: 'documents', tabbable: true, name: 'Documents', icon: 'document-text', route: '/documents', entitlement: 'documents', permissionsAny: ['documents:read'], defaultPlacement: 'tab',
    description: 'The person’s own documents by category, with preview, download and upload where allowed.',
    features: [
      { key: 'mine', name: 'My documents', description: 'Personal and employment documents on the person’s own record.' },
      { key: 'download', name: 'Open and download', description: 'Open a document through a short-lived, audited link.' },
      { key: 'upload', name: 'Upload', description: 'Add a document to the person’s own record (PDF, Word, Excel, JPG, PNG).', permissionsAny: ['documents:manage'] },
    ],
  },
  {
    key: 'learning', tabbable: true, name: 'Learning', icon: 'school', route: '/learning', entitlement: 'learning.mine', permissionsAny: ['learning:read'], defaultPlacement: 'more',
    description: 'Assigned courses with due dates and progress, the course library, and completion.',
    features: [
      { key: 'assigned', name: 'My learning', description: 'Assigned and pending courses, due dates and status.' },
      { key: 'progress', name: 'Start and complete', description: 'Start a course and mark it complete, kept with the person’s learning record.', requires: 'assigned' },
      { key: 'catalogue', name: 'Course library', description: 'Courses the person may enrol in.' },
    ],
  },
  {
    key: 'announcements', name: 'Announcements', icon: 'megaphone', route: '/announcements', entitlement: 'announcements.read', permissionsAny: ['announcements:read'], defaultPlacement: 'more',
    description: 'Company announcements with acknowledgements.',
    features: [{ key: 'read', name: 'Read and acknowledge', description: 'Read announcements addressed to the person and acknowledge them.' }],
  },
  {
    key: 'notifications', name: 'Notifications', icon: 'notifications', route: '/notifications', entitlement: null, defaultPlacement: 'more',
    description: 'One notification centre: the bell, badges and history, with read and unread kept in step everywhere.',
    features: [{ key: 'center', name: 'Notification centre', description: 'Every notification with category, priority and a link to the screen it is about.' }],
  },
  {
    key: 'approvals', name: 'Approvals', icon: 'checkmark-done', route: '/approvals', entitlement: null, permissionsAny: ['leave:approve', 'attendance:approve', 'expenses:approve'], defaultPlacement: 'more',
    description: 'Requests waiting for the person’s decision (leave, attendance and more), for people who approve.',
    features: [{ key: 'decide', name: 'Approve or reject', description: 'Decide requests the person is an approver for.' }],
  },
  {
    key: 'tasks', name: 'Tasks', icon: 'list', route: '/tasks', entitlement: 'core_hr.tasks', defaultPlacement: 'more',
    description: 'HR and manager tasks with progress and document upload.',
    features: [{ key: 'mine', name: 'My tasks', description: 'Tasks assigned to the person.' }],
  },
  {
    key: 'appraisal', name: 'Appraisal', icon: 'ribbon', route: '/appraisal', entitlement: 'performance.my_appraisal', defaultPlacement: 'more',
    description: 'Self appraisal, manager and HR reviews, and results.',
    features: [{ key: 'mine', name: 'My appraisal', description: 'The person’s appraisal and the reviews they owe.' }],
  },
  {
    key: 'payslips', name: 'Payslips', icon: 'wallet', route: '/payslips', entitlement: 'payroll.payslips', permissionsAny: ['payslips:read'], defaultPlacement: 'more',
    description: 'The person’s published payslips.',
    features: [{ key: 'mine', name: 'My payslips', description: 'Published payslips, month by month.' }],
  },
  {
    key: 'help', tabbable: true, name: 'Help and support', icon: 'help-buoy', route: '/helpdesk', entitlement: 'helpdesk.communication', permissionsAny: ['helpdesk:use'], defaultPlacement: 'more',
    description: 'Help articles and Ask HR cases.',
    features: [
      { key: 'articles', name: 'Help articles', description: 'Answers HR published.' },
      { key: 'cases', name: 'Ask HR', description: 'Raise and follow HR helpdesk cases.' },
    ],
  },
  {
    key: 'directory', name: 'Employee directory', icon: 'people', route: '/directory', entitlement: null, permissionsAny: ['employees:read'], defaultPlacement: 'more',
    description: 'Colleagues the person may see, with department and designation.',
    features: [{ key: 'browse', name: 'Browse and search', description: 'Search colleagues by name, department or designation.' }],
  },
  {
    key: 'profile', tabbable: true, name: 'My profile', icon: 'person-circle', route: '/me', entitlement: null, locked: true, defaultPlacement: 'more',
    description: 'Own details, photo, change requests, appearance and notification settings, and sign-out.',
    features: [{ key: 'edit', name: 'Change requests', description: 'Ask HR to change own details.' }],
  },
  {
    key: 'sessions', name: 'Login and session details', icon: 'shield-checkmark', route: '/sessions', entitlement: null, defaultPlacement: 'more',
    description: 'Last sign-in, recent sign-in history, active sessions and devices, and signing out other devices.',
    features: [
      { key: 'history', name: 'Sign-in history', description: 'Recent sign-ins with time and device.' },
      { key: 'manage', name: 'Sign out other devices', description: 'End sessions on other devices.' },
    ],
  },
] as const satisfies readonly MobileModuleDef[];

export type MobileModuleKey = (typeof MOBILE_MODULES)[number]['key'];
const MODULES = MOBILE_MODULES as readonly MobileModuleDef[];
const MODULE_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));
export const mobileModule = (key: string): MobileModuleDef | undefined => MODULE_BY_KEY.get(key);
export const mobileFeature = (key: string): { module: MobileModuleDef; feature: MobileFeatureDef } | undefined => {
  const [m, f] = key.split('.');
  const module = MODULE_BY_KEY.get(m ?? '');
  const feature = module?.features.find((x) => x.key === f);
  return module && feature ? { module, feature } : undefined;
};

export const MOBILE_QUICK_ACTIONS = [
  { key: 'attendance.punch', name: 'Check in / out', icon: 'finger-print', feature: 'attendance.punch', route: '/attendance' },
  { key: 'leave.apply', name: 'Apply leave', icon: 'airplane', feature: 'leave.apply', route: '/leave/new' },
  { key: 'attendance.history', name: 'My attendance', icon: 'calendar', feature: 'attendance.history', route: '/attendance/history' },
  { key: 'leave.balance', name: 'Leave balance', icon: 'pie-chart', feature: 'leave.balance', route: '/leave' },
  { key: 'chat.open', name: 'Chat', icon: 'chatbubbles', feature: 'chat.direct', route: '/chat' },
  { key: 'email.open', name: 'Email', icon: 'mail', feature: 'email.inbox', route: '/email' },
  { key: 'learning.open', name: 'Learning', icon: 'school', feature: 'learning.assigned', route: '/learning' },
  { key: 'documents.open', name: 'Documents', icon: 'document-text', feature: 'documents.mine', route: '/documents' },
  { key: 'approvals.open', name: 'Approvals', icon: 'checkmark-done', feature: 'approvals.decide', route: '/approvals' },
  { key: 'attendance.team', name: 'Team attendance', icon: 'people', feature: 'attendance.team', route: '/attendance/team', levels: ADMINS },
  { key: 'tasks.open', name: 'Tasks', icon: 'list', feature: 'tasks.mine', route: '/tasks' },
  { key: 'help.ask', name: 'Ask HR', icon: 'help-buoy', feature: 'help.cases', route: '/helpdesk/new' },
  { key: 'search.open', name: 'Search', icon: 'search', feature: 'home.search', route: '/search' },
] as const satisfies readonly MobileShortcutDef[];

export const MOBILE_WIDGETS = [
  { key: 'attendance.today', name: 'Today’s attendance', icon: 'time', feature: 'attendance.punch', route: '/attendance' },
  { key: 'attendance.summary', name: 'This month’s attendance', icon: 'stats-chart', feature: 'attendance.summary', route: '/attendance/history' },
  { key: 'attendance.team', name: 'Company attendance today', icon: 'people', feature: 'attendance.team', route: '/attendance/team', levels: ADMINS },
  { key: 'leave.balance', name: 'Leave balance', icon: 'pie-chart', feature: 'leave.balance', route: '/leave' },
  { key: 'leave.pending', name: 'Pending leave requests', icon: 'hourglass', feature: 'leave.history', route: '/leave' },
  { key: 'approvals.pending', name: 'Waiting for my decision', icon: 'checkmark-done', feature: 'approvals.decide', route: '/approvals' },
  { key: 'chat.recent', name: 'Recent messages', icon: 'chatbubbles', feature: 'chat.direct', route: '/chat' },
  { key: 'notifications.unread', name: 'Unread notifications', icon: 'notifications', feature: 'notifications.center', route: '/notifications' },
  { key: 'learning.assigned', name: 'Assigned learning', icon: 'school', feature: 'learning.assigned', route: '/learning' },
  { key: 'announcements.latest', name: 'Announcements', icon: 'megaphone', feature: 'announcements.read', route: '/announcements' },
  { key: 'tasks.pending', name: 'Pending tasks', icon: 'list', feature: 'tasks.mine', route: '/tasks' },
  { key: 'documents.recent', name: 'Recent documents', icon: 'document-text', feature: 'documents.mine', route: '/documents' },
] as const satisfies readonly MobileShortcutDef[];

const SHORTCUTS = { quickActions: MOBILE_QUICK_ACTIONS as readonly MobileShortcutDef[], widgets: MOBILE_WIDGETS as readonly MobileShortcutDef[] };

/**
 * API routes (after /api/v1/) a phone uses for each module or feature. A phone request to a route listed here is
 * refused while none of its owners is on for the person's level; the longest matching route decides, and `*` stands
 * for one path segment. Routes not listed (sign-in, /me, device registration, sign-out) always stay open.
 */
export interface MobileRoute {
  path: string;
  methods?: readonly ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[];
  /** module or module.feature keys; the route is open while any of them is on. */
  owners: readonly string[];
}

export const MOBILE_ROUTES: readonly MobileRoute[] = [
  { path: 'mobile/punches', owners: ['attendance.punch'] },
  { path: 'attendance/punch', owners: ['attendance.punch'] },
  { path: 'attendance/today', owners: ['attendance'] },
  { path: 'attendance/days', owners: ['attendance.history', 'attendance.calendar', 'attendance.summary'] },
  { path: 'attendance/corrections', owners: ['attendance.corrections'] },
  { path: 'attendance/team', owners: ['attendance.team'] },
  { path: 'attendance/register', owners: ['attendance.team'] },
  { path: 'leave/balances', owners: ['leave.balance', 'leave.apply'] },
  { path: 'leave/balances/overview', owners: ['leave.team'] },
  { path: 'leave/requests', methods: ['GET'], owners: ['leave.history', 'leave.calendar'] },
  { path: 'leave/requests', methods: ['POST'], owners: ['leave.apply'] },
  { path: 'leave/requests/preview', owners: ['leave.apply'] },
  { path: 'leave/requests/*/cancel', owners: ['leave.cancel'] },
  { path: 'leave/types', owners: ['leave.apply', 'leave.balance'] },
  { path: 'leave/calendar', owners: ['leave.calendar', 'leave.apply'] },
  { path: 'leave', owners: ['leave'] },
  { path: 'communication/conversations', owners: ['chat.direct', 'chat.groups'] },
  { path: 'communication/unread', owners: ['chat'] },
  { path: 'communication/delivered', owners: ['chat'] },
  { path: 'communication/people', owners: ['chat.direct', 'chat.groups', 'email.compose'] },
  { path: 'communication/search', owners: ['chat.search'] },
  { path: 'communication/files', methods: ['POST'], owners: ['chat.attachments', 'email.compose'] },
  { path: 'communication/files/*/link', owners: ['chat.attachments', 'email.inbox', 'email.sent'] },
  { path: 'communication/emails/inbox', owners: ['email.inbox'] },
  { path: 'communication/emails', methods: ['GET'], owners: ['email.sent'] },
  { path: 'communication/emails', methods: ['POST', 'PUT', 'DELETE'], owners: ['email.compose'] },
  { path: 'communication/groups', owners: ['email.compose'] },
  { path: 'communication/audience', owners: ['email.compose'] },
  { path: 'employees/*/documents', methods: ['GET'], owners: ['documents.mine'] },
  { path: 'employees/*/documents', methods: ['POST'], owners: ['documents.upload'] },
  { path: 'documents/*/link', owners: ['documents.download'] },
  { path: 'learning/assignments', methods: ['GET'], owners: ['learning.assigned'] },
  { path: 'learning/assignments/*/start', owners: ['learning.progress'] },
  { path: 'learning/assignments/*/complete', owners: ['learning.progress'] },
  { path: 'learning/courses', owners: ['learning.catalogue'] },
  { path: 'learning', owners: ['learning'] },
  { path: 'announcements', owners: ['announcements'] },
  { path: 'notifications', owners: ['notifications'] },
  { path: 'approvals', owners: ['approvals'] },
  { path: 'tasks', owners: ['tasks'] },
  { path: 'appraisals', owners: ['appraisal'] },
  { path: 'payslips', owners: ['payslips'] },
  { path: 'helpdesk/articles', owners: ['help.articles'] },
  { path: 'helpdesk/categories', owners: ['help'] },
  { path: 'helpdesk/cases', owners: ['help.cases'] },
  { path: 'helpdesk', owners: ['help'] },
  { path: 'employees', methods: ['GET'], owners: ['directory'] },
  // The person's own record and photos stay open with the profile, which is always on.
  { path: 'employees/me', owners: ['profile'] },
  { path: 'employees/*/photo', owners: ['profile'] },
  { path: 'me/sessions', owners: ['sessions'] },
  { path: 'me/sign-ins', owners: ['sessions.history'] },
];

const under = (path: string, prefix: string) => {
  const a = path.split('/');
  const b = prefix.split('/');
  return a.length >= b.length && b.every((seg, i) => (seg === '*' ? (a[i]?.length ?? 0) > 0 : seg === a[i]));
};

/** The mobile route entry for an API path (after /api/v1/) and method, if the phone configuration governs it. */
export function mobileRouteFor(path: string, method: string): MobileRoute | undefined {
  const clean = (path.split('?')[0] ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  let best: MobileRoute | undefined;
  let size = -1;
  for (const r of MOBILE_ROUTES) {
    if (r.methods && !(r.methods as readonly string[]).includes(method.toUpperCase())) continue;
    if (!under(clean, r.path)) continue;
    const s = r.path.split('/').length * 10 + (r.methods ? 1 : 0);
    if (s > size) {
      best = r;
      size = s;
    }
  }
  return best;
}

// Configuration ----------------------------------------------------------------------------------------------------

const levelsSchema = z.object({ super: z.boolean(), hr: z.boolean(), employee: z.boolean() });
const switchSchema = z.object({ enabled: z.boolean(), levels: levelsSchema });
const moduleConfigSchema = switchSchema.extend({
  placement: z.enum(MOBILE_PLACEMENTS),
  order: z.number().int().min(0).max(999),
  features: z.record(z.string().max(40), switchSchema),
});
const shortcutSchema = switchSchema.extend({ key: z.string().max(60) });

export const mobileAppConfigSchema = z.object({
  modules: z.record(z.string().max(40), moduleConfigSchema),
  quickActions: z.array(shortcutSchema).max(40),
  widgets: z.array(shortcutSchema).max(40),
  /** A short line under the greeting on the home screen (optional). */
  welcome: z.string().trim().max(120).default(''),
});
export type MobileAppConfig = z.infer<typeof mobileAppConfigSchema>;
export type MobileModuleConfig = z.infer<typeof moduleConfigSchema>;

export const mobileAppDraftInput = z.object({ config: mobileAppConfigSchema });
export const mobileAppPublishInput = z.object({
  note: z.string().trim().max(300).default(''),
  /** The draft version being published, so two people publishing at once do not overwrite each other silently. */
  draftRevision: z.number().int().min(0),
  /** Modules that people used on their phones lately and that this publish hides: the person confirmed. */
  confirmHidingInUse: z.boolean().default(false),
});
export type MobileAppPublishInput = z.infer<typeof mobileAppPublishInput>;
export const mobileAppPreviewQuery = z.object({ level: z.enum(MOBILE_LEVELS), source: z.enum(['draft', 'published']).default('draft') });

const levels = (l?: Levels): Levels => ({ ...(l ?? ALL) });

/** The configuration a company starts with: every module on for its usual levels, Attendance, Chat and Documents in the bar. */
export function defaultMobileConfig(): MobileAppConfig {
  const modules: MobileAppConfig['modules'] = {};
  MODULES.forEach((m, i) => {
    modules[m.key] = {
      enabled: true,
      levels: levels(m.defaultLevels),
      placement: m.defaultPlacement,
      order: i * 10,
      features: Object.fromEntries(m.features.map((f) => [f.key, { enabled: true, levels: levels(f.levels) }])),
    };
  });
  const shortcuts = (defs: readonly MobileShortcutDef[], on: readonly string[]) => defs.map((d) => ({ key: d.key, enabled: on.includes(d.key), levels: levels(d.levels) }));
  return {
    modules,
    quickActions: shortcuts(SHORTCUTS.quickActions, ['attendance.punch', 'leave.apply', 'attendance.history', 'chat.open', 'email.open', 'documents.open', 'learning.open', 'approvals.open']),
    widgets: shortcuts(SHORTCUTS.widgets, ['attendance.today', 'attendance.team', 'approvals.pending', 'leave.balance', 'leave.pending', 'notifications.unread', 'chat.recent', 'learning.assigned', 'announcements.latest', 'tasks.pending']),
    welcome: '',
  };
}

/**
 * Brings a stored or submitted configuration in line with the current catalogue: modules, features and shortcuts the
 * catalogue gained come in with their defaults, ones it no longer has are dropped, and locked modules stay on.
 */
export function normalizeMobileConfig(input: Partial<MobileAppConfig> | null | undefined): MobileAppConfig {
  const base = defaultMobileConfig();
  const out: MobileAppConfig = { modules: {}, quickActions: [], widgets: [], welcome: (input?.welcome ?? '').slice(0, 120) };
  for (const m of MODULES) {
    const given = input?.modules?.[m.key];
    const def = base.modules[m.key]!;
    const features: MobileModuleConfig['features'] = {};
    for (const f of m.features) features[f.key] = given?.features?.[f.key] ? { enabled: given.features[f.key]!.enabled, levels: { ...given.features[f.key]!.levels } } : def.features[f.key]!;
    out.modules[m.key] = given
      ? { enabled: m.locked ? true : given.enabled, levels: m.locked ? levels() : { ...given.levels }, placement: m.key === 'home' ? 'tab' : given.placement, order: given.order, features }
      : { ...def, features };
  }
  for (const kind of ['quickActions', 'widgets'] as const) {
    const defs = SHORTCUTS[kind];
    const known = new Set(defs.map((d) => d.key));
    const seen = new Set<string>();
    for (const s of input?.[kind] ?? []) {
      if (!known.has(s.key) || seen.has(s.key)) continue;
      seen.add(s.key);
      out[kind].push({ key: s.key, enabled: s.enabled, levels: { ...s.levels } });
    }
    for (const d of base[kind]) if (!seen.has(d.key)) out[kind].push(input?.[kind] ? { ...d, enabled: false } : d);
  }
  return out;
}

export interface MobileConfigIssue {
  severity: 'error' | 'warning';
  message: string;
  module?: string;
}

/** Checks a configuration before it is published. Errors block publishing; warnings are shown. */
export function validateMobileConfig(config: MobileAppConfig, available?: { features: ReadonlySet<string> }): MobileConfigIssue[] {
  const issues: MobileConfigIssue[] = [];
  for (const level of MOBILE_LEVELS) {
    const tabs = MODULES.filter((m) => m.key !== 'home' && config.modules[m.key]?.enabled && config.modules[m.key]?.levels[level] && config.modules[m.key]?.placement === 'tab');
    for (const m of tabs) if (!m.tabbable) issues.push({ severity: 'error', module: m.key, message: `${m.name} cannot sit in the bottom bar. Put it in More.` });
    if (tabs.length > MOBILE_MAX_TABS) {
      issues.push({ severity: 'error', message: `${MOBILE_LEVEL_LABEL[level]}: the bottom bar holds ${MOBILE_MAX_TABS} modules besides Home and More, and ${tabs.length} are placed there (${tabs.map((m) => m.name).join(', ')}). Move some to More.` });
    }
  }
  for (const m of MODULES) {
    const c = config.modules[m.key];
    if (!c?.enabled) continue;
    if (!MOBILE_LEVELS.some((l) => c.levels[l])) issues.push({ severity: 'warning', module: m.key, message: `${m.name} is on but offered to no level, so nobody sees it.` });
    for (const r of m.requires ?? []) {
      if (!config.modules[r]?.enabled) issues.push({ severity: 'error', module: m.key, message: `${m.name} needs ${mobileModule(r)?.name ?? r}, which is off.` });
    }
    for (const f of m.features) {
      const fc = c.features[f.key];
      if (!fc?.enabled || !f.requires) continue;
      const need = c.features[f.requires];
      const needName = m.features.find((x) => x.key === f.requires)?.name ?? f.requires;
      if (!need?.enabled) issues.push({ severity: 'error', module: m.key, message: `${m.name}: ${f.name} needs ${needName}, which is off.` });
      else for (const l of MOBILE_LEVELS) if (fc.levels[l] && !need.levels[l]) issues.push({ severity: 'error', module: m.key, message: `${m.name}: ${f.name} is offered to ${MOBILE_LEVEL_LABEL[l]} but ${needName} is not.` });
    }
    if (!m.features.some((f) => c.features[f.key]?.enabled)) issues.push({ severity: 'warning', module: m.key, message: `${m.name} is on but all of its features are off, so it shows an empty screen.` });
    if (available && m.entitlement && !available.features.has(m.entitlement)) {
      issues.push({ severity: 'warning', module: m.key, message: `${m.name} is not part of your plan or is switched off above, so it stays hidden on phones until it is available.` });
    }
  }
  if (!config.modules.notifications?.enabled) issues.push({ severity: 'warning', module: 'notifications', message: 'Notifications are off: phones show no bell or badges, and push still arrives if people allowed it.' });
  const on = (list: MobileAppConfig['quickActions']) => list.filter((s) => s.enabled).length;
  if (on(config.quickActions) > MOBILE_MAX_QUICK_ACTIONS) issues.push({ severity: 'error', message: `Choose at most ${MOBILE_MAX_QUICK_ACTIONS} quick actions (${on(config.quickActions)} are on).` });
  if (on(config.widgets) > MOBILE_MAX_WIDGETS) issues.push({ severity: 'error', message: `Choose at most ${MOBILE_MAX_WIDGETS} home widgets (${on(config.widgets)} are on).` });
  return issues;
}

/** Whether a module or module.feature key is on for a level in this configuration (layer 1 only). */
export function mobileKeyOn(config: MobileAppConfig, key: string, level: MobileLevel): boolean {
  const [m, f] = key.split('.');
  const c = config.modules[m ?? ''];
  if (!c?.enabled || !c.levels[level]) return false;
  if (!f) return true;
  const fc = c.features[f];
  return Boolean(fc?.enabled && fc.levels[level]);
}

/** Whether the phone configuration lets a request through (any owner on for the level). */
export function mobileRouteAllowed(config: MobileAppConfig, route: MobileRoute, level: MobileLevel): boolean {
  return route.owners.some((o) => mobileKeyOn(config, o, level));
}

export interface ResolvedMobileModule {
  key: string;
  name: string;
  icon: string;
  route: string;
  description: string;
  placement: MobilePlacement;
  features: string[];
}

export interface ResolvedMobileShortcut {
  key: string;
  name: string;
  icon: string;
  route: string;
  module: string;
}

/** What one person's app shows: GET /mobile/app. */
export interface ResolvedMobileApp {
  version: number;
  publishedAt: string | null;
  level: MobileLevel;
  levelLabel: string;
  welcome: string;
  modules: ResolvedMobileModule[];
  /** Bottom bar between Home and More, in order. */
  tabs: string[];
  /** The More menu, in order. */
  more: string[];
  quickActions: ResolvedMobileShortcut[];
  widgets: ResolvedMobileShortcut[];
  /** What the company has set up that a module needs (true or false only, never the settings themselves). */
  setup?: { email: boolean };
}

/**
 * Applies both layers for one person (or, for the Super Workspace preview, for a level with the company's features
 * and no individual permissions): the configuration, the entitlements and, when given, the permissions.
 */
export function resolveMobileApp(args: {
  config: MobileAppConfig;
  version: number;
  publishedAt: string | null;
  level: MobileLevel;
  features: ReadonlySet<string>;
  /** The person's permissions; leave out for a level preview (no individual permissions applied). */
  can?: (permission: string) => boolean;
}): ResolvedMobileApp {
  const { config, level, features, can } = args;
  const allowed = (perms?: readonly string[]) => !can || !perms?.length || perms.some((p) => can(p));
  const entitled = (key: string | null) => key === null || features.has(key) || (key.includes('.') && !hasParts(features) && features.has(key.split('.')[0]!));
  const modules: ResolvedMobileModule[] = [];
  const sorted = [...MODULES].sort((a, b) => (config.modules[a.key]?.order ?? 0) - (config.modules[b.key]?.order ?? 0));
  for (const m of sorted) {
    if (!mobileKeyOn(config, m.key, level) || !entitled(m.entitlement) || !allowed(m.permissionsAny)) continue;
    const on = m.features.filter((f) => mobileKeyOn(config, `${m.key}.${f.key}`, level) && allowed(f.permissionsAny) && (!f.requires || mobileKeyOn(config, `${m.key}.${f.requires}`, level)));
    if (!on.length) continue;
    modules.push({ key: m.key, name: m.name, icon: m.icon, route: m.route, description: m.description, placement: config.modules[m.key]!.placement, features: on.map((f) => f.key) });
  }
  const has = (key: string) => {
    const [mk, fk] = key.split('.');
    const r = modules.find((x) => x.key === mk);
    return Boolean(r && (!fk || r.features.includes(fk)));
  };
  const pickShortcuts = (list: MobileAppConfig['quickActions'], defs: readonly MobileShortcutDef[], max: number) =>
    list
      .filter((s) => s.enabled && s.levels[level])
      .map((s) => defs.find((d) => d.key === s.key))
      .filter((d): d is MobileShortcutDef => Boolean(d && has(d.feature) && allowed(d.permissionsAny) && (!d.levels || d.levels[level])))
      .slice(0, max)
      .map((d) => ({ key: d.key, name: d.name, icon: d.icon, route: d.route, module: d.feature.split('.')[0]! }));
  const rest = modules.filter((m) => m.key !== 'home');
  const tabs = rest.filter((m) => m.placement === 'tab' && mobileModule(m.key)?.tabbable).slice(0, MOBILE_MAX_TABS).map((m) => m.key);
  return {
    version: args.version,
    publishedAt: args.publishedAt,
    level,
    levelLabel: MOBILE_LEVEL_LABEL[level],
    welcome: config.welcome,
    modules,
    tabs,
    more: rest.filter((m) => !tabs.includes(m.key)).map((m) => m.key),
    quickActions: pickShortcuts(config.quickActions, SHORTCUTS.quickActions, MOBILE_MAX_QUICK_ACTIONS),
    widgets: pickShortcuts(config.widgets, SHORTCUTS.widgets, MOBILE_MAX_WIDGETS),
  };
}

/** An older server sends module keys only; then a page key follows its module. */
const hasParts = (features: ReadonlySet<string>) => {
  for (const k of features) if (k.includes('.')) return true;
  return false;
};

/** What changed between two configurations, in words, for the history and the publish confirmation. */
export function describeMobileChanges(before: MobileAppConfig, after: MobileAppConfig): string[] {
  const out: string[] = [];
  const lv = (l: Levels) => MOBILE_LEVELS.filter((k) => l[k]).map((k) => MOBILE_LEVEL_LABEL[k]).join(', ') || 'no level';
  for (const m of MODULES) {
    const a = before.modules[m.key];
    const b = after.modules[m.key];
    if (!a || !b) continue;
    if (a.enabled !== b.enabled) out.push(`${m.name} ${b.enabled ? 'shown' : 'hidden'}`);
    else if (b.enabled && MOBILE_LEVELS.some((l) => a.levels[l] !== b.levels[l])) out.push(`${m.name} now for ${lv(b.levels)}`);
    if (a.placement !== b.placement) out.push(`${m.name} moved to ${b.placement === 'tab' ? 'the bottom bar' : 'More'}`);
    for (const f of m.features) {
      const fa = a.features[f.key];
      const fb = b.features[f.key];
      if (!fa || !fb) continue;
      if (fa.enabled !== fb.enabled) out.push(`${m.name}: ${f.name} ${fb.enabled ? 'on' : 'off'}`);
      else if (fb.enabled && MOBILE_LEVELS.some((l) => fa.levels[l] !== fb.levels[l])) out.push(`${m.name}: ${f.name} now for ${lv(fb.levels)}`);
    }
  }
  const order = (c: MobileAppConfig) => MODULES.map((m) => m.key).sort((x, y) => (c.modules[x]?.order ?? 0) - (c.modules[y]?.order ?? 0)).join(',');
  if (order(before) !== order(after)) out.push('Menu order changed');
  for (const kind of ['quickActions', 'widgets'] as const) {
    const label = kind === 'quickActions' ? 'Quick actions' : 'Home widgets';
    const on = (c: MobileAppConfig) => c[kind].filter((s) => s.enabled).map((s) => `${s.key}:${lv(s.levels)}`).join('|');
    if (on(before) !== on(after)) out.push(`${label} changed`);
  }
  if (before.welcome !== after.welcome) out.push('Welcome line changed');
  return out;
}
