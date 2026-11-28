import { z } from 'zod';
import { CUSTOM_FIELD_ENTITY_LABEL, type CustomFieldDefinition, type CustomFieldEntity } from './custom-fields';
import { EMPLOYEE_FORM_FIELDS, formFieldRule, type FormFieldRule } from './feedback-89';

/**
 * Form management (issue #91): one place in the Super Workspace to set up every form in SampCrew. Each form has its
 * built-in fields (show or hide, required or optional, label, placeholder, help line) and the custom fields added to
 * it (any type, removable). HR Workspaces and Employee Workspaces only see the forms as the Super Workspace set them.
 *
 * The Add Employee form keeps its own stored settings (work email domains as well as fields); every other form is
 * stored as `form:<key>` in form_settings. Custom fields are the custom_fields rows of the form's record type.
 */

export const FORM_KEYS = ['add_employee', 'employee_profile', 'leave_request', 'asset', 'bgv_case', 'candidate', 'client'] as const;
export type FormKey = (typeof FORM_KEYS)[number];

export interface BuiltInFormField {
  key: string;
  label: string;
  /** The group the field sits in on the form (a wizard step or a card). */
  section: string;
  /** Always shown and required: only a person's first name. */
  locked?: boolean;
  /** What the form uses when the field is hidden or left empty. */
  fallback?: string;
}

export interface FormDefinition {
  key: FormKey;
  label: string;
  /** Where people meet this form, in plain words. */
  where: string;
  /** Who fills it in. */
  usedBy: string;
  /** The record type its custom fields belong to. */
  entity: CustomFieldEntity;
  builtIn: readonly BuiltInFormField[];
}

/** The built-in fields of an employee's profile (HR's Edit details and the person's own profile). */
export const EMPLOYEE_PROFILE_FIELDS = [
  { key: 'firstName', label: 'First name', section: 'Personal details', locked: true },
  { key: 'lastName', label: 'Last name', section: 'Personal details' },
  { key: 'preferredName', label: 'Preferred name', section: 'Personal details' },
  { key: 'workEmail', label: 'Work email', section: 'Personal details' },
  { key: 'personalEmail', label: 'Personal email', section: 'Personal details' },
  { key: 'phone', label: 'Phone', section: 'Personal details' },
  { key: 'dateOfBirth', label: 'Date of birth', section: 'Personal details' },
  { key: 'gender', label: 'Gender', section: 'Personal details' },
] as const satisfies readonly BuiltInFormField[];

/** The built-in fields of a leave request besides the leave type and dates, which are the request itself. */
export const LEAVE_REQUEST_FIELDS = [
  { key: 'reason', label: 'Reason', section: 'Request' },
] as const satisfies readonly BuiltInFormField[];

export const FORMS: readonly FormDefinition[] = [
  {
    key: 'add_employee', label: 'Add Employee', entity: 'employee', usedBy: 'HR Workspace and Super Workspace',
    where: 'The Add Employee form, and employee imports for the work email rule.',
    builtIn: EMPLOYEE_FORM_FIELDS.map((f) => ({ key: f.key, label: f.label, section: f.step, ...('locked' in f ? { locked: true } : {}), ...('fallback' in f ? { fallback: f.fallback } : {}) })),
  },
  {
    key: 'employee_profile', label: 'Employee profile', entity: 'employee', usedBy: 'HR Workspace, and the person on their own profile',
    where: 'Edit details on an employee page and My profile. Custom employee fields show on Add Employee too.',
    builtIn: EMPLOYEE_PROFILE_FIELDS,
  },
  {
    key: 'leave_request', label: 'Leave request', entity: 'leave_request', usedBy: 'Employee Workspace, and HR applying for someone',
    where: 'Apply for leave and Change leave request. The leave type and dates are always asked.',
    builtIn: LEAVE_REQUEST_FIELDS,
  },
  { key: 'asset', label: CUSTOM_FIELD_ENTITY_LABEL.asset, entity: 'asset', usedBy: 'HR Workspace', where: 'Each asset record.', builtIn: [] },
  { key: 'bgv_case', label: CUSTOM_FIELD_ENTITY_LABEL.bgv_case, entity: 'bgv_case', usedBy: 'HR Workspace and verification agencies', where: 'Each background verification case.', builtIn: [] },
  { key: 'candidate', label: CUSTOM_FIELD_ENTITY_LABEL.candidate, entity: 'candidate', usedBy: 'HR Workspace (recruiters)', where: 'Each candidate in Recruitment and the Candidate CRM.', builtIn: [] },
  { key: 'client', label: CUSTOM_FIELD_ENTITY_LABEL.client, entity: 'client', usedBy: 'HR Workspace (staffing)', where: 'Each client on Staffing bids.', builtIn: [] },
];

export const formDefinition = (key: string): FormDefinition | undefined => FORMS.find((f) => f.key === key);

/** Which form a record type's custom fields are managed under (employee fields: the Employee profile form). */
export const FORM_OF_ENTITY: Record<CustomFieldEntity, FormKey> = {
  employee: 'employee_profile', asset: 'asset', bgv_case: 'bgv_case', candidate: 'candidate', leave_request: 'leave_request', client: 'client',
};

/** The rules of a form other than Add Employee (which has its own settings, with the work email domains). */
export const formSettingsInput = z.object({
  fields: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), formFieldRule).default({}),
}).strict();
export type FormSettingsInput = z.infer<typeof formSettingsInput>;

export interface ResolvedFormField {
  key: string;
  builtInLabel: string;
  label: string;
  section: string;
  locked: boolean;
  visible: boolean;
  required: boolean;
  hint: string | null;
  placeholder: string | null;
  fallback: string | null;
}

/** Each built-in field's rule with defaults filled in: shown, optional, the built-in label. Unknown keys are dropped. */
export function resolveForm(def: Pick<FormDefinition, 'builtIn'>, fields: Record<string, Partial<FormFieldRule> | undefined>): ResolvedFormField[] {
  return def.builtIn.map((f) => {
    const r = fields[f.key];
    const locked = f.locked === true;
    const visible = locked || (r?.visible ?? true);
    return {
      key: f.key, builtInLabel: f.label, label: r?.label || f.label, section: f.section, locked, visible,
      required: locked || (visible && (r?.required ?? false)), hint: r?.hint ?? null, placeholder: r?.placeholder ?? null, fallback: f.fallback ?? null,
    };
  });
}

/** Why these rules cannot be saved for this form, or null. */
export function formRulesError(def: Pick<FormDefinition, 'builtIn'>, fields: Record<string, FormFieldRule | undefined>): string | null {
  for (const [k, r] of Object.entries(fields)) {
    const f = def.builtIn.find((x) => x.key === k);
    if (!f) return `This form has no field ${k}`;
    if (!r) continue;
    if (f.locked && (!r.visible || !r.required)) return `${f.label} is always on the form and required`;
    if (!r.visible && r.required) return `${r.label || f.label} cannot be hidden and required`;
  }
  return null;
}

/** The fields of a form left empty that its rules require, by key. */
export function missingFormFields(resolved: ResolvedFormField[], values: Record<string, unknown>, only?: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of resolved) {
    if (!f.required || (only && !only.includes(f.key))) continue;
    const v = values[f.key];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) out[f.key] = `${f.label} is required`;
  }
  return out;
}

/** A form as the Form management page and the forms themselves read it. */
export interface FormView {
  form: FormDefinition;
  resolved: ResolvedFormField[];
  /** The custom fields of the form's record type (archived ones only for the Super Workspace). */
  customFields: (CustomFieldDefinition & { valueCount?: number })[];
  /** Add Employee only: the company's work email domains and whether they are enforced. */
  workEmailDomains?: string[];
  enforceWorkEmailDomain?: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Only the Super Workspace changes forms. */
  canChange: boolean;
}

export interface FormSummary {
  key: FormKey;
  label: string;
  where: string;
  usedBy: string;
  builtInFields: number;
  hiddenFields: number;
  requiredFields: number;
  customFields: number;
  updatedAt: string | null;
}
