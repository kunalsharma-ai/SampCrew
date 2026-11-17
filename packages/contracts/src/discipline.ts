/**
 * Late-coming reminders and attendance penalties (same-day leave), shared by the API, the Web Portal and the tests.
 *
 * - A late reminder is sent to an employee for a work day they arrived late: automatically when attendance computes the
 *   day as late, or by a manager or HR by hand. Each one is an in-app notification and, when the workspace wants it, an
 *   email.
 * - Reminders are counted per calendar month. When the count reaches a tier the workspace set (for example 3 reminders
 *   = 5% of the month's gross pay, 5 reminders = 1 day's pay), that tier's deduction applies to the month. Only the
 *   highest tier reached applies; tiers do not add up.
 * - Leave applied on the day it starts (or after it started) is "same-day leave". The workspace chooses whether a
 *   penalty of N days' pay (0.5 steps: 2, 3.5, ...) is applied automatically, or left to the approving manager, who can
 *   always apply, change or waive one.
 * - Penalties are deduction lines on the month's payslip, computed by the payroll engine.
 */
import { z } from 'zod';
import { isoDate } from './schemas/people';

export const PENALTY_KINDS = ['late_coming', 'same_day_leave'] as const;
export type PenaltyKind = (typeof PENALTY_KINDS)[number];
export const DEDUCTION_BASES = ['percent', 'days'] as const;
export type DeductionBasis = (typeof DEDUCTION_BASES)[number];
export const REMINDER_SOURCES = ['auto', 'manual'] as const;
export const SAME_DAY_MODES = ['auto', 'manual'] as const;

/** "2", "3.5", "0.5": whole or half days, 0.5 to 31. */
export const halfDays = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,2}(\.(0|00|5|50))?$/.test(v) && Number(v) >= 0.5 && Number(v) <= 31, { message: 'Use whole or half days between 0.5 and 31 (for example 2 or 3.5)' })
  .transform((v) => normaliseDays(v));

/** A percentage of pay: more than 0, at most 100, two decimals. */
export const percentValue = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) > 0 && Number(v) <= 100, { message: 'Use a percentage above 0 and at most 100' })
  .transform((v) => String(Number(v)));

export const lateTierInput = z
  .object({
    /** The tier applies once this many reminders were sent in one month. */
    reminders: z.number().int().min(1).max(31),
    basis: z.enum(DEDUCTION_BASES),
    /** A percentage of the month's gross pay, or days of pay. */
    value: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
  })
  .superRefine((t, ctx) => {
    const r = (t.basis === 'percent' ? percentValue : halfDays).safeParse(t.value);
    if (!r.success) ctx.addIssue({ code: 'custom', path: ['value'], message: r.error.issues[0]!.message });
  })
  .transform((t) => ({ ...t, value: t.basis === 'percent' ? percentValue.parse(t.value) : halfDays.parse(t.value) }));
export type LateTier = z.infer<typeof lateTierInput>;

export const latePolicyInput = z
  .object({
    enabled: z.boolean(),
    /** Send a reminder by itself as soon as attendance shows the person arrived late. Off: managers send them by hand. */
    autoReminders: z.boolean().default(true),
    /** Only arrivals at least this many minutes late (after the shift's grace) get an automatic reminder. */
    minLateMinutes: z.number().int().min(1).max(600).default(1),
    /** Also email each reminder, besides the in-app notification. */
    email: z.boolean().default(true),
    /** Tell the person's manager too. */
    notifyManager: z.boolean().default(false),
    /** Deductions by reminders in one month; the highest tier reached applies. Empty: reminders only, no deduction. */
    tiers: z.array(lateTierInput).max(6).default([]),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<number>();
    for (const [i, t] of p.tiers.entries()) {
      if (seen.has(t.reminders)) ctx.addIssue({ code: 'custom', path: ['tiers', i, 'reminders'], message: `Two tiers start at ${t.reminders} reminders` });
      seen.add(t.reminders);
    }
  })
  .transform((p) => ({ ...p, tiers: [...p.tiers].sort((a, b) => a.reminders - b.reminders) }));
export type LatePolicyInput = z.infer<typeof latePolicyInput>;

export const sameDayLeavePolicyInput = z.object({
  enabled: z.boolean(),
  /** auto: the penalty is applied when the request is made (the manager can change or waive it). manual: the manager decides. */
  mode: z.enum(SAME_DAY_MODES).default('manual'),
  /** The penalty in days of pay, applied automatically, and suggested to the manager in manual mode. */
  penaltyDays: halfDays.default('1'),
  /** Leave applied after its start date (backdated) counts as same-day leave too. */
  includeBackdated: z.boolean().default(true),
  /** Leave types that never get a penalty (for example sick leave). */
  exemptLeaveTypeIds: z.array(z.uuid()).max(50).default([]),
});
export type SameDayLeavePolicyInput = z.infer<typeof sameDayLeavePolicyInput>;

export const manualReminderInput = z.object({
  employeeId: z.uuid(),
  workDate: isoDate,
  /** Required when attendance does not show the person as late that day. Shown to the employee. */
  note: z.string().trim().max(500).optional(),
});

export const withdrawInput = z.object({ reason: z.string().trim().min(3).max(500) });

export const leavePenaltyInput = z.object({
  days: halfDays,
  reason: z.string().trim().max(500).optional(),
});

export const monthQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
  employeeId: z.uuid().optional(),
});

/** "2.00" -> "2", "3.50" -> "3.5". */
export function normaliseDays(v: string): string {
  return String(Number(v));
}

/** The highest tier a month's reminder count reaches, if any. */
export function tierFor(count: number, tiers: LateTier[]): LateTier | null {
  let best: LateTier | null = null;
  for (const t of tiers) if (count >= t.reminders && (!best || t.reminders > best.reminders)) best = t;
  return best;
}

/** The next tier above the count, to tell the employee how many reminders are left before it. */
export function nextTier(count: number, tiers: LateTier[]): LateTier | null {
  return [...tiers].sort((a, b) => a.reminders - b.reminders).find((t) => t.reminders > count) ?? null;
}

/** A deduction as people read it: "5% of the month's gross pay" or "1.5 days' pay". */
export function deductionText(basis: DeductionBasis, value: string): string {
  if (basis === 'percent') return `${value}% of the month's gross pay`;
  return `${value} day${value === '1' ? "'s" : "s'"} pay`;
}

/** True when leave applied on `appliedOn` (the employee's local date) for `startDate` is same-day leave. */
export function isSameDayLeave(startDate: string, appliedOn: string, includeBackdated: boolean): boolean {
  return includeBackdated ? startDate <= appliedOn : startDate === appliedOn;
}

/** Plain-language summary of a reminder, for the notification and email. */
export function reminderText(r: { workDate: string; lateMinutes: number | null; firstIn: string | null; shiftStart: string | null; note: string | null; count: number; tiers: LateTier[]; manual: boolean }) {
  const parts: string[] = [];
  if (r.lateMinutes && r.firstIn && r.shiftStart) parts.push(`You arrived at ${r.firstIn} on ${r.workDate}, ${r.lateMinutes} minutes after your shift start of ${r.shiftStart}.`);
  else if (r.lateMinutes) parts.push(`You arrived ${r.lateMinutes} minutes late on ${r.workDate}.`);
  else parts.push(`This is about your arrival on ${r.workDate}.`);
  if (r.note) parts.push(`${r.manual ? 'Note from your manager' : 'Note'}: ${r.note}`);
  parts.push(`This is late reminder ${r.count} this month.`);
  const reached = tierFor(r.count, r.tiers);
  const next = nextTier(r.count, r.tiers);
  if (reached) parts.push(`Because you reached ${reached.reminders} reminders, ${deductionText(reached.basis, reached.value)} will be deducted from this month's salary.`);
  if (next) parts.push(`At ${next.reminders} reminders, ${deductionText(next.basis, next.value)} is deducted.`);
  return parts.join(' ');
}
