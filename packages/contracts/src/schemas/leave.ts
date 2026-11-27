import { z } from 'zod';
import { isoDate } from './people';

/**
 * Leave management (rebuilt 2026-11-21). One central record for each leave type, allocation, request and balance line,
 * read and written by the Super Workspace, the HR Workspaces and the Employee Workspace through the same API:
 *
 *  - Super Workspace creates and edits leave types. A type carries its whole policy (entitlement, durations, carry
 *    forward, documents, notice) and its approval rules. Every change is a new version; requests keep the version
 *    they were made under, so a later change never rewrites history.
 *  - Creating a type gives it to nobody. Allocation is a separate step: the Super Workspace allocates a type to
 *    employees (all eligible, departments, designations, employment types, groups or named people), or makes it
 *    available to an HR Workspace, which then allocates it to its own people, never outside the type's eligibility.
 *  - An employee applies for the types allocated to them. The type's approval rules decide who reviews it: the HR
 *    Workspace, the Super Workspace, or both (at the same time or one after the other), optionally chosen by the
 *    employee among the routes the type allows. A request is approved only when every authority it needs approved it.
 */

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

/** A grouping for leave types on screens and reports. */
export const LEAVE_CATEGORIES = ['general', 'medical', 'family', 'statutory', 'special', 'unpaid', 'other'] as const;
export type LeaveCategory = (typeof LEAVE_CATEGORIES)[number];
export const LEAVE_CATEGORY_LABELS: Record<LeaveCategory, string> = {
  general: 'General', medical: 'Medical', family: 'Family', statutory: 'Statutory', special: 'Special', unpaid: 'Unpaid', other: 'Other',
};

/** Employment types as employee records hold them. Full time is what most companies call permanent employment. */
export const LEAVE_EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'temporary'] as const;
export type LeaveEmploymentType = (typeof LEAVE_EMPLOYMENT_TYPES)[number];
export const LEAVE_EMPLOYMENT_TYPE_LABELS: Record<LeaveEmploymentType, string> = {
  full_time: 'Permanent (full time)', part_time: 'Part time', contract: 'Contract', intern: 'Intern', temporary: 'Temporary',
};

/** Leave quantities are days with at most two decimals, carried as strings so they stay exact. */
export const days = z.union([z.number(), z.string()]).transform((v) => String(v)).pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a number of days with up to 2 decimals'));
const positiveDays = days.refine((v) => Number(v) > 0, 'Must be more than 0');

/**
 * How a balance builds up. 'granted' keeps a balance that only adjustments add to (comp-off); 'none' keeps no
 * balance at all (unpaid leave, work from home without a cap).
 */
export const ACCRUAL_METHODS = ['annual_upfront', 'quarterly', 'monthly', 'granted', 'none'] as const;
export type AccrualMethod = (typeof ACCRUAL_METHODS)[number];
export const ACCRUAL_METHOD_LABELS: Record<AccrualMethod, string> = {
  annual_upfront: 'Yearly, credited on 1 January (prorated for joiners)',
  quarterly: 'Quarterly, credited at the start of each quarter',
  monthly: 'Monthly, credited on the 1st of each month',
  granted: 'Credited by HR only (no automatic credit)',
  none: 'Not tracked (no balance, no limit)',
};

const uniqueIds = (max: number) => z.array(z.uuid()).max(max).transform((a) => [...new Set(a)]);

/**
 * Who a leave type may ever be given to. Each list narrows it; an empty list does not limit. People named in
 * employeeIds are eligible whatever the other lists say. When nothing is set, everyone is eligible.
 */
export const leaveEligibility = z.object({
  employmentTypes: z.array(z.enum(LEAVE_EMPLOYMENT_TYPES)).max(5).transform((a) => [...new Set(a)]).default([]),
  departmentIds: uniqueIds(500).default([]),
  designationIds: uniqueIds(500).default([]),
  locationIds: uniqueIds(500).default([]),
  legalEntityIds: uniqueIds(100).default([]),
  /** Employee groups (Communication > Groups). */
  groupIds: uniqueIds(100).default([]),
  employeeIds: uniqueIds(2000).default([]),
}).strict();
export type LeaveEligibility = z.infer<typeof leaveEligibility>;

/** The policy of a leave type. A rule that does not apply is switched off with null (or 0 for notice). */
export const leaveTypePolicy = z.object({
  /** Kept for leave types made before 2026-11-23. Nothing is credited automatically any more, whatever it says. */
  accrualMethod: z.enum(ACCRUAL_METHODS).default('none'),
  /** Days a year (the leave year is the calendar year). */
  annualEntitlement: days.default('0'),
  rounding: z.enum(['none', 'half_day']).default('half_day'),
  allowNegativeBalance: z.boolean().default(false),
  /** Working days of notice before the leave starts (0: none). */
  minNoticeDays: z.number().int().min(0).max(365).default(0),
  /** Fewest and most leave days in one application (null: no limit). */
  minDaysPerRequest: positiveDays.nullable().default(null),
  maxDaysPerRequest: positiveDays.nullable().default(null),
  /** Most calendar days from the first to the last day of one application, weekends included (null: no limit). */
  maxConsecutiveDays: positiveDays.nullable().default(null),
  /** Applications over several days. Off: one day (or half day) at a time. */
  allowMultiDay: z.boolean().default(true),
  /** Several days starting or ending with a half day (2.5 days, for example). */
  allowCustomDuration: z.boolean().default(true),
  availableDuringProbation: z.boolean().default(true),
  /** At year end, up to this many unused days move to the next year; the rest lapse (0: everything lapses). */
  carryForwardMax: days.default('0'),
  /** Carried-forward days not used within this many months of the new year lapse (null: they never expire). */
  carriedExpiryMonths: z.number().int().min(1).max(12).nullable().default(null),
  /** Supporting documents: never, always, or only for applications longer than requiredOverDays. */
  documents: z.object({
    mode: z.enum(['none', 'optional', 'required']).default('none'),
    requiredOverDays: positiveDays.nullable().default(null),
    note: z.string().trim().max(300).default(''),
  }).strict().default({ mode: 'none', requiredOverDays: null, note: '' }),
}).strict();
export type LeaveTypePolicy = z.infer<typeof leaveTypePolicy>;

/** Who reviews an application: an HR Workspace, the Super Workspace, or both. */
export const LEAVE_AUTHORITIES = ['hr', 'super', 'both'] as const;
export type LeaveAuthority = (typeof LEAVE_AUTHORITIES)[number];
export const LEAVE_AUTHORITY_LABELS: Record<LeaveAuthority, string> = { hr: 'HR Workspace', super: 'Super Workspace', both: 'Both HR Workspace and Super Workspace' };

/** The approval rules of a leave type. Nothing here depends on a fixed number of days unless Super Workspace sets one. */
export const leaveApprovalRules = z.object({
  /** The routes an application of this type may take. With employeeChooses off, the first one is used. */
  routes: z.array(z.enum(LEAVE_AUTHORITIES)).min(1).max(3).transform((a) => [...new Set(a)]).default(['hr']),
  /** Whether the employee picks one of the routes when applying. */
  employeeChooses: z.boolean().default(false),
  /** With both authorities: at the same time, or HR Workspace first and then Super Workspace. */
  order: z.enum(['simultaneous', 'sequential']).default('simultaneous'),
  /** The employee's reporting manager reviews first, before the authorities. */
  managerFirst: z.boolean().default(false),
  /**
   * The HR Workspace that reviews applications sent to HR. Null: the HR Workspace of the employee, when it manages this
   * type (it was made available to it), otherwise the company's HR team.
   */
  hrWorkspaceId: z.uuid().nullable().default(null),
  /** The Super Workspace administrator who reviews applications sent to the Super Workspace. Null: any of them. */
  superApproverMembershipId: z.uuid().nullable().default(null),
  /** Applications longer than this many days must include the Super Workspace (null: no such rule). */
  superRequiredOverDays: positiveDays.nullable().default(null),
  /** A review still pending after afterDays days is escalated: the Super Workspace is told and may decide it. */
  escalation: z.object({ enabled: z.boolean().default(false), afterDays: z.number().int().min(1).max(60).default(3) }).strict().default({ enabled: false, afterDays: 3 }),
}).strict();
export type LeaveApprovalRules = z.infer<typeof leaveApprovalRules>;

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,12}$/, 'Use up to 12 capital letters, digits or _');

/**
 * Where a leave type appears (2026-11-23): in HR Workspace, in Employee Workspace, or in both. A type appears in a
 * workspace's Leave Management as soon as it is active, visible there and the Leave module is on for that level; no
 * allocation step. Turning visibility off hides it from new applications there; applications already made stay.
 */
export const LEAVE_VISIBILITIES = ['hr', 'employee', 'both'] as const;
export type LeaveVisibility = (typeof LEAVE_VISIBILITIES)[number];
export const LEAVE_VISIBILITY_LABELS: Record<LeaveVisibility, string> = { hr: 'HR Workspace Only', employee: 'Employee Workspace Only', both: 'Both Workspaces' };
export const visibleTo = (v: string | null | undefined, level: 'hr' | 'employee') => (v ?? 'both') === 'both' || v === level;

/** A leave code from a name when none is given: initials, then the first letters (Casual Leave -> CL). */
export function leaveCodeFrom(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]).join('');
  const out = initials.length >= 2 ? initials : (words[0] ?? 'LV').slice(0, 3);
  return out.slice(0, 12) || 'LV';
}

/**
 * Monthly credit (issue #83): days added to everyone who can use the type on the 1st of each month, as an
 * adjustment line in their ledger (so it counts as an assigned quantity). Null: nothing is credited (the default; leave
 * stays manual, as decided on 2026-11-23). Credits start from the month it is switched on and are never back-dated.
 */
export const monthlyCredit = z.union([z.literal(''), z.null(), positiveDays.refine((v) => Number(v) <= 31, 'Use at most 31 days a month')])
  .transform((v) => (v === '' || v === null ? null : v));

/**
 * The simple form (Create New Leave Type): name, description, optional code, visibility and status. The other
 * settings of leaveTypeInput keep their defaults.
 */
export const leaveTypeSimpleInput = z.object({
  name: z.string().trim().min(1, 'Give the leave type a name').max(80),
  description: z.string().trim().max(500).optional(),
  code: z.union([code, z.literal('')]).optional(),
  visibility: z.enum(LEAVE_VISIBILITIES).default('both'),
  status: z.enum(['active', 'inactive']).default('active'),
  /** Paid or unpaid leave (unpaid leave is deducted in payroll). */
  paid: z.boolean().default(true),
  monthlyCredit: monthlyCredit.optional(),
}).strict();
export type LeaveTypeSimpleInput = z.infer<typeof leaveTypeSimpleInput>;

/** Changing where a leave type appears. */
export const leaveVisibilityInput = z.object({ visibility: z.enum(LEAVE_VISIBILITIES) }).strict();

/**
 * Assigning a leave quantity by hand: days of a leave type an employee has for a leave year (calendar year). Until an
 * administrator enters one, the employee sees "Not Assigned". Nothing is ever calculated or credited automatically.
 */
export const leaveQuantityInput = z.object({
  employeeId: z.uuid(),
  leaveTypeId: z.uuid(),
  year: z.number().int().min(2000).max(2100),
  quantity: days,
  note: z.string().trim().max(300).default(''),
}).strict();
export type LeaveQuantityInput = z.infer<typeof leaveQuantityInput>;

/** Creating a leave type (Super Workspace). Every setting has a sensible default, so only name and code are needed. */
export const leaveTypeInput = z.object({
  code,
  visibility: z.enum(LEAVE_VISIBILITIES).default('both'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  category: z.enum(LEAVE_CATEGORIES).default('general'),
  paid: z.boolean().default(true),
  allowHalfDay: z.boolean().default(true),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f46e5'),
  kind: z.enum(LEAVE_TYPE_KINDS).default('standard'),
  eligibleGender: z.enum(LEAVE_GENDERS).default('any'),
  /** Count every calendar day, weekly offs and holidays included (maternity leave is usually counted this way). */
  countsCalendarDays: z.boolean().default(false),
  /** Applications can start on or after this date (null: at once). */
  effectiveFrom: isoDate.nullable().default(null),
  active: z.boolean().default(true),
  /** Whether the Super Workspace may make it available to HR Workspaces for them to allocate. */
  hrAllocatable: z.boolean().default(true),
  monthlyCredit: monthlyCredit.default(null),
  eligibility: leaveEligibility.default({ employmentTypes: [], departmentIds: [], designationIds: [], locationIds: [], legalEntityIds: [], groupIds: [], employeeIds: [] }),
  policy: leaveTypePolicy.default(leaveTypePolicy.parse({})),
  approval: leaveApprovalRules.default(leaveApprovalRules.parse({})),
}).strict();
export type LeaveTypeInput = z.infer<typeof leaveTypeInput>;

/**
 * Editing a leave type: any of the fields, plus the version it was read at (a change made on an older version is
 * refused, so two administrators never silently overwrite each other) and a note for the history.
 */
export const leaveTypeUpdate = z.object({
  code: code.optional(),
  visibility: z.enum(LEAVE_VISIBILITIES).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  category: z.enum(LEAVE_CATEGORIES).optional(),
  paid: z.boolean().optional(),
  allowHalfDay: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  kind: z.enum(LEAVE_TYPE_KINDS).optional(),
  eligibleGender: z.enum(LEAVE_GENDERS).optional(),
  countsCalendarDays: z.boolean().optional(),
  effectiveFrom: isoDate.nullable().optional(),
  hrAllocatable: z.boolean().optional(),
  monthlyCredit: monthlyCredit.optional(),
  eligibility: leaveEligibility.optional(),
  policy: leaveTypePolicy.optional(),
  approval: leaveApprovalRules.optional(),
  version: z.number().int().min(1).optional(),
  note: z.string().trim().max(300).optional(),
}).strict();
export type LeaveTypeUpdate = z.infer<typeof leaveTypeUpdate>;

export const leaveTypeStatusInput = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(3, 'Say why, in at least 3 characters').max(300),
}).strict();

/** Who an allocation reaches. all: everyone eligible. Otherwise each list narrows it, and named people are added. */
export const leaveAllocationCriteria = z.object({
  all: z.boolean().default(false),
  employmentTypes: z.array(z.enum(LEAVE_EMPLOYMENT_TYPES)).max(5).transform((a) => [...new Set(a)]).default([]),
  departmentIds: uniqueIds(500).default([]),
  designationIds: uniqueIds(500).default([]),
  locationIds: uniqueIds(500).default([]),
  legalEntityIds: uniqueIds(100).default([]),
  groupIds: uniqueIds(100).default([]),
  employeeIds: uniqueIds(2000).default([]),
}).strict().refine(
  (c) => c.all || c.employmentTypes.length + c.departmentIds.length + c.designationIds.length + c.locationIds.length + c.legalEntityIds.length + c.groupIds.length + c.employeeIds.length > 0,
  { message: 'Choose who gets it: everyone eligible, or at least one department, designation, employment type, group or person' },
);
export type LeaveAllocationCriteria = z.infer<typeof leaveAllocationCriteria>;

/**
 * Allocating a leave type. To employees: the Super Workspace (anyone eligible) or an HR Workspace (its own people,
 * within the type's eligibility; hrWorkspaceId says which of its HR Workspaces when it runs several). To an HR
 * Workspace: the Super Workspace only; that HR Workspace may then allocate the type and reviews its applications.
 * hrWorkspaceId null with target hr_workspace means the company's HR team (HR Workspace for the whole company).
 */
export const leaveAllocationInput = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('employees'),
    leaveTypeId: z.uuid(),
    hrWorkspaceId: z.uuid().nullable().default(null),
    criteria: leaveAllocationCriteria,
    /** Days a year for the people of this allocation instead of the type's entitlement (null: the type's). */
    entitlementDays: days.nullable().default(null),
    note: z.string().trim().max(300).default(''),
  }).strict(),
  z.object({
    target: z.literal('hr_workspace'),
    leaveTypeId: z.uuid(),
    hrWorkspaceId: z.uuid().nullable(),
    note: z.string().trim().max(300).default(''),
  }).strict(),
]);
export type LeaveAllocationInput = z.infer<typeof leaveAllocationInput>;

export const leaveAllocationRevokeInput = z.object({ reason: z.string().trim().min(3, 'Say why, in at least 3 characters').max(300) }).strict();

/** A person as leave eligibility and allocation read them. */
export interface LeavePerson {
  id: string;
  employmentType: string | null;
  departmentId: string | null;
  designationId: string | null;
  locationId: string | null;
  legalEntityId: string | null;
  hrWorkspaceId: string | null;
  groupIds: readonly string[];
}

type Lists = Pick<LeaveEligibility, 'employmentTypes' | 'departmentIds' | 'designationIds' | 'locationIds' | 'legalEntityIds' | 'groupIds' | 'employeeIds'>;

/** Each list that is set must match; people named in employeeIds always match. Returns null when nothing is set. */
function listsMatch(c: Lists, p: LeavePerson): boolean | null {
  const checks: boolean[] = [];
  if (c.employmentTypes.length) checks.push(!!p.employmentType && (c.employmentTypes as readonly string[]).includes(p.employmentType));
  if (c.departmentIds.length) checks.push(!!p.departmentId && c.departmentIds.includes(p.departmentId));
  if (c.designationIds.length) checks.push(!!p.designationId && c.designationIds.includes(p.designationId));
  if (c.locationIds.length) checks.push(!!p.locationId && c.locationIds.includes(p.locationId));
  if (c.legalEntityIds.length) checks.push(!!p.legalEntityId && c.legalEntityIds.includes(p.legalEntityId));
  if (c.groupIds.length) checks.push(p.groupIds.some((g) => c.groupIds.includes(g)));
  if (c.employeeIds.includes(p.id)) return true;
  if (!checks.length) return c.employeeIds.length ? false : null;
  return checks.every(Boolean);
}

/** Whether a person is inside a leave type's eligibility (empty eligibility: everyone). */
export function leaveEligible(e: Lists, p: LeavePerson): boolean {
  return listsMatch(e, p) ?? true;
}

/** Whether an allocation's criteria reach a person (eligibility is checked separately). */
export function leaveAllocationMatches(c: LeaveAllocationCriteria, p: LeavePerson): boolean {
  if (c.all) return true;
  return listsMatch(c, p) ?? false;
}

/**
 * Whether an allocation stays inside a type's eligibility, for refusing an HR Workspace allocation that names people
 * or groups outside it: every list the type limits must be narrowed at least as much by the allocation (or the
 * allocation names people only, who are then checked one by one).
 */
export function leaveAllocationWithin(c: LeaveAllocationCriteria, e: LeaveEligibility): boolean {
  if (c.all) return true;
  const sub = (a: readonly string[], b: readonly string[]) => !b.length || (a.length > 0 && a.every((x) => b.includes(x)));
  return sub(c.employmentTypes, e.employmentTypes) && sub(c.departmentIds, e.departmentIds) && sub(c.designationIds, e.designationIds)
    && sub(c.locationIds, e.locationIds) && sub(c.legalEntityIds, e.legalEntityIds) && sub(c.groupIds, e.groupIds);
}

/**
 * The routes an application may take, given the type's rules and its length: an application longer than
 * superRequiredOverDays must include the Super Workspace. Order follows the rules.
 */
export function leaveRoutesFor(rules: Pick<LeaveApprovalRules, 'routes' | 'superRequiredOverDays'>, daysRequested: number): LeaveAuthority[] {
  const over = rules.superRequiredOverDays !== null && daysRequested > Number(rules.superRequiredOverDays);
  return rules.routes.filter((r) => !over || r !== 'hr');
}

export const holidayCalendarInput = z.object({
  name: z.string().trim().min(1).max(120),
  legalEntityId: z.uuid().nullable().default(null),
  locationId: z.uuid().nullable().default(null),
  isDefault: z.boolean().default(false),
  weeklyOffs: z.array(z.number().int().min(0).max(6)).max(6).default([0, 6]),
});
export const holidayInput = z.object({ date: isoDate, name: z.string().trim().min(1).max(120), isOptional: z.boolean().default(false) });

const requestFields = {
  leaveTypeId: z.uuid(),
  startDate: isoDate,
  endDate: isoDate,
  startHalf: z.enum(['full', 'second_half']).default('full'),
  endHalf: z.enum(['full', 'first_half']).default('full'),
  reason: z.string().trim().max(1000).optional(),
  /** The approval route the employee chose, where the type lets them choose. Omitted: the type's default route. */
  approvalRoute: z.enum(LEAVE_AUTHORITIES).optional(),
  /** Supporting documents uploaded first with POST /leave/documents. */
  documentIds: z.array(z.uuid()).max(5).default([]),
  /** Custom leave request fields from Form management (issue #91), by field key, saved with the request. */
  customFields: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.unknown()).optional(),
};
const datesOk = <T extends z.ZodType<{ startDate: string; endDate: string; startHalf: string; endHalf: string }>>(s: T) =>
  s.refine((v) => v.endDate >= v.startDate, { message: 'The end date is before the start date', path: ['endDate'] })
    .refine((v) => v.startDate !== v.endDate || v.startHalf === 'full' || v.endHalf === 'full', { message: 'For a single day choose either the first or the second half', path: ['endHalf'] });

export const leaveRequestInput = datesOk(z.object({
  ...requestFields,
  /** HR may file on someone's behalf; omitted means "for me". */
  employeeId: z.uuid().optional(),
}));
export type LeaveRequestInput = z.infer<typeof leaveRequestInput>;

/** Changing a request: the same fields as applying, for the same person. */
export const leaveModifyInput = datesOk(z.object(requestFields));
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
  hrWorkspaceId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});
export const leaveStandardTypesInput = z.object({ codes: z.array(z.string().regex(/^[A-Z0-9_]{1,12}$/)).min(1).max(20) });

export const leaveCancelInput = z.object({ reason: z.string().trim().max(500).optional() });
export const leaveRunInput = z.object({ asOf: isoDate.optional() });
export const yearEndInput = z.object({ year: z.number().int().min(2000).max(2200) });

/** Leave reports: one year, optionally one HR Workspace, department or leave type. */
export const leaveReportQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  hrWorkspaceId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  leaveTypeId: z.uuid().optional(),
});

export const leaveHistoryQuery = z.object({
  leaveTypeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

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

/** A starting template for a leave type: settings only, no allocation. */
export interface LeaveTemplate {
  code: string; name: string; kind: LeaveTypeKind; category: LeaveCategory; paid: boolean; allowHalfDay: boolean; color: string;
  eligibleGender: (typeof LEAVE_GENDERS)[number]; countsCalendarDays: boolean;
  accrualMethod: AccrualMethod; annualEntitlement: string; carryForwardMax: string; description: string;
}

/**
 * The starter leave types the Super Workspace is offered first. They are ordinary leave types once created: their
 * names, codes and every setting can be changed, and nothing in SampCrew depends on these codes.
 */
export const DEFAULT_LEAVE_TYPES: readonly LeaveTemplate[] = [
  { code: 'PL', name: 'Permanent Leave', kind: 'standard', category: 'general', paid: true, allowHalfDay: true, color: '#0d9488', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'monthly', annualEntitlement: '18', carryForwardMax: '30', description: 'Planned paid leave that builds up every month.' },
  { code: 'CL', name: 'Casual Leave', kind: 'standard', category: 'general', paid: true, allowHalfDay: true, color: '#2563eb', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '8', carryForwardMax: '0', description: 'Short leave for personal matters.' },
  { code: 'SL', name: 'Sick Leave', kind: 'standard', category: 'medical', paid: true, allowHalfDay: true, color: '#dc2626', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '8', carryForwardMax: '0', description: 'Leave when unwell.' },
];

/**
 * More templates the Super Workspace can start from. The numbers are common starting points, not any country's
 * statutory minimum. Half days are an option on each type rather than a type of their own.
 */
export const STANDARD_LEAVE_TYPES: readonly LeaveTemplate[] = [
  ...DEFAULT_LEAVE_TYPES,
  { code: 'EL', name: 'Earned Leave', kind: 'standard', category: 'general', paid: true, allowHalfDay: false, color: '#059669', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'monthly', annualEntitlement: '15', carryForwardMax: '30', description: 'Leave earned by working, credited monthly.' },
  { code: 'ML', name: 'Maternity Leave', kind: 'standard', category: 'statutory', paid: true, allowHalfDay: false, color: '#db2777', eligibleGender: 'female', countsCalendarDays: true, accrualMethod: 'annual_upfront', annualEntitlement: '182', carryForwardMax: '0', description: 'Leave before and after childbirth (calendar days).' },
  { code: 'PTL', name: 'Paternity Leave', kind: 'standard', category: 'family', paid: true, allowHalfDay: false, color: '#7c3aed', eligibleGender: 'male', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '5', carryForwardMax: '0', description: 'Leave for a new father.' },
  { code: 'BL', name: 'Bereavement Leave', kind: 'standard', category: 'family', paid: true, allowHalfDay: false, color: '#475569', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '3', carryForwardMax: '0', description: 'Leave after the death of a family member.' },
  { code: 'CO', name: 'Compensatory Off', kind: 'comp_off', category: 'special', paid: true, allowHalfDay: true, color: '#ea580c', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'granted', annualEntitlement: '0', carryForwardMax: '0', description: 'Time off for extra days worked, credited by HR.' },
  { code: 'OH', name: 'Optional Holiday', kind: 'optional_holiday', category: 'special', paid: true, allowHalfDay: false, color: '#ca8a04', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'annual_upfront', annualEntitlement: '2', carryForwardMax: '0', description: 'One of the optional holidays on the calendar.' },
  { code: 'WFH', name: 'Work From Home', kind: 'wfh', category: 'other', paid: true, allowHalfDay: true, color: '#0891b2', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'none', annualEntitlement: '0', carryForwardMax: '0', description: 'Working from home; counts as present.' },
  { code: 'LWP', name: 'Leave Without Pay', kind: 'standard', category: 'unpaid', paid: false, allowHalfDay: true, color: '#6b7280', eligibleGender: 'any', countsCalendarDays: false, accrualMethod: 'none', annualEntitlement: '0', carryForwardMax: '0', description: 'Unpaid leave.' },
];

/** A short reference for a leave application (LV-3F9A21), stable because it comes from the id. */
export function leaveRef(id: string): string {
  return `LV-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}
