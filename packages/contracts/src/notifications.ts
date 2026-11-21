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

const channelSetting = z.object({ inApp: z.boolean().default(true), email: z.boolean().default(true) });

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

export interface NotificationPreferences {
  categories: Record<NotificationCategory, { inApp: boolean; email: boolean }>;
  sound: NotificationSoundSettings;
  toasts: boolean;
  desktop: boolean;
  quiet: QuietHours;
}

/** A person's preferences with every category filled in; mandatory categories are always on in the app. */
export function resolveNotificationPreferences(raw: unknown): NotificationPreferences {
  const parsed = notificationPreferencesInput.safeParse(raw ?? {});
  const p = parsed.success ? parsed.data : notificationPreferencesInput.parse({});
  const categories = Object.fromEntries(
    NOTIFICATION_CATEGORY_KEYS.map((k) => {
      const c = p.categories[k] ?? { inApp: true, email: true };
      return [k, { inApp: MANDATORY_CATEGORIES.includes(k) ? true : c.inApp, email: c.email }];
    }),
  ) as NotificationPreferences['categories'];
  return { categories, sound: p.sound, toasts: p.toasts, desktop: p.desktop, quiet: p.quiet };
}

export const PRIORITY_RANK: Record<NotificationPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** Whether a notice of this priority should make a sound for someone with these settings. */
export function shouldPlaySound(sound: NotificationSoundSettings, priority: NotificationPriority): boolean {
  return sound.enabled && sound.volume > 0 && PRIORITY_RANK[priority] >= PRIORITY_RANK[sound.minPriority];
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
 * The menu item that shows each category's unread count (the sidebar dot). Approvals, Communication, Announcements and
 * tasks keep their own counts (requests waiting, unread messages ...), so they are not listed here.
 */
export const NOTIFICATION_NAV: Partial<Record<NotificationCategory, string>> = {
  leave: '/leave',
  attendance: '/attendance',
  learning: '/learning',
  appraisal: '/appraisal',
  payroll: '/payslips',
  documents: '/tasks',
  assets: '/assets/mine',
  recruitment: '/recruitment',
  profile: '/profile',
  verification: '/verification',
};

export const notificationListQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
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
