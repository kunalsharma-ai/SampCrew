import { z } from 'zod';
import { isoDate } from './people';

export const leaveTypeInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,12}$/, 'Use up to 12 capital letters, digits or _'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  paid: z.boolean().default(true),
  allowHalfDay: z.boolean().default(true),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f46e5'),
});

/** Leave quantities are days with at most two decimals, carried as strings so they stay exact. */
export const days = z.union([z.number(), z.string()]).transform((v) => String(v)).pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a number of days with up to 2 decimals'));

export const leavePolicyInput = z.object({
  leaveTypeId: z.uuid(),
  legalEntityId: z.uuid().nullable().default(null),
  accrualMethod: z.enum(['annual_upfront', 'monthly', 'none']),
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

export const leaveAdjustmentInput = z.object({
  employeeId: z.uuid(),
  leaveTypeId: z.uuid(),
  quantity: z.string().regex(/^-?\d{1,3}(\.\d{1,2})?$/, 'Use a signed number of days, e.g. 2 or -1.5').refine((v) => Number(v) !== 0, 'Cannot be zero'),
  note: z.string().trim().min(3).max(500),
});

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
