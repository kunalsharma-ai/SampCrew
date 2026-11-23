import { z } from 'zod';
import { password } from './auth';
import { phoneNumber } from '../phone';
import { setAccessRequest } from './access';
import { email, name } from './common';

/** Calendar date as YYYY-MM-DD (no time zone; dates are local to the employee's entity). */
export const isoDate = z.iso.date('Use a date in YYYY-MM-DD format');

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'temporary'] as const;
export const EMPLOYEE_STATUSES = ['pre_boarding', 'probation', 'active', 'notice', 'exited'] as const;
export const GENDERS = ['female', 'male', 'non_binary', 'undisclosed'] as const;
export const EXIT_TYPES = ['resignation', 'termination', 'retirement', 'contract_end', 'other'] as const;

const optionalText = (max: number) => z.string().trim().max(max).optional();
const phone = phoneNumber;

export const LOGIN_MODES = ['none', 'invite', 'password'] as const;
export type LoginMode = (typeof LOGIN_MODES)[number];

/** An enrolment number on attendance machines. No device means the number is used on every machine in the workspace. */
export const attendanceEnrolment = z.object({
  deviceUserId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/, 'Use up to 32 letters, digits, - or _'),
  deviceId: z.uuid().nullable().default(null),
});

/** Attendance registration for an existing employee: replaces their usual shift and enrolment numbers. */
export const attendanceRegistrationInput = z.object({
  defaultShiftId: z.uuid().nullable(),
  enrolments: z.array(attendanceEnrolment).max(5),
});

/** Create a SampCrew login for an employee who has none. */
export const employeeLoginInput = z.object({ mode: z.enum(['invite', 'password']), initialPassword: password.optional(), access: setAccessRequest.optional() })
  .refine((v) => !v.initialPassword || v.mode === 'password', { message: 'A temporary password is only used when creating the login now', path: ['initialPassword'] });

/**
 * What a workspace admin can do to an employee's SampCrew login. Passwords are stored only as one-way hashes, so nobody can
 * read one back: a reset sets a new temporary password (shown once) that the person replaces at the next sign-in.
 * Lock stops sign-in to this workspace only; the account itself may also be used in other workspaces.
 */
export const EMPLOYEE_LOGIN_ACTIONS = ['reset_password', 'force_password_change', 'lock', 'unlock', 'sign_out'] as const;
export const employeeLoginActionInput = z.object({ action: z.enum(EMPLOYEE_LOGIN_ACTIONS), initialPassword: password.optional() })
  .refine((v) => !v.initialPassword || v.action === 'reset_password', { message: 'A temporary password is only used when resetting the password', path: ['initialPassword'] });

/** Employee photos: PNG, JPEG or WebP up to 5 MB. */
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export const designationInput = z.object({ name, code: z.string().trim().max(20).optional(), level: z.number().int().min(0).max(100).optional() });

/** Job placement shared by hiring, transfers and promotions. */
export const placementInput = z.object({
  legalEntityId: z.uuid(),
  departmentId: z.uuid().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
  designationId: z.uuid().nullable().optional(),
  managerEmployeeId: z.uuid().nullable().optional(),
  grade: z.string().trim().max(20).nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
});

/**
 * Age rules on the hire form. Nobody younger than MIN_WORKING_AGE on their joining date can be added; someone under
 * ADULT_AGE (a minor) can be, once HR confirms the law allows it and the paperwork (guardian consent, work permit)
 * is on file. The date of birth calendar is limited by the joining date, and the joining date by the date of birth.
 */
export const MIN_WORKING_AGE = 14;
export const ADULT_AGE = 18;
export const MAX_AGE = 100;

/** Moves a YYYY-MM-DD date by whole years; 29 February becomes 28 February in a non-leap year. */
export function addYears(date: string, years: number): string {
  const y = Number(date.slice(0, 4)) + years;
  const m = date.slice(5, 7);
  let d = date.slice(8, 10);
  if (m === '02' && d === '29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) d = '28';
  return `${String(y).padStart(4, '0')}-${m}-${d}`;
}

/** Whole years of age on a date. */
export function ageOn(dateOfBirth: string, on: string): number {
  const years = Number(on.slice(0, 4)) - Number(dateOfBirth.slice(0, 4));
  return on.slice(5) < dateOfBirth.slice(5) ? years - 1 : years;
}

/** The dates of birth the calendar offers for a joining date: at least MIN_WORKING_AGE, at most MAX_AGE on joining. */
export function dateOfBirthRange(dateOfJoining: string): { min: string; max: string } {
  return { min: addYears(dateOfJoining, -MAX_AGE), max: addYears(dateOfJoining, -MIN_WORKING_AGE) };
}

/** The earliest joining date for a date of birth (their MIN_WORKING_AGE birthday). */
export function earliestJoining(dateOfBirth: string): string {
  return addYears(dateOfBirth, MIN_WORKING_AGE);
}

/** Why a date of birth does not fit the joining date, or null. */
export function dateOfBirthError(dateOfBirth: string | null | undefined, dateOfJoining: string | null | undefined): string | null {
  if (!dateOfBirth || !dateOfJoining) return null;
  const age = ageOn(dateOfBirth, dateOfJoining);
  if (dateOfBirth >= dateOfJoining) return 'The date of birth must be before the joining date';
  if (age < MIN_WORKING_AGE) return `They would be ${age} on the joining date. Employees must be at least ${MIN_WORKING_AGE}`;
  if (age > MAX_AGE) return `They would be ${age} on the joining date. Check the year of birth`;
  return null;
}

/** True when someone with this date of birth is under ADULT_AGE on the joining date. */
export function isMinorOn(dateOfBirth: string | null | undefined, on: string | null | undefined): boolean {
  return !!dateOfBirth && !!on && ageOn(dateOfBirth, on) < ADULT_AGE;
}

/** How a hire joins SampCrew: a new joiner, or someone already working here whose record is being added. */
export const JOINED_AS = ['new_joiner', 'existing'] as const;
export type JoinedAs = (typeof JOINED_AS)[number];

/** An employee code typed by HR (an existing employee keeps the code they already have). */
export const employeeCodeInput = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/, 'Use letters, digits, -, _, / or .');

/** A leave balance carried over for an existing employee: what they have available today, in days. */
export const openingLeaveBalance = z.object({
  leaveTypeId: z.uuid(),
  days: z.union([z.number(), z.string()]).transform((v) => String(v).trim()).pipe(z.string().regex(/^-?\d{1,3}(\.\d{1,2})?$/, 'Use a number of days, such as 12 or 7.5')),
});

export const createEmployeeInput = placementInput
  .extend({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().max(80).default(''),
    preferredName: optionalText(80),
    workEmail: email.optional(),
    personalEmail: email.optional(),
    phone: phone.optional(),
    dateOfBirth: isoDate.optional(),
    gender: z.enum(GENDERS).optional(),
    dateOfJoining: isoDate,
    probationMonths: z.number().int().min(0).max(24).default(6),
    /** Instantiate this onboarding checklist (defaults to the workspace's default template). Null skips onboarding. */
    onboardingTemplateId: z.uuid().nullable().optional(),
    /** Send a SampCrew login invitation to the work email. Same as loginMode 'invite'. */
    inviteToCrew: z.boolean().default(false),
    /**
     * How this person signs in to SampCrew: no login yet, an emailed invitation, or a login created now with a temporary
     * password (typed by HR or generated) that they must change at first sign-in.
     */
    loginMode: z.enum(LOGIN_MODES).optional(),
    initialPassword: password.optional(),
    /** The workspace access the new login gets (Employee Workspace when left out). Needs a login. */
    access: setAccessRequest.optional(),
    /** Link to an existing workspace member instead of inviting. */
    membershipId: z.uuid().optional(),
    /** Attendance registration: their usual shift and the enrolment number(s) they punch with on attendance machines. */
    defaultShiftId: z.uuid().nullable().optional(),
    attendanceEnrolments: z.array(attendanceEnrolment).max(5).optional(),
    /** A designation typed in rather than picked: an existing one with this name is used, otherwise it is added. */
    designationName: z.string().trim().min(1).max(120).optional(),
    /** HR confirms a minor (under 18 on joining) may be employed and the guardian consent or permit is on file. */
    minorConfirmed: z.boolean().optional(),
    /** Someone already working here: their record is added with their real joining date, code and balances. */
    joinedAs: z.enum(JOINED_AS).default('new_joiner'),
    /** Keep the code they already have. Left out, the next code in the workspace's series is used. */
    employeeCode: employeeCodeInput.optional(),
    /** Existing employees only: when they were confirmed (left out, worked out from the probation length). */
    confirmationDate: isoDate.optional(),
    /** Existing employees only: the leave they have available today, per leave type. */
    openingLeaveBalances: z.array(openingLeaveBalance).max(30).optional(),
    /** Company assets handed to them now (laptop, ID card...). Each must be available; they are asked to acknowledge it. */
    assetIds: z.array(z.uuid()).max(20).optional(),
    /**
     * The HR Workspace that looks after them. Null: the company's central group (Super Workspace only). Left out, an
     * HR Workspace admin's own HR Workspace (when they run exactly one), or the central group.
     */
    hrWorkspaceId: z.uuid().nullable().optional(),
  })
  .refine((v) => !v.workEmail || !v.personalEmail || v.workEmail !== v.personalEmail, { message: 'Use their work email here, not their personal email', path: ['workEmail'] })
  .superRefine((v, ctx) => { const m = dateOfBirthError(v.dateOfBirth, v.dateOfJoining); if (m) ctx.addIssue({ code: 'custom', message: m, path: ['dateOfBirth'] }); })
  .refine((v) => !isMinorOn(v.dateOfBirth, v.dateOfJoining) || v.minorConfirmed === true, { message: `They are under ${ADULT_AGE} on the joining date: confirm they may be employed`, path: ['minorConfirmed'] })
  .refine((v) => !(v.designationId && v.designationName), { message: 'Pick a designation or type a new one, not both', path: ['designationName'] })
  .refine((v) => v.joinedAs === 'existing' || (!v.confirmationDate && !v.openingLeaveBalances?.length), { message: 'Confirmation dates and opening balances are for existing employees', path: ['joinedAs'] })
  .refine((v) => !v.confirmationDate || v.confirmationDate >= v.dateOfJoining, { message: 'The confirmation date cannot be before the joining date', path: ['confirmationDate'] })
  .refine((v) => new Set((v.openingLeaveBalances ?? []).map((b) => b.leaveTypeId)).size === (v.openingLeaveBalances ?? []).length, { message: 'Each leave type can have one opening balance', path: ['openingLeaveBalances'] })
  .refine((v) => !(v.inviteToCrew || v.loginMode === 'invite' || v.loginMode === 'password') || !!v.workEmail, { message: 'A work email is needed to give this person a SampCrew login', path: ['workEmail'] })
  .refine((v) => !((v.inviteToCrew || (v.loginMode && v.loginMode !== 'none')) && v.membershipId), { message: 'Choose either a new login or an existing member', path: ['membershipId'] })
  .refine((v) => !v.initialPassword || v.loginMode === 'password', { message: 'A temporary password is only used when creating the login now', path: ['initialPassword'] })
  .refine((v) => !v.access || v.access.level === 'employee' || v.inviteToCrew || v.loginMode === 'invite' || v.loginMode === 'password', { message: 'Workspace access needs a SampCrew login: choose an invitation or a temporary password', path: ['access'] });
export type CreateEmployeeInput = z.infer<typeof createEmployeeInput>;

/** Fields HR may change on the profile. Placement changes go through lifecycle actions so history is kept. */
export const updateEmployeeInput = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().max(80),
    preferredName: z.string().trim().max(80).nullable(),
    workEmail: email.nullable(),
    personalEmail: email.nullable(),
    phone: phone.nullable(),
    dateOfBirth: isoDate.nullable(),
    gender: z.enum(GENDERS).nullable(),
  })
  .partial()
  .strict();

/** Fields employees may change about themselves. */
export const updateOwnProfileInput = updateEmployeeInput.pick({ preferredName: true, personalEmail: true, phone: true });

export const sensitiveInput = z
  .object({
    bankName: z.string().trim().max(120).nullable(),
    bankAccount: z.string().trim().regex(/^[0-9A-Z ]{4,34}$/i, 'Account numbers use letters and digits only').nullable(),
    bankRouting: z.string().trim().regex(/^[0-9A-Z -]{4,15}$/i, 'Enter the IFSC, sort code or routing number').nullable(),
    taxId: z.string().trim().max(30).nullable(),
    nationalId: z.string().trim().max(30).nullable(),
  })
  .partial()
  .strict();

export const transferInput = placementInput.partial().extend({
  effectiveFrom: isoDate,
  reason: z.enum(['transfer', 'promotion', 'manager_change', 'correction', 'other']),
  note: optionalText(500),
});

export const confirmInput = z.object({ effectiveOn: isoDate, note: optionalText(500) });
export const extendProbationInput = z.object({ newEndDate: isoDate, note: optionalText(500) });
export const exitInput = z.object({
  exitType: z.enum(EXIT_TYPES),
  resignationDate: isoDate.optional(),
  lastWorkingDay: isoDate,
  reason: optionalText(1000),
});

export const employeeListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  q: z.string().trim().max(200).optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  departmentId: z.uuid().optional(),
  legalEntityId: z.uuid().optional(),
  /** People added or updated by one data import. */
  importId: z.uuid().optional(),
  includeExited: z.enum(['true', 'false']).optional(),
  sort: z.enum(['name', 'code', 'joined', 'department', 'location', 'status']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export const EMPLOYEE_SORTS = ['name', 'code', 'joined', 'department', 'location', 'status'] as const;

/** Columns the directory can show and export. */
export const EMPLOYEE_COLUMNS_CATALOGUE = ['name', 'code', 'designation', 'department', 'location', 'entity', 'manager', 'workEmail', 'type', 'joined', 'status', 'access', 'workspace'] as const;
export type EmployeeColumn = (typeof EMPLOYEE_COLUMNS_CATALOGUE)[number];
/** Exported when no columns are chosen (the columns before workspace access and assigned workspace were added). */
const DEFAULT_EXPORT_COLUMNS: EmployeeColumn[] = ['name', 'code', 'designation', 'department', 'location', 'entity', 'manager', 'workEmail', 'type', 'joined', 'status'];
export const employeeExportQuery = employeeListQuery.omit({ cursor: true, limit: true }).extend({
  columns: z.string().max(400).optional().transform((v, ctx) => {
    if (!v) return [...DEFAULT_EXPORT_COLUMNS];
    const cols = v.split(',').map((c) => c.trim()).filter(Boolean);
    const bad = cols.filter((c) => !(EMPLOYEE_COLUMNS_CATALOGUE as readonly string[]).includes(c));
    if (bad.length || !cols.length) { ctx.addIssue({ code: 'custom', message: `Unknown column ${bad.join(', ')}` }); return z.NEVER; }
    return cols as EmployeeColumn[];
  }),
});

/** A hire in progress, saved so it can be resumed later (files are attached only when the hire is completed). */
export const employeeDraftInput = z.object({
  step: z.number().int().min(0).max(10),
  data: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).refine((d) => Object.keys(d).length <= 60, 'Too many fields'),
}).strict();

export const duplicateCheckInput = z.object({
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  workEmail: z.string().trim().max(200).optional(),
  personalEmail: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  dateOfBirth: z.string().trim().max(10).optional(),
}).strict();

export const ONBOARDING_OWNERS = ['hr', 'manager', 'employee', 'it'] as const;
export const onboardingTemplateInput = z.object({
  name,
  description: optionalText(500),
  isDefault: z.boolean().default(false),
  tasks: z
    .array(z.object({ title: z.string().trim().min(1).max(200), description: optionalText(1000), owner: z.enum(ONBOARDING_OWNERS), dueOffsetDays: z.number().int().min(-60).max(180).default(0) }))
    .min(1)
    .max(60),
});
export const onboardingTaskUpdate = z.object({ status: z.enum(['open', 'done', 'skipped']) });

export const DOCUMENT_CATEGORIES = ['id_proof', 'address_proof', 'contract', 'offer_letter', 'policy', 'certificate', 'tax', 'other'] as const;
export const documentMetaInput = z.object({
  category: z.enum(DOCUMENT_CATEGORIES),
  title: z.string().trim().min(1).max(200),
  visibility: z.enum(['employee', 'hr_only']).default('employee'),
});
/** Uploads are limited to common document and image types, 10 MB each. */
export const DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] as const;
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const approvalDecisionInput = z.object({ comment: optionalText(1000) });

export { name as personName };
