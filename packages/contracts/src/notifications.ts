import { z } from 'zod';

/**
 * The shared notification model. Every module raises notifications through the API's NotificationService.notify(tx,
 * notice); this file is the contract both sides agree on: the categories people filter and mute by, the priorities
 * that decide how loudly a notice is shown, and the preferences each person keeps.
 *
 * A notice's category is derived from its kind ("leave.approved" is a leave notice) unless the caller names one.
 * Modules owned by other teams register their prefixes here, so the Notification Center and the preferences page
 * list them without code changes elsewhere.
 */

export const NOTIFICATION_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const NOTIFICATION_CATEGORIES = [
  { key: 'approvals', label: 'Approvals', description: 'Requests waiting for you, and decisions on your own requests', icon: 'inbox' },
  { key: 'leave', label: 'Leave', description: 'Leave applications, balances and penalties', icon: 'calendar' },
  { key: 'attendance', label: 'Attendance', description: 'Late coming, missed punches, corrections and rewards', icon: 'clock' },
  { key: 'communication', label: 'Communication', description: 'Chat messages, emails and replies from HR', icon: 'message-square' },
  { key: 'announcements', label: 'Announcements', description: 'Company and team announcements', icon: 'megaphone' },
  { key: 'hr_tasks', label: 'HR tasks', description: 'Tasks HR assigned to you, such as onboarding steps', icon: 'list-checks' },
  { key: 'manager_tasks', label: 'Manager tasks', description: 'Tasks your manager assigned to you', icon: 'clipboard-list' },
  { key: 'appraisal', label: 'Appraisals', description: 'Reviews, goals, feedback and recognition', icon: 'target' },
  { key: 'learning', label: 'Learning', description: 'Courses assigned to you, due dates and completions', icon: 'graduation-cap' },
  { key: 'profile', label: 'Employee profile', description: 'Profile changes and joiners', icon: 'contact' },
  { key: 'documents', label: 'Document verification', description: 'Document requests and verification results', icon: 'file-text' },
  { key: 'verification', label: 'Background verification', description: 'Background check progress and results', icon: 'shield' },
  { key: 'assets', label: 'Assets', description: 'Company assets assigned to or returned by you', icon: 'briefcase' },
  { key: 'recruitment', label: 'Recruitment', description: 'Job requisitions, candidates, interviews and offers', icon: 'briefcase' },
  { key: 'payroll', label: 'Payroll & expenses', description: 'Payslips, payroll runs and expense claims', icon: 'wallet' },
  { key: 'system', label: 'Workspace & security', description: 'Sign-in, billing, integrations and other workspace notices', icon: 'settings' },
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]['key'];
export const NOTIFICATION_CATEGORY_KEYS = NOTIFICATION_CATEGORIES.map((c) => c.key) as [NotificationCategory, ...NotificationCategory[]];

/** Kind prefixes and the category they belong to. The longest matching prefix wins. */
const PREFIXES: [string, NotificationCategory][] = [
  ['approval.', 'approvals'],
  ['leave.', 'leave'],
  ['leave_', 'leave'],
  ['same_day_leave', 'leave'],
  ['attendance.', 'attendance'],
  ['attendance_correction', 'attendance'],
  ['late_coming', 'attendance'],
  ['shift_swap.', 'attendance'],
  ['roster.', 'attendance'],
  ['overtime', 'attendance'],
  ['chat.', 'communication'],
  ['email.', 'communication'],
  ['communication.', 'communication'],
  ['helpdesk.', 'communication'],
  ['announcement.', 'announcements'],
  ['announcements.', 'announcements'],
  ['task.', 'hr_tasks'],
  ['onboarding.', 'hr_tasks'],
  ['task.document_reviewed', 'documents'],
  ['appraisal.', 'appraisal'],
  ['review.', 'appraisal'],
  ['goal.', 'appraisal'],
  ['recognition.', 'appraisal'],
  ['survey.', 'appraisal'],
  ['learning.', 'learning'],
  ['course.', 'learning'],
  ['profile_update.', 'profile'],
  ['employee.', 'profile'],
  ['probation', 'profile'],
  ['document_verification.', 'documents'],
  ['document.', 'documents'],
  ['documents.', 'documents'],
  ['bgv.', 'verification'],
  ['background_verification.', 'verification'],
  ['asset.', 'assets'],
  ['requisition.', 'recruitment'],
  ['candidate.', 'recruitment'],
  ['application.', 'recruitment'],
  ['interview.', 'recruitment'],
  ['offer.', 'recruitment'],
  ['bid.', 'recruitment'],
  ['payslip.', 'payroll'],
  ['payroll', 'payroll'],
  ['expense_claim.', 'payroll'],
  ['expense.', 'payroll'],
];

/** The category of a notification kind, for kinds raised without an explicit category. */
export function categoryOfKind(kind: string): NotificationCategory {
  let best: [string, NotificationCategory] | null = null;
  for (const p of PREFIXES) if (kind.startsWith(p[0]) && (!best || p[0].length > best[0].length)) best = p;
  return best?.[1] ?? 'system';
}

/** Notifications people cannot switch off in the app, because missing one could lock them out or cost them money. */
export const MANDATORY_CATEGORIES: NotificationCategory[] = ['approvals', 'system'];

export const notificationSoundSettings = z.object({
  /** Off by default: a sound only ever plays after the person switched it on. */
  enabled: z.boolean().default(false),
  /** 0 to 100. */
  volume: z.number().int().min(0).max(100).default(60),
  /** Only notices of this priority or higher make a sound. */
  minPriority: z.enum(NOTIFICATION_PRIORITIES).default('normal'),
});
export type NotificationSoundSettings = z.infer<typeof notificationSoundSettings>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
export const quietHours = z.object({ enabled: z.boolean().default(false), from: hhmm.default('20:00'), to: hhmm.default('08:00') });
export type QuietHours = z.infer<typeof quietHours>;

const channelSetting = z.object({
  inApp: z.boolean().default(true),
  email: z.boolean().default(true),
  /** Phone push for this category (the SampCrew app on iOS and Android). */
  push: z.boolean().default(true),
  /** Whether a notice of this category may make a sound (web tone and phone alert). Sound itself is switched on below. */
  sound: z.boolean().default(true),
});
export type NotificationChannel = z.infer<typeof channelSetting>;
const DEFAULT_CHANNEL: NotificationChannel = { inApp: true, email: true, push: true, sound: true };

export const notificationPreferencesInput = z.object({
  /** Per category; a category left out keeps the defaults (in the app and by email). */
  categories: z.partialRecord(z.enum(NOTIFICATION_CATEGORY_KEYS), channelSetting).default({}),
  sound: notificationSoundSettings.default({ enabled: false, volume: 60, minPriority: 'normal' }),
  /** Show a toast in the corner when a notice arrives while the portal is open. */
  toasts: z.boolean().default(true),
  /** Also show a system (browser) notification when the portal is in a background tab; needs the browser's permission. */
  desktop: z.boolean().default(false),
  /** Quiet hours: no sound, pop-up or system notification (urgent notices still show). Times are the person's local time. */
  quiet: quietHours.default({ enabled: false, from: '20:00', to: '08:00' }),
});
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesInput>;

/**
 * The organisation's notification rules, set by the Super Workspace (Settings > Notifications > Organisation). They sit
 * above each person's own choices: a person can choose anything the organisation leaves open, never less than it
 * requires. Workspaces that never saved a policy get DEFAULT_NOTIFICATION_POLICY.
 */
export const notificationPolicyInput = z.object({
  /** Categories everyone sees in SampCrew, on top of Approvals and Workspace & security (always on). */
  mandatory: z.array(z.enum(NOTIFICATION_CATEGORY_KEYS)).max(NOTIFICATION_CATEGORY_KEYS.length).default([]),
  /** Categories whose emails nobody can switch off (for example Payroll, so payslip emails always arrive). */
  emailRequired: z.array(z.enum(NOTIFICATION_CATEGORY_KEYS)).max(NOTIFICATION_CATEGORY_KEYS.length).default([]),
  /** Notification sounds allowed at all (web tone and phone alert). Off: everything is silent, visual only. */
  allowSound: z.boolean().default(true),
  /** Browser (desktop) notifications allowed. Off for organisations that do not want notice text on screen outside SampCrew. */
  allowDesktop: z.boolean().default(true),
  /** Phone push allowed. Off: the SampCrew app shows notices when opened, nothing is pushed. */
  allowPush: z.boolean().default(true),
  /** Starting choices for people who have not changed their own settings. */
  defaults: z.object({
    sound: z.boolean().default(false),
    toasts: z.boolean().default(true),
    desktop: z.boolean().default(false),
  }).default({ sound: false, toasts: true, desktop: false }),
});
export type NotificationPolicy = z.infer<typeof notificationPolicyInput>;
export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = notificationPolicyInput.parse({});

/** What the organisation decided for a person, so settings pages can show the switch as locked and say why. */
export interface NotificationLocks {
  /** Categories that always show in SampCrew (built-in mandatory ones and the organisation's). */
  inApp: NotificationCategory[];
  /** Categories that are always emailed when the module sends an email. */
  email: NotificationCategory[];
  sound: boolean;
  desktop: boolean;
  push: boolean;
}

export interface NotificationPreferences {
  categories: Record<NotificationCategory, NotificationChannel>;
  sound: NotificationSoundSettings;
  toasts: boolean;
  desktop: boolean;
  quiet: QuietHours;
  /** Whether the person saved their own settings (false: the organisation's defaults apply). */
  customised?: boolean;
  /** What the organisation locked (absent on old answers: nothing). */
  locks?: NotificationLocks;
}

/** The locks a policy puts on everyone's settings. */
export function notificationLocks(policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY): NotificationLocks {
  return {
    inApp: [...new Set([...MANDATORY_CATEGORIES, ...policy.mandatory])],
    email: [...new Set<NotificationCategory>(['system', ...policy.emailRequired])],
    sound: !policy.allowSound,
    desktop: !policy.allowDesktop,
    push: !policy.allowPush,
  };
}

/**
 * A person's preferences with every category filled in, inside the organisation's policy: mandatory categories are
 * always on in the app, required emails always on, and sound, desktop or push forced off where the organisation turned
 * them off. A person who never saved settings starts from the organisation's defaults.
 */
export function resolveNotificationPreferences(raw: unknown, policyRaw?: unknown): NotificationPreferences {
  const policy = notificationPolicyInput.safeParse(policyRaw ?? {}).data ?? DEFAULT_NOTIFICATION_POLICY;
  const customised = raw != null && typeof raw === 'object' && Object.keys(raw as object).length > 0;
  const base = customised ? raw : { sound: { enabled: policy.defaults.sound }, toasts: policy.defaults.toasts, desktop: policy.defaults.desktop };
  const parsed = notificationPreferencesInput.safeParse(base);
  const p = parsed.success ? parsed.data : notificationPreferencesInput.parse({});
  const locks = notificationLocks(policy);
  const categories = Object.fromEntries(
    NOTIFICATION_CATEGORY_KEYS.map((k) => {
      const c = { ...DEFAULT_CHANNEL, ...(p.categories[k] ?? {}) };
      return [k, {
        inApp: locks.inApp.includes(k) ? true : c.inApp,
        email: locks.email.includes(k) ? true : c.email,
        push: locks.push ? false : c.push,
        sound: locks.sound ? false : c.sound,
      }];
    }),
  ) as NotificationPreferences['categories'];
  return {
    categories,
    sound: locks.sound ? { ...p.sound, enabled: false } : p.sound,
    toasts: p.toasts,
    desktop: locks.desktop ? false : p.desktop,
    quiet: p.quiet,
    customised,
    locks,
  };
}

export const PRIORITY_RANK: Record<NotificationPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/**
 * Whether a notice should make a sound for someone with these settings: sound on, loud enough, the notice's priority
 * at or above the chosen level and, when the category is given, sound allowed for that category.
 */
export function shouldPlaySound(sound: NotificationSoundSettings, priority: NotificationPriority, category?: NotificationCategory, prefs?: Pick<NotificationPreferences, 'categories'> | null): boolean {
  if (!(sound.enabled && sound.volume > 0 && PRIORITY_RANK[priority] >= PRIORITY_RANK[sound.minPriority])) return false;
  return !category || !prefs || prefs.categories[category]?.sound !== false;
}

/**
 * Kinds that ask the person to do something (decide, complete, acknowledge, review). They are marked "Action needed"
 * in the bell, Home and the module's own page. A module can also say so itself with Notice.action.
 */
const ACTION_KINDS = new Set([
  'approval.requested', 'appraisal.assigned', 'appraisal.hr_pending', 'appraisal.manager_submitted', 'appraisal.self_submitted',
  'asset.assigned', 'bgv.assigned', 'candidate.assigned', 'candidate.follow_up_assigned', 'document.requested', 'document.submitted',
  'document.deadline', 'document.overdue', 'goal.assigned', 'help.query_assigned', 'help.query_submitted', 'helpdesk.assigned',
  'helpdesk.case_new', 'interview.scheduled', 'learning.assigned', 'learning.submission', 'onboarding.assigned',
  'profile_update.info_requested', 'review.feedback_requested', 'review.manager_requested', 'review.self_requested',
  'review.self_submitted', 'shift_swap.asked', 'survey.opened', 'task.assigned',
]);

/** Whether a notification kind asks the person to act. */
export function kindNeedsAction(kind: string): boolean {
  return ACTION_KINDS.has(kind) || /\.(requested|awaiting_action)$/.test(kind);
}

/** Whether a local time (minutes after midnight) falls in quiet hours; a range past midnight (20:00 to 08:00) wraps. */
export function inQuietHours(q: QuietHours, minutesNow: number): boolean {
  if (!q.enabled) return false;
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const from = m(q.from);
  const to = m(q.to);
  if (from === to) return true;
  return from < to ? minutesNow >= from && minutesNow < to : minutesNow >= from || minutesNow < to;
}

/**
 * The menu tab that marks each category's unread notices (Leave ●1, Attendance ●5 ...). The first tab the person
 * has in their menu wins, so an employee's Payroll notices mark Payslips and a payroll admin's mark Payroll runs. A
 * category with no tab in someone's menu is still counted on Notifications.
 */
export const NOTIFICATION_NAV: Record<NotificationCategory, string[]> = {
  approvals: ['/approvals'],
  leave: ['/leave'],
  attendance: ['/attendance', '/attendance/team'],
  communication: ['/communication', '/helpdesk/queue', '/helpdesk'],
  announcements: ['/announcements'],
  hr_tasks: ['/tasks'],
  manager_tasks: ['/tasks'],
  appraisal: ['/appraisal', '/reviews', '/goals'],
  learning: ['/learning'],
  profile: ['/profile/updates', '/employees'],
  documents: ['/tasks'],
  verification: ['/verification'],
  assets: ['/assets/mine', '/assets'],
  recruitment: ['/recruitment', '/recruitment/candidates'],
  payroll: ['/payslips', '/payroll', '/expenses'],
  system: ['/settings/security', '/settings/workspace'],
};

export const notificationListQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  /** Only notices that ask the person to act. */
  action: z.enum(['true']).optional(),
  category: z.enum(NOTIFICATION_CATEGORY_KEYS).optional(),
  priority: z.enum(NOTIFICATION_PRIORITIES).optional(),
  q: z.string().trim().max(100).optional(),
  /** Paging: notifications created before this time. */
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const notificationReadInput = z.object({
  /** Mark only this category read; all categories when left out. */
  category: z.enum(NOTIFICATION_CATEGORY_KEYS).optional(),
  /** Mark read the notices about one record (for example when its page is opened). */
  link: z.string().regex(/^\//).max(500).optional(),
});

/** A notification as the API returns it. */
export interface NotificationView {
  id: string;
  kind: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  title: string;
  body: string | null;
  link: string | null;
  /** How many events this notice stands for (chat messages from one conversation are folded into one). */
  count: number;
  actorName: string | null;
  /** The notice asks the person to do something (decide, complete, acknowledge); shown as "Action needed". */
  actionRequired: boolean;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Events pushed over the live stream (/notifications/stream). */
export type LiveEvent =
  | { type: 'notification'; notification: NotificationView; unread: number }
  | { type: 'notifications.read'; unread: number }
  | { type: 'chat.message'; conversationId: string; messageId: string; authorMembershipId: string }
  | { type: 'chat.read'; conversationId: string; membershipId: string; at: string }
  | { type: 'chat.updated'; conversationId: string }
  | { type: 'approvals.changed' }
  | { type: 'ping' };
