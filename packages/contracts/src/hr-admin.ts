import { z } from 'zod';
import { BOOLEAN_FEATURES, isCoreFeature } from './features';
import { roleGrant } from './schemas/access';

/**
 * HR Workspace Admin: one place for the workspace's own administrators to set module access, role permissions,
 * custom fields and module settings. SAMPLEDGE's Console still decides what the plan includes; the workspace can
 * only switch modules off (and back on) within it.
 */

const switchable = z.string().refine((k) => BOOLEAN_FEATURES.some((f) => f.key === k) && !isCoreFeature(k), 'Unknown module, or one that cannot be switched off');

export const workspaceModulesInput = z.object({
  changes: z.array(z.object({ key: switchable, enabled: z.boolean() }).strict()).min(1).max(100),
}).strict();

/** New grants for a role. System roles can be changed too (all but Workspace Owner) and reset to their defaults. */
export const roleGrantsInput = z.object({
  grants: z.array(roleGrant).max(300),
}).strict();

/** Roles that keep their defaults: the owner always has everything, so a workspace can never lock itself out. */
export const LOCKED_ROLE_KEYS = new Set(['super_workspace']);

// ------------------------------------------------------------------------------------------------------------
// Bulk import of existing employees
// ------------------------------------------------------------------------------------------------------------

/** The columns of the import template, in order. Leave balances: one column per leave type, "Leave: CL" and so on. */
export const EMPLOYEE_IMPORT_COLUMNS = [
  { key: 'employeeCode', label: 'Employee ID', required: true, example: 'FR-0142' },
  { key: 'firstName', label: 'First name', required: true, example: 'Asha' },
  { key: 'lastName', label: 'Last name', required: false, example: 'Verma' },
  { key: 'personalEmail', label: 'Personal email', required: false, example: 'asha.verma@gmail.example' },
  { key: 'workEmail', label: 'Work email', required: false, example: 'asha.verma@company.example' },
  { key: 'phone', label: 'Phone', required: false, example: '+91 98201 23456' },
  { key: 'department', label: 'Department', required: false, example: 'Research' },
  { key: 'designation', label: 'Designation', required: false, example: 'Research Analyst' },
  { key: 'location', label: 'Location', required: false, example: 'Gurugram' },
  { key: 'legalEntity', label: 'Legal entity', required: false, example: 'Company Pvt Ltd' },
  { key: 'dateOfBirth', label: 'Date of birth', required: false, example: '1994-07-21' },
  { key: 'dateOfJoining', label: 'Original date of joining', required: true, example: '2021-04-05' },
  { key: 'confirmationDate', label: 'Confirmation date', required: false, example: '2021-10-05' },
  { key: 'managerCode', label: 'Reporting manager employee ID', required: false, example: 'FR-0007' },
  { key: 'employmentType', label: 'Employment type', required: false, example: 'full_time' },
  { key: 'gender', label: 'Gender', required: false, example: 'female' },
  { key: 'assetCodes', label: 'Assets held (asset codes, separated by ;)', required: false, example: 'LAP-0012; IDC-0042' },
] as const;
export type EmployeeImportColumn = (typeof EMPLOYEE_IMPORT_COLUMNS)[number]['key'];
export const LEAVE_COLUMN_PREFIX = 'Leave: ';

export const IMPORT_MAX_ROWS = 2000;

export interface ImportRowResult {
  row: number;
  employeeCode: string | null;
  name: string | null;
  status: 'ok' | 'error' | 'duplicate' | 'created';
  errors: { column: string; message: string }[];
  warnings: string[];
  employeeId?: string;
}

export interface ImportResult {
  dryRun: boolean;
  rows: ImportRowResult[];
  summary: { total: number; ok: number; errors: number; duplicates: number; created: number };
  /** Designations the import adds (they do not exist yet). */
  creates: { designations: string[] };
}

/** Header text to column key: accepts the template labels, the keys themselves, and "Leave: CODE". */
export function importHeaderKey(header: string): EmployeeImportColumn | `leave:${string}` | null {
  const h = header.trim().replace(/\s*\*$/, '');
  if (h.toLowerCase().startsWith(LEAVE_COLUMN_PREFIX.toLowerCase())) return `leave:${h.slice(LEAVE_COLUMN_PREFIX.length).trim().toUpperCase()}`;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const c = EMPLOYEE_IMPORT_COLUMNS.find((x) => norm(x.label) === norm(h) || norm(x.key) === norm(h));
  return c?.key ?? null;
}

/** Reads a date as typed in a spreadsheet: 2021-04-05, 05/04/2021 (day first), 5-Apr-2021, or an Excel serial number. */
export function parseSheetDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{4})$/.exec(s))) {
    const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(r[2]!.slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    [d, m, y] = [Number(r[1]), mi + 1, Number(r[3])];
  } else if (/^\d{4,5}(\.0+)?$/.test(s)) {
    // Excel serial date (1900 system).
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return dt.toISOString().slice(0, 10);
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
