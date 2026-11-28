import { z } from 'zod';

/**
 * Issue #89 (feedback of 26 November 2026, "Issues Identified in HR Admin and Employee Roles 3"): shared rules for
 * the automatic sign-out time, the company work email domain and the Add Employee form fields.
 */

// Automatic sign-out (point 4) ---------------------------------------------------------------------------------------

/** Minutes of inactivity after which everyone is signed out; 0 is off. Only the Super Workspace changes it. */
export const SESSION_IDLE_CHOICES = [0, 15, 30, 60, 120, 240, 480, 720] as const;
export const sessionPolicyInput = z.object({
  idleMinutes: z.number().int().refine((v) => (SESSION_IDLE_CHOICES as readonly number[]).includes(v), 'Choose one of the listed times'),
});
export type SessionPolicyInput = z.infer<typeof sessionPolicyInput>;
export function idleLabel(minutes: number | null | undefined): string {
  if (!minutes) return 'Never (stay signed in)';
  if (minutes < 60) return `After ${minutes} minutes of inactivity`;
  const h = minutes / 60;
  return `After ${h} ${h === 1 ? 'hour' : 'hours'} of inactivity`;
}

// Add Employee form: work email domain and field configuration (points 15, 17, 18) --------------------------------

/** A company email domain such as acme.com or mail.acme.co.in (no @, no scheme). */
export const EMAIL_DOMAIN = /^(?=.{3,190}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
export const emailDomainOf = (email: string | null | undefined) => (email ?? '').trim().toLowerCase().split('@')[1] ?? '';

/**
 * The built-in fields of the Add Employee form that the Super Workspace configures. Issue #91: no field is compulsory
 * by default and every field can be hidden or made optional, except the first name (`locked`): a person's record
 * cannot exist without a name. When the joining date or the legal entity is hidden or left empty, the form uses
 * today and the company's first legal entity (`fallback`), so an employee can still be created.
 */
export const EMPLOYEE_FORM_FIELDS = [
  { key: 'firstName', label: 'First name', step: 'Personal details', locked: true },
  { key: 'lastName', label: 'Last name', step: 'Personal details' },
  { key: 'preferredName', label: 'Preferred name', step: 'Personal details' },
  { key: 'workEmail', label: 'Work email', step: 'Personal details' },
  { key: 'personalEmail', label: 'Personal email', step: 'Personal details' },
  { key: 'phone', label: 'Phone', step: 'Personal details' },
  { key: 'dateOfBirth', label: 'Date of birth', step: 'Personal details' },
  { key: 'gender', label: 'Gender', step: 'Personal details' },
  { key: 'dateOfJoining', label: 'Date of joining', step: 'Employment', fallback: 'Today' },
  { key: 'legalEntityId', label: 'Legal entity', step: 'Employment', fallback: 'The first legal entity' },
  { key: 'employmentType', label: 'Employment type', step: 'Employment', fallback: 'Full time' },
  { key: 'designationId', label: 'Designation', step: 'Employment' },
  { key: 'grade', label: 'Grade', step: 'Employment' },
  { key: 'departmentId', label: 'Department', step: 'Department & reporting' },
  { key: 'locationId', label: 'Location', step: 'Department & reporting' },
  { key: 'managerEmployeeId', label: 'Reporting manager', step: 'Department & reporting' },
] as const satisfies readonly { key: string; label: string; step: string; locked?: boolean; noHide?: boolean; fallback?: string }[];
export type EmployeeFormFieldKey = (typeof EMPLOYEE_FORM_FIELDS)[number]['key'];
export const EMPLOYEE_FORM_FIELD_KEYS = EMPLOYEE_FORM_FIELDS.map((f) => f.key) as [EmployeeFormFieldKey, ...EmployeeFormFieldKey[]];

const fieldRule = z.object({
  visible: z.boolean().default(true),
  required: z.boolean().default(false),
  /** The label HR sees instead of the built-in one; null keeps the built-in label. */
  label: z.string().trim().max(60).nullable().default(null),
  /** A line of help under the field. */
  hint: z.string().trim().max(200).nullable().default(null),
  /** The example text inside an empty field (issue #91); null keeps the built-in one. */
  placeholder: z.string().trim().max(80).nullable().default(null),
});
export { fieldRule as formFieldRule };
export type FormFieldRule = z.infer<typeof fieldRule>;

export const employeeFormSettingsInput = z.object({
  /** The company's work email domains; the first one is the placeholder on Add Employee. */
  workEmailDomains: z.array(z.string().trim().toLowerCase().regex(EMAIL_DOMAIN, 'Use a domain such as acme.com, without @ or https://')).max(10).default([])
    .refine((d) => new Set(d).size === d.length, 'Each domain once'),
  /** Refuse work emails outside these domains (otherwise they are only suggested). */
  enforceWorkEmailDomain: z.boolean().default(false),
  fields: z.partialRecord(z.enum(EMPLOYEE_FORM_FIELD_KEYS), fieldRule).default({}),
}).refine((v) => !v.enforceWorkEmailDomain || v.workEmailDomains.length > 0, { message: 'Add at least one domain before requiring it', path: ['enforceWorkEmailDomain'] })
  .refine((v) => Object.entries(v.fields).every(([k, r]) => {
    const f = EMPLOYEE_FORM_FIELDS.find((x) => x.key === k) as { locked?: boolean; noHide?: boolean } | undefined;
    return !r || ((!f?.locked || (r.visible && r.required)) && (!f?.noHide || r.visible) && (r.visible || !r.required));
  }), { message: 'A locked field stays on the form and required, and a hidden field cannot be required', path: ['fields'] });
export type EmployeeFormSettingsInput = z.infer<typeof employeeFormSettingsInput>;

export interface EmployeeFormSettings extends EmployeeFormSettingsInput {
  /** Every built-in field with its rule as it applies now (defaults filled in). */
  resolved: { key: EmployeeFormFieldKey; label: string; builtInLabel: string; step: string; locked: boolean; noHide: boolean; visible: boolean; required: boolean; hint: string | null; placeholder: string | null; fallback: string | null }[];
  updatedAt: string | null;
  updatedBy: string | null;
  canChange: boolean;
}

export const DEFAULT_EMPLOYEE_FORM: EmployeeFormSettingsInput = { workEmailDomains: [], enforceWorkEmailDomain: false, fields: {} };

/** Each built-in field's rule with the defaults filled in; locked fields are always shown and required. */
export function resolveEmployeeForm(s: Pick<EmployeeFormSettingsInput, 'fields'>): EmployeeFormSettings['resolved'] {
  return EMPLOYEE_FORM_FIELDS.map((f) => {
    const locked = 'locked' in f && f.locked === true;
    const noHide = 'noHide' in f && f.noHide === true;
    const r = s.fields[f.key];
    const visible = locked || noHide || (r?.visible ?? true);
    const fallback = 'fallback' in f ? f.fallback : null;
    return { key: f.key, builtInLabel: f.label, label: r?.label || f.label, step: f.step, locked, noHide, visible, required: locked || (visible && (r?.required ?? false)), hint: r?.hint ?? null, placeholder: r?.placeholder ?? null, fallback };
  });
}

/** Why this work email is not accepted, or null. */
export function workEmailDomainError(email: string | null | undefined, s: Pick<EmployeeFormSettingsInput, 'workEmailDomains' | 'enforceWorkEmailDomain'>): string | null {
  if (!email || !s.enforceWorkEmailDomain || !s.workEmailDomains.length) return null;
  const d = emailDomainOf(email);
  return s.workEmailDomains.includes(d) ? null : `Use a company address ending in ${s.workEmailDomains.map((x) => `@${x}`).join(' or ')}`;
}

/** The required fields left empty, by key, with the message to show. */
export function missingEmployeeFields(values: Record<string, unknown>, s: Pick<EmployeeFormSettingsInput, 'fields'>, opts: { designationTyped?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of resolveEmployeeForm(s)) {
    if (!f.required || f.locked) continue;
    const v = values[f.key];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) out[f.key] = `${f.label} is required`;
  }
  if (opts.designationTyped) delete out.designationId;
  return out;
}

// Leave by employment status and comp-off (leave items 2 and 5) ----------------------------------------------------

const leaveDays = z.union([z.number(), z.string()]).transform((v) => String(v).trim()).pipe(z.string().regex(/^\d{1,3}(\.5|\.0|\.00|\.50)?$/, 'Use whole or half days, such as 12 or 7.5'));

/**
 * A leave type's rule by employment status: whether people on probation get it, and the days credited automatically
 * on the day they become permanent (confirmed), optionally for the rest of the year only (prorated by month).
 */
export const leaveStatusRuleInput = z.object({
  probation: z.enum(['no_leave', 'allowed']),
  onConfirmationDays: leaveDays.nullable().default(null),
  prorate: z.boolean().default(false),
}).strict();
export type LeaveStatusRuleInput = z.infer<typeof leaveStatusRuleInput>;

/** The days credited on confirmation: all of them, or the months left in the year counting the confirmation month. */
export function confirmationCredit(days: string, confirmedOn: string, prorate: boolean): string {
  const total = Number(days);
  if (!prorate) return total.toFixed(2);
  const month = Number(confirmedOn.slice(5, 7));
  const share = (total * (13 - month)) / 12;
  return (Math.round(share * 2) / 2).toFixed(2); // to the nearest half day
}

/** An employee asks for compensatory off for working on a weekly off or a holiday. */
export const compOffRequestInput = z.object({
  workDate: z.iso.date(),
  days: z.enum(['1', '0.5']).default('1'),
  reason: z.string().trim().min(5, 'Say what you worked on, in at least 5 characters').max(500),
}).strict();
export type CompOffRequestInput = z.infer<typeof compOffRequestInput>;
export const compOffDecisionInput = z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(500).optional() })
  .refine((v) => v.decision === 'approve' || (v.comment ?? '').length >= 3, { message: 'Give the reason for rejecting', path: ['comment'] });
/** How far back comp-off can be asked for. */
export const COMP_OFF_WINDOW_DAYS = 60;
