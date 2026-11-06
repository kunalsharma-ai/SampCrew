import { z } from 'zod';
import { password } from './auth';
import { email, name } from './common';

/** Calendar date as YYYY-MM-DD (no time zone; dates are local to the employee's entity). */
export const isoDate = z.iso.date('Use a date in YYYY-MM-DD format');

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'temporary'] as const;
export const EMPLOYEE_STATUSES = ['pre_boarding', 'probation', 'active', 'notice', 'exited'] as const;
export const GENDERS = ['female', 'male', 'non_binary', 'undisclosed'] as const;
export const EXIT_TYPES = ['resignation', 'termination', 'retirement', 'contract_end', 'other'] as const;

const optionalText = (max: number) => z.string().trim().max(max).optional();
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'Enter a phone number with digits, spaces or +');

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

/** Create a CREW login for an employee who has none. */
export const employeeLoginInput = z.object({ mode: z.enum(['invite', 'password']), initialPassword: password.optional() })
  .refine((v) => !v.initialPassword || v.mode === 'password', { message: 'A temporary password is only used when creating the login now', path: ['initialPassword'] });

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
    /** Send a CREW login invitation to the work email. Same as loginMode 'invite'. */
    inviteToCrew: z.boolean().default(false),
    /**
     * How this person signs in to CREW: no login yet, an emailed invitation, or a login created now with a temporary
     * password (typed by HR or generated) that they must change at first sign-in.
     */
    loginMode: z.enum(LOGIN_MODES).optional(),
    initialPassword: password.optional(),
    /** Link to an existing workspace member instead of inviting. */
    membershipId: z.uuid().optional(),
    /** Attendance registration: their usual shift and the enrolment number(s) they punch with on attendance machines. */
    defaultShiftId: z.uuid().nullable().optional(),
    attendanceEnrolments: z.array(attendanceEnrolment).max(5).optional(),
  })
  .refine((v) => !(v.inviteToCrew || v.loginMode === 'invite' || v.loginMode === 'password') || !!v.workEmail, { message: 'A work email is needed to give this person a CREW login', path: ['workEmail'] })
  .refine((v) => !((v.inviteToCrew || (v.loginMode && v.loginMode !== 'none')) && v.membershipId), { message: 'Choose either a new login or an existing member', path: ['membershipId'] })
  .refine((v) => !v.initialPassword || v.loginMode === 'password', { message: 'A temporary password is only used when creating the login now', path: ['initialPassword'] });
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
  includeExited: z.enum(['true', 'false']).optional(),
  sort: z.enum(['name', 'code', 'joined', 'department', 'location', 'status']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
export const EMPLOYEE_SORTS = ['name', 'code', 'joined', 'department', 'location', 'status'] as const;

/** Columns the directory can show and export. */
export const EMPLOYEE_COLUMNS_CATALOGUE = ['name', 'code', 'designation', 'department', 'location', 'entity', 'manager', 'workEmail', 'type', 'joined', 'status'] as const;
export type EmployeeColumn = (typeof EMPLOYEE_COLUMNS_CATALOGUE)[number];
export const employeeExportQuery = employeeListQuery.omit({ cursor: true, limit: true }).extend({
  columns: z.string().max(400).optional().transform((v, ctx) => {
    if (!v) return [...EMPLOYEE_COLUMNS_CATALOGUE];
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
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const approvalDecisionInput = z.object({ comment: optionalText(1000) });

export { name as personName };
