import { z } from 'zod';
import { checkPhone } from './phone';

/**
 * Custom fields: HR adds its own fields to the forms of a module (employee profile, assets, background checks,
 * candidates, leave requests). Definitions are versioned only by the audit trail; a field is never deleted while it
 * holds data. Archiving hides it from forms and keeps every stored value. Changing a field's type keeps the old values
 * too; values that no longer fit are shown as they were and must be corrected before the record is saved again.
 */

export const CUSTOM_FIELD_ENTITIES = ['employee', 'asset', 'bgv_case', 'candidate', 'leave_request'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];
export const CUSTOM_FIELD_ENTITY_LABEL: Record<CustomFieldEntity, string> = {
  employee: 'Employee profile',
  asset: 'Assets',
  bgv_case: 'Background verification',
  candidate: 'Candidates (recruitment)',
  leave_request: 'Leave requests',
};

export const CUSTOM_FIELD_TYPES = [
  'short_text', 'long_text', 'number', 'date', 'datetime', 'dropdown', 'multi_select', 'radio', 'checkbox', 'email', 'phone', 'file', 'currency', 'url',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CUSTOM_FIELD_TYPE_LABEL: Record<CustomFieldType, string> = {
  short_text: 'Short text', long_text: 'Long text', number: 'Number', date: 'Date', datetime: 'Date and time', dropdown: 'Dropdown',
  multi_select: 'Multi-select', radio: 'Radio buttons', checkbox: 'Checkbox', email: 'Email', phone: 'Phone number', file: 'File upload',
  currency: 'Currency', url: 'URL',
};
export const OPTION_TYPES: readonly CustomFieldType[] = ['dropdown', 'multi_select', 'radio'];

export interface CustomFieldOption {
  value: string;
  label: string;
  /** Hidden from new choices; records that hold it keep it. */
  archived?: boolean;
}

export interface CustomFieldDefinition {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  helpText: string | null;
  required: boolean;
  defaultValue: unknown;
  options: CustomFieldOption[];
  position: number;
  section: string | null;
  enabled: boolean;
  archivedAt: string | null;
  /** Role keys that may see it; empty: everyone who can see the record. */
  viewRoles: string[];
  /** Role keys that may change it; empty: everyone who can change the record. */
  editRoles: string[];
  /** Employee profile fields only: the employee can fill it in on their own profile. */
  employeeEditable: boolean;
  config: { min?: number; max?: number; maxLength?: number; currency?: string };
}

const option = z.object({
  value: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  archived: z.boolean().optional(),
}).strict();

const roleKeys = z.array(z.string().regex(/^[a-z][a-z0-9_]{2,40}$/)).max(50).transform((a) => [...new Set(a)]);

const definitionBase = z.object({
  label: z.string().trim().min(1).max(120),
  type: z.enum(CUSTOM_FIELD_TYPES),
  helpText: z.string().trim().max(300).nullable().optional(),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  options: z.array(option).max(200).default([]),
  section: z.string().trim().max(80).nullable().optional(),
  enabled: z.boolean().default(true),
  viewRoles: roleKeys.default([]),
  editRoles: roleKeys.default([]),
  employeeEditable: z.boolean().default(false),
  config: z.object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    maxLength: z.number().int().min(1).max(10000).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  }).strict().default({}),
});

const optionsRule = (v: { type: CustomFieldType; options: { value: string }[] }) =>
  !OPTION_TYPES.includes(v.type) || v.options.length > 0;
const uniqueOptions = (v: { options: { value: string }[] }) => new Set(v.options.map((o) => o.value)).size === v.options.length;

export const customFieldInput = definitionBase.extend({
  entity: z.enum(CUSTOM_FIELD_ENTITIES),
  /** Left out: made from the label. It never changes afterwards, so integrations and exports keep working. */
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Lowercase letters, numbers and underscores').optional(),
}).strict()
  .refine(optionsRule, { message: 'Add at least one option', path: ['options'] })
  .refine(uniqueOptions, { message: 'Two options have the same value', path: ['options'] });

export const customFieldUpdate = definitionBase.partial().strict()
  .refine((v) => !v.type || !v.options || optionsRule({ type: v.type, options: v.options }), { message: 'Add at least one option', path: ['options'] })
  .refine((v) => !v.options || uniqueOptions({ options: v.options }), { message: 'Two options have the same value', path: ['options'] });

export const customFieldReorder = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITIES),
  ids: z.array(z.uuid()).min(1).max(500),
}).strict();

export const customFieldValuesInput = z.object({
  values: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.unknown()),
}).strict();

export function fieldKeyFromLabel(label: string): string {
  const k = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(k) ? k : `f_${k}`.slice(0, 40);
}

export type FieldCheck = { ok: true; value: unknown } | { ok: false; error: string };

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Checks and normalises one value against its field. Empty is null (or false for a checkbox). Used by the API
 * before saving and by the forms for instant feedback.
 */
export function checkFieldValue(def: Pick<CustomFieldDefinition, 'type' | 'required' | 'options' | 'config' | 'label'>, raw: unknown, opts: { country?: string | null; allowedArchived?: unknown } = {}): FieldCheck {
  if (def.type === 'checkbox') {
    const v = raw === true || raw === 'true' || raw === 'on' || raw === 1;
    if (def.required && !v) return { ok: false, error: `${def.label} must be ticked` };
    return { ok: true, value: v };
  }
  if (isEmpty(raw)) return def.required ? { ok: false, error: `${def.label} is required` } : { ok: true, value: null };
  const str = typeof raw === 'string' ? raw.trim() : raw;
  const live = new Set(def.options.filter((o) => !o.archived).map((o) => o.value));
  const kept = (v: string) => live.has(v) || (opts.allowedArchived !== undefined && (Array.isArray(opts.allowedArchived) ? opts.allowedArchived.includes(v) : opts.allowedArchived === v));
  const max = def.config.maxLength;
  switch (def.type) {
    case 'short_text':
    case 'long_text': {
      if (typeof str !== 'string') return { ok: false, error: 'Enter text' };
      const limit = max ?? (def.type === 'short_text' ? 200 : 5000);
      if (str.length > limit) return { ok: false, error: `At most ${limit} characters` };
      return { ok: true, value: str };
    }
    case 'number':
    case 'currency': {
      const n = typeof str === 'number' ? str : Number(String(str).replace(/,/g, ''));
      if (!Number.isFinite(n)) return { ok: false, error: 'Enter a number' };
      if (def.type === 'currency' && Math.round(n * 100) !== n * 100) return { ok: false, error: 'At most 2 decimals' };
      if (def.config.min !== undefined && n < def.config.min) return { ok: false, error: `At least ${def.config.min}` };
      if (def.config.max !== undefined && n > def.config.max) return { ok: false, error: `At most ${def.config.max}` };
      return { ok: true, value: n };
    }
    case 'date':
      if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(Date.parse(`${str}T00:00:00Z`))) return { ok: false, error: 'Enter a date' };
      return { ok: true, value: str };
    case 'datetime': {
      if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str) || Number.isNaN(Date.parse(str))) return { ok: false, error: 'Enter a date and time' };
      return { ok: true, value: str.slice(0, 16) };
    }
    case 'dropdown':
    case 'radio':
      if (typeof str !== 'string' || !kept(str)) return { ok: false, error: 'Choose one of the options' };
      return { ok: true, value: str };
    case 'multi_select': {
      const arr = Array.isArray(str) ? str : [str];
      if (!arr.every((v) => typeof v === 'string' && kept(v))) return { ok: false, error: 'Choose from the options' };
      return { ok: true, value: [...new Set(arr as string[])] };
    }
    case 'email':
      if (typeof str !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str) || str.length > 254) return { ok: false, error: 'Enter an email address' };
      return { ok: true, value: str.toLowerCase() };
    case 'phone': {
      if (typeof str !== 'string') return { ok: false, error: 'Enter a phone number' };
      const p = checkPhone(str, opts.country);
      return p.ok ? { ok: true, value: p.value } : { ok: false, error: p.message };
    }
    case 'url': {
      if (typeof str !== 'string') return { ok: false, error: 'Enter an address' };
      try {
        const u = new URL(str);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        return { ok: true, value: u.toString() };
      } catch {
        return { ok: false, error: 'Enter a full address, for example https://example.com' };
      }
    }
    case 'file': {
      const f = str as { fileId?: unknown; fileName?: unknown };
      if (typeof f !== 'object' || typeof f.fileId !== 'string' || typeof f.fileName !== 'string') return { ok: false, error: 'Upload a file' };
      return { ok: true, value: { fileId: f.fileId, fileName: f.fileName } };
    }
  }
}

/** A stored value as text, for lists, exports and the profile view. */
export function fieldValueText(def: Pick<CustomFieldDefinition, 'type' | 'options' | 'config'>, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const label = (x: unknown) => def.options.find((o) => o.value === x)?.label ?? String(x);
  switch (def.type) {
    case 'checkbox': return v ? 'Yes' : 'No';
    case 'dropdown': case 'radio': return label(v);
    case 'multi_select': return Array.isArray(v) ? v.map(label).join(', ') : label(v);
    case 'currency': return `${def.config.currency ? `${def.config.currency} ` : ''}${typeof v === 'number' ? v.toFixed(2) : String(v)}`;
    case 'file': return (v as { fileName?: string }).fileName ?? 'File';
    case 'datetime': return String(v).replace('T', ' ');
    default: return Array.isArray(v) ? v.join(', ') : String(v);
  }
}
