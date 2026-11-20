import { z } from 'zod';

/**
 * Attendance rewards: HR sets the rules (perfect attendance, punctuality) and every employee sees each month whether
 * they earned them, are on track or missed them and why. Only working days count: holidays and weekly offs never do,
 * and leave of the types HR marks as excused (sick leave by default) never breaks a reward.
 */
export const REWARD_KINDS = ['perfect_attendance', 'punctuality'] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];
export const REWARD_ICONS = ['trophy', 'medal', 'star', 'clock'] as const;
export const REWARD_PAYOUT_TYPES = ['none', 'bonus', 'leave_credit'] as const;
export type RewardPayoutType = (typeof REWARD_PAYOUT_TYPES)[number];

export const rewardRuleInput = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(REWARD_KINDS),
  description: z.string().trim().max(300).nullable().default(null),
  icon: z.enum(REWARD_ICONS).default('trophy'),
  active: z.boolean().default(true),
  /** Late arrivals still allowed in the month (0 means none). */
  maxLateDays: z.number().int().min(0).max(31).default(0),
  /** Leave of these types does not break the reward (for example sick leave). */
  excusedLeaveTypeIds: z.array(z.uuid()).max(50).default([]),
  /** Whether a half day (worked half, or half-day leave of a type that is not excused) still counts. */
  allowHalfDays: z.boolean().default(false),
  /** A month counts only when the person had at least this many working days in it (new joiners, long leave). */
  minWorkingDays: z.number().int().min(1).max(31).default(10),
  /**
   * What a winner receives when HR grants the reward: nothing (recognition only), a bonus earning in the next payroll
   * run (an amount in the workspace currency) or extra days of one leave type, credited at once.
   */
  payoutType: z.enum(REWARD_PAYOUT_TYPES).default('none'),
  payoutAmount: z.string().trim().regex(/^\d{1,9}(\.\d{1,2})?$/, 'Use an amount like 500 or 1250.50').nullable().default(null),
  payoutLeaveTypeId: z.uuid().nullable().default(null),
  payoutDays: z.string().trim().regex(/^\d{1,2}(\.(0|00|5|50))?$/, 'Use whole or half days, like 1 or 0.5').nullable().default(null),
}).superRefine((r, ctx) => {
  if (r.payoutType === 'bonus' && !(Number(r.payoutAmount) > 0)) ctx.addIssue({ code: 'custom', path: ['payoutAmount'], message: 'Enter the bonus amount' });
  if (r.payoutType === 'leave_credit') {
    if (!r.payoutLeaveTypeId) ctx.addIssue({ code: 'custom', path: ['payoutLeaveTypeId'], message: 'Choose the leave type to credit' });
    if (!(Number(r.payoutDays) > 0)) ctx.addIssue({ code: 'custom', path: ['payoutDays'], message: 'Enter the days to credit' });
  }
});
export type RewardRuleInput = z.infer<typeof rewardRuleInput>;

/** HR grants a month's winners their payout: every winner of every paying rule, or one rule, or chosen people. */
export const rewardGrantInput = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Use a month like 2026-11'),
  ruleId: z.uuid().optional(),
  employeeIds: z.array(z.uuid()).min(1).max(5000).optional(),
});
export const rewardRevokeInput = z.object({ reason: z.string().trim().min(3, 'Say why the reward is taken back (at least 3 characters)').max(300) });

export const rewardMonthQuery = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Use a month like 2026-11').optional() });

export type RewardStatus = 'earned' | 'on_track' | 'missed' | 'not_eligible';

/** One day as the reward check sees it. */
export interface RewardDay {
  date: string;
  dayType: 'working' | 'weekly_off' | 'holiday' | string;
  status: string;
  lateMinutes: number;
  /** The leave type on a leave day, when known. */
  leaveTypeId?: string | null;
}

/**
 * Evaluates one rule over a month's days. `complete` says whether the month is over; an open month can only be on
 * track or missed. Pure, so the API and the tests share it.
 */
export function evaluateReward(rule: Pick<RewardRuleInput, 'kind' | 'maxLateDays' | 'excusedLeaveTypeIds' | 'allowHalfDays' | 'minWorkingDays'>, days: RewardDay[], complete: boolean): { status: RewardStatus; done: number; total: number; reason: string | null } {
  const working = days.filter((d) => d.dayType === 'working' && d.status !== 'not_joined' && d.status !== 'in_progress');
  const excused = new Set(rule.excusedLeaveTypeIds);
  const isExcusedLeave = (d: RewardDay) => (d.status === 'on_leave' || d.status === 'half_day_leave') && !!d.leaveTypeId && excused.has(d.leaveTypeId);
  const counted = working.filter((d) => !isExcusedLeave(d));
  let late = 0;
  let missed: string | null = null;
  let good = 0;
  for (const d of counted) {
    const isLate = d.lateMinutes > 0;
    if (isLate) late++;
    const halfOk = rule.allowHalfDays && (d.status === 'half_day' || d.status === 'half_day_leave');
    if (rule.kind === 'perfect_attendance') {
      if (d.status === 'present' || halfOk) good++;
      else if (!missed) missed = d.status === 'on_leave' || d.status === 'half_day_leave' ? `Leave on ${d.date}` : d.status === 'missing_punch' ? `Missing punch on ${d.date}` : d.status === 'half_day' ? `Half day on ${d.date}` : `Absent on ${d.date}`;
    } else {
      // Punctuality only looks at days the person came in.
      if (d.status === 'present' || d.status === 'half_day') good += isLate ? 0 : 1;
    }
  }
  if (late > rule.maxLateDays && !missed) missed = rule.maxLateDays ? `Late on ${late} days (up to ${rule.maxLateDays} allowed)` : `Late on ${late} ${late === 1 ? 'day' : 'days'}`;
  const total = counted.length;
  if (missed) return { status: 'missed', done: good, total, reason: missed };
  if (!complete) return { status: 'on_track', done: good, total, reason: null };
  if (working.length < rule.minWorkingDays) return { status: 'not_eligible', done: good, total, reason: `Only ${working.length} working days in the month (${rule.minWorkingDays} needed)` };
  if (rule.kind === 'punctuality' && good === 0) return { status: 'not_eligible', done: 0, total, reason: 'No days at work this month' };
  return { status: 'earned', done: good, total, reason: null };
}

/** The two rules most companies start with. */
export const DEFAULT_REWARD_RULES: RewardRuleInput[] = [
  { name: 'Perfect attendance', kind: 'perfect_attendance', description: 'Present on every working day of the month. Sick leave does not count against you.', icon: 'trophy', active: true, maxLateDays: 2, excusedLeaveTypeIds: [], allowHalfDays: false, minWorkingDays: 15, payoutType: 'none', payoutAmount: null, payoutLeaveTypeId: null, payoutDays: null },
  { name: 'Always on time', kind: 'punctuality', description: 'Never late in the month.', icon: 'clock', active: true, maxLateDays: 0, excusedLeaveTypeIds: [], allowHalfDays: true, minWorkingDays: 10, payoutType: 'none', payoutAmount: null, payoutLeaveTypeId: null, payoutDays: null },
];
