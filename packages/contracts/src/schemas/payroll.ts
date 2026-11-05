import { z } from 'zod';
import { isoDate } from './people';

const money = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use an amount such as 25000 or 25000.50');
const percent = z.string().trim().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Use a percentage such as 12 or 8.33').refine((v) => Number(v) <= 100, 'At most 100%');
const optionalText = (max: number) => z.string().trim().max(max).optional();

// Components and structures -------------------------------------------------------------------------------

export const COMPONENT_KINDS = ['earning', 'deduction'] as const;
export const CALC_METHODS = ['fixed', 'percent_of_ctc', 'percent_of_basic', 'balance'] as const;

export const componentInput = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'Use 2 to 20 capital letters, digits or _'),
  name: z.string().trim().min(2).max(60),
  kind: z.enum(COMPONENT_KINDS),
  taxable: z.boolean().default(true),
  /** Paid in proportion to paid days. Fixed deductions are never prorated. */
  prorate: z.boolean().default(true),
  /** Counts as wages for Provident Fund (Basic and DA usually). */
  pfWage: z.boolean().default(false),
  description: z.string().trim().max(300).default(''),
});
export type ComponentInput = z.infer<typeof componentInput>;

export const structureInput = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).default(''),
    lines: z
      .array(z.object({ componentId: z.uuid(), calc: z.enum(CALC_METHODS), value: z.string().trim().regex(/^\d{1,12}(\.\d{1,4})?$/).default('0') }))
      .min(1)
      .max(20),
  })
  .refine((v) => new Set(v.lines.map((l) => l.componentId)).size === v.lines.length, { message: 'Each component can appear once', path: ['lines'] })
  .refine((v) => v.lines.filter((l) => l.calc === 'balance').length <= 1, { message: 'Only one component can take the balance', path: ['lines'] });
export type StructureInput = z.infer<typeof structureInput>;

// Employee salaries ---------------------------------------------------------------------------------------

export const salaryInput = z.object({
  effectiveFrom: isoDate,
  annualCtc: money,
  structureId: z.uuid(),
  pfEnabled: z.boolean().default(true),
  /** ESI applies automatically while the monthly gross is under the ceiling; switch it off for exempt people. */
  esiEnabled: z.boolean().default(true),
  ptEnabled: z.boolean().default(true),
  tdsEnabled: z.boolean().default(true),
  note: optionalText(500),
});
export type SalaryInput = z.infer<typeof salaryInput>;

// Statutory settings --------------------------------------------------------------------------------------

const slab = z.object({ upTo: money.nullable(), amount: money, februaryAmount: money.optional() });
export const statutorySettingsSchema = z.object({
  pf: z.object({ employeeRatePercent: percent, employerRatePercent: percent, epsRatePercent: percent, wageCeiling: money, restrictToCeiling: z.boolean() }),
  esi: z.object({ employeeRatePercent: percent, employerRatePercent: percent, grossCeiling: money }),
  pt: z.object({ states: z.record(z.string().trim().min(2).max(60), z.array(slab).min(1).max(12)) }),
  tds: z.object({
    regime: z.literal('new'),
    standardDeduction: money,
    slabs: z.array(z.object({ upTo: money.nullable(), ratePercent: percent })).min(1).max(12),
    rebateLimit: money,
    cessPercent: percent,
    surchargeThreshold: money,
  }),
});

export const LOP_SOURCES = ['attendance_and_leave', 'leave_only'] as const;
export const statutoryInput = z.object({
  legalEntityId: z.uuid(),
  effectiveFrom: isoDate,
  /** Where loss-of-pay days come from: absences and half days in attendance plus unpaid leave, or unpaid leave only. */
  lopSource: z.enum(LOP_SOURCES).default('attendance_and_leave'),
  settings: statutorySettingsSchema,
});
export type StatutoryInput = z.infer<typeof statutoryInput>;

// Payroll runs --------------------------------------------------------------------------------------------

export const PAYROLL_RUN_STATUSES = ['draft', 'computed', 'pending_approval', 'finalised', 'cancelled'] as const;
export const payrollRunInput = z.object({
  legalEntityId: z.uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month'),
  payDate: isoDate,
});
export const adjustmentInput = z.object({
  employeeId: z.uuid(),
  kind: z.enum(COMPONENT_KINDS),
  label: z.string().trim().min(2).max(60),
  amount: money.refine((v) => Number(v) > 0, 'Enter an amount above zero'),
  taxable: z.boolean().default(true),
  reason: z.string().trim().min(3).max(300),
});
export const itemOverrideInput = z.object({
  /** Replace the loss-of-pay days worked out from attendance and leave. null goes back to the calculated value. */
  lopDays: z.string().regex(/^\d{1,2}(\.(0|5|00|50))?$/, 'Use whole or half days').nullable().optional(),
  hold: z.boolean().optional(),
  reason: z.string().trim().min(3).max(300),
});

// Expenses ------------------------------------------------------------------------------------------------

export const EXPENSE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'paid'] as const;
export const expenseCategoryInput = z.object({
  name: z.string().trim().min(2).max(60),
  receiptRequired: z.boolean().default(true),
  maxPerClaim: money.nullable().default(null),
});
export const expenseClaimInput = z.object({
  categoryId: z.uuid(),
  spentOn: isoDate,
  amount: money.refine((v) => Number(v) > 0, 'Enter an amount above zero'),
  description: z.string().trim().min(3).max(500),
});
export const RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
