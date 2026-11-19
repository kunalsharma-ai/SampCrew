import { z } from 'zod';
import { isoDate } from './people';

/**
 * What a leave type is for. Standard types are time off; work from home marks the person present (it is not an
 * absence); comp-off is earned by working extra days (HR credits it with an adjustment); optional holiday can only be
 * taken on a holiday the calendar marks optional.
 */
export const LEAVE_TYPE_KINDS = ['standard', 'wfh', 'comp_off', 'optional_holiday'] as const;
export type LeaveTypeKind = (typeof LEAVE_TYPE_KINDS)[number];
export const LEAVE_TYPE_KIND_LABELS: Record<LeaveTypeKind, string> = {
  standard: 'Time off', wfh: 'Work from home (counts as present)', comp_off: 'Compensatory off (credited by HR)', optional_holiday: 'Optional holiday (only on optional holidays)',
};
/** Who may take a type, read from the employee's recorded gender. Someone with no recorded gender is not blocked. */
export const LEAVE_GENDERS = ['any', 'female', 'male'] as const;

export const leaveTypeInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,12}$/, 'Use up to 12 capital letters, digits or _'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  paid: z.boolean().default(true),
  allowHalfDay: z.boolean().default(true),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f46e5'),
  kind: z.enum(LEAVE_TYPE_KINDS).default('standard'),
  eligibleGender: z.enum(LEAVE_GENDERS).default('any'),
  /** Count every calendar day, weekly offs and holidays included (maternity leave is usually counted this way). */
  countsCalendarDays: z.boolean().default(false),
});

/** Leave quantities are days with at most two decimals, carried as strings so they stay exact. */
export const days = z.union([z.number(), z.string()]).transform((v) => String(v)).pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a number of days with up to 2 decimals'));

/**
 * How a balance builds up. 'granted' keeps a balance that only adjustments add to (comp-off); 'none' keeps no
 * balance at all (unpaid leave, work from home without a cap).
 */
export const ACCRUAL_METHODS = ['annual_upfront', 'monthly', 'granted', 'none'] as const;

/**
 * A policy says who gets how much of a leave type. Each scope field narrows it; empty means everyone. When several
 * policies fit a person, the most specific one wins (see leavePolicyRank).
 */
export const leavePolicyInput = z.object({
  leaveTypeId: z.uuid(),
  legalEntityId: z.uuid().nullable().default(null),
  departmentId: z.uuid().nullable().default(null),
  designationId: z.uuid().nullable().default(null),
  locationId: z.uuid().nullable().default(null),
  accrualMethod: z.enum(ACCRUAL_METHODS),
  annualEntitlement: days,
  carryForwardMax: days.default('0'),
  allowNegativeBalance: z.boolean().default(false),
  minNoticeDays: z.number().int().min(0).max(365).default(0),
  maxConsecutiveDays: days.nullable().default(null),
  availableDuringProbation: z.boolean().default(true),
  rounding: z.enum(['none', 'half_day']).default('half_day'),
});

export const holidayCalendarInput = z.object({
  name: z.string().trim().min(1).max(120),
  legalEntityId: z.uuid().nullable().default(null),
  locationId: z.uuid().nullable().default(null),
  isDefault: z.boolean().default(false),
  weeklyOffs: z.array(z.number().int().min(0).max(6)).max(6).default([0, 6]),
});
export const holidayInput = z.object({ date: isoDate, name: z.string().trim().min(1).max(120), isOptional: z.boolean().default(false) });

export const leaveRequestInput = z
  .object({
    leaveTypeId: z.uuid(),
    startDate: isoDate,
    endDate: isoDate,
    startHalf: z.enum(['full', 'second_half']).default('full'),
    endHalf: z.enum(['full', 'first_half']).default('full'),
    reason: z.string().trim().max(1000).optional(),
    /** HR may file on someone's behalf; omitted means "for me". */
    employeeId: z.uuid().optional(),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'The end date is before the start date', path: ['endDate'] })
  .refine((v) => v.startDate !== v.endDate || v.startHalf === 'full' || v.endHalf === 'full', {
    message: 'For a single day choose either the first or the second half',
    path: ['endHalf'],
  });
export type LeaveRequestInput = z.infer<typeof leaveRequestInput>;

/** Changing a request: the same fields as applying, for the same person. */
export const leaveModifyInput = z
  .object({
    leaveTypeId: z.uuid(),
    startDate: isoDate,
    endDate: isoDate,
    startHalf: z.enum(['full', 'second_half']).default('full'),
    endHalf: z.enum(['full', 'first_half']).default('full'),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'The end date is before the start date', path: ['endDate'] })
  .refine((v) => v.startDate !== v.endDate || v.startHalf === 'full' || v.endHalf === 'full', {
    message: 'For a single day choose either the first or the second half',
    path: ['endHalf'],
  });
export type LeaveModifyInput = z.infer<typeof leaveModifyInput>;

export const leaveAdjustmentInput = z.object({
  employeeId: z.uuid(),
  leaveTypeId: z.uuid(),
  quantity: z.string().regex(/^-?\d{1,3}(\.\d{1,2})?$/, 'Use a signed number of days, e.g. 2 or -1.5').refine((v) => Number(v) !== 0, 'Cannot be zero'),
  note: z.string().trim().min(3, 'Add a remark of at least 3 characters: it is shown to the employee and kept in the history').max(500),
});
export const leaveAdjustmentsQuery = z.object({
  employeeId: z.uuid().optional(),
  leaveTypeId: z.uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const leaveBalanceOverviewQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  departmentId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});
export const leaveStandardTypesInput = z.object({ codes: z.array(z.string().regex(/^[A-Z0-9_]{1,12}$/)).min(1).max(20) });

/** The scope fields of a policy and of the person it may apply to. */
export interface LeavePolicyScope { legalEntityId: string | null; departmentId: string | null; designationId: string | null; locationId: string | null }

/**
 * How well a policy fits a person: -1 when a scope field names something else, otherwise higher for more specific
 * policies. A location beats a designation, which beats a department, which beats a legal entity, and two fields beat one.
 */
export function leavePolicyRank(policy: LeavePolicyScope, person: LeavePolicyScope): number {
  const fields = [['legalEntityId', 1], ['departmentId', 2], ['designationId', 4], ['locationId', 8]] as const;
  let rank = 0;
  for (const [f, weight] of fields) {
    if (policy[f] === null || policy[f] === undefined) continue;
    if (policy[f] !== person[f]) return -1;
    rank += weight;
  }
  return rank;
}

export const leaveCancelInput = z.object({ reason: z.string().trim().max(500).optional() });
export const leaveRunInput = z.object({ asOf: isoDate.optional() });
export const yearEndInput = z.object({ year: z.number().int().min(2000).max(2200) });

export const APPROVAL_STEP_TYPES = ['manager', 'skip_level_manager', 'role'] as const;
export const approvalPolicyInput = z.object({
  steps: z
    .array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('manager') }),
      z.object({ type: z.literal('skip_level_manager') }),
      z.object({ type: z.literal('role'), role: z.string().regex(/^[a-z_]+$/) }),
    ]))
    .min(1)
    .max(5),
});

/**
 * The leave types and workspace-wide policies a new workspace starts with, so employees can apply for leave from
 * day one. HR changes the entitlements on Leave settings; they are a starting point, not any country's statutory minimum.
 */
export const DEFAULT_LEAVE_TYPES = [
  { code: 'CL', name: 'Casual leave', paid: true, allowHalfDay: true, color: '#2563eb', accrualMethod: 'annual_upfront', annualEntitlement: '8', carryForwardMax: '0' },
  { code: 'SL', name: 'Sick leave', paid: true, allowHalfDay: true, color: '#dc2626', accrualMethod: 'annual_upfront', annualEntitlement: '8', carryForwardMax: '0' },
  { code: 'EL', name: 'Earned leave', paid: true, allowHalfDay: false, color: '#059669', accrualMethod: 'monthly', annualEntitlement: '15', carryForwardMax: '30' },
  { code: 'LWP', name: 'Leave without pay', paid: false, allowHalfDay: true, color: '#6b7280', accrualMethod: 'none', annualEntitlement: '0', carryForwardMax: '0' },
] as const;

/**
 * The standard catalogue HR can pick from on Leave settings. Each comes with a workspace-wide starting policy that HR
 * then changes; the numbers are common starting points, not any country's statutory minimum. Half days are an option on
 * each type rather than a type of their own.
 */
export const STANDARD_LEAVE_TYPES = [
  { code: 'CL', name: 'Casual leave', kind: 'standard', paid: true, allowHalfDay: true, color: '#2563eb', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '8', carryForwardMax: '0' },
  { code: 'SL', name: 'Sick leave', kind: 'standard', paid: true, allowHalfDay: true, color: '#dc2626', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '8', carryForwardMax: '0' },
  { code: 'EL', name: 'Earned leave', kind: 'standard', paid: true, allowHalfDay: false, color: '#059669', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'monthly', annualEntitlement: '15', carryForwardMax: '30' },
  { code: 'PL', name: 'Privilege leave', kind: 'standard', paid: true, allowHalfDay: false, color: '#0d9488', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'monthly', annualEntitlement: '18', carryForwardMax: '45' },
  { code: 'ML', name: 'Maternity leave', kind: 'standard', paid: true, allowHalfDay: false, color: '#db2777', eligibleGender: 'female', countsCalendarDays: true, accrualMethod: 'annual_upfront', annualEntitlement: '182', carryForwardMax: '0' },
  { code: 'PTL', name: 'Paternity leave', kind: 'standard', paid: true, allowHalfDay: false, color: '#7c3aed', eligibleGender: 'male', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '5', carryForwardMax: '0' },
  { code: 'BL', name: 'Bereavement leave', kind: 'standard', paid: true, allowHalfDay: false, color: '#475569', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '3', carryForwardMax: '0' },
  { code: 'CO', name: 'Compensatory off', kind: 'comp_off', paid: true, allowHalfDay: true, color: '#ea580c', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'granted', annualEntitlement: '0', carryForwardMax: '0' },
  { code: 'OH', name: 'Optional holiday', kind: 'optional_holiday', paid: true, allowHalfDay: false, color: '#ca8a04', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '2', carryForwardMax: '0' },
  { code: 'WFH', name: 'Work from home', kind: 'wfh', paid: true, allowHalfDay: true, color: '#0891b2', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'none', annualEntitlement: '0', carryForwardMax: '0' },
  { code: 'LOP', name: 'Loss of pay', kind: 'standard', paid: false, allowHalfDay: true, color: '#6b7280', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'none', annualEntitlement: '0', carryForwardMax: '0' },
  { code: 'LWP', name: 'Leave without pay', kind: 'standard', paid: false, allowHalfDay: true, color: '#6b7280', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'none', annualEntitlement: '0', carryForwardMax: '0' },
] as const;
