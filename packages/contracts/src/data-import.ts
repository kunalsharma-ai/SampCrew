import { z } from 'zod';
import { CUSTOM_FIELD_TYPES } from './custom-fields';
import { BLOOD_GROUPS, MARITAL_STATUSES } from './profile';
import { CANDIDATE_SOURCES } from './schemas/recruitment';
import { EMPLOYMENT_TYPES, GENDERS } from './schemas/people';
import { VALUE_LISTS } from './master-data';

/**
 * Data import: Upload (Excel or CSV) > Map columns > Validate > Preview > Import > Report. Each kind of record has an
 * adapter in the API that writes through the same service as the record's own form, so an imported employee,
 * candidate or client is an ordinary SampCrew record from the first second. Rows are committed one at a time, each in
 * its own transaction (the record, its custom fields and its links together, or nothing), so a failed row never leaves
 * half a record behind and a stopped import can carry on where it stopped.
 */

export const IMPORT_TYPES = ['employees', 'candidates', 'clients', 'contacts', 'departments', 'job_titles', 'master_values'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export interface ImportTypeInfo {
  key: ImportType;
  label: string;
  description: string;
  /** The permission the person needs on top of imports:run (checked again on every row by the record's service). */
  permission: string;
  /** The module the workspace must have. */
  feature: string | null;
  /** Kind of record for custom fields, when the record has them. */
  customFieldEntity: 'employee' | 'candidate' | 'client' | null;
  /** Which fields find an existing record, in the order offered. */
  matchFields: string[];
  /** Fields whose value must be unique, so "create a new record" is refused when they match. */
  uniqueFields: string[];
}

export const IMPORT_TYPE_INFO: Record<ImportType, ImportTypeInfo> = {
  employees: { key: 'employees', label: 'Employees', description: 'People already working here, with their job details, profile, leave balances and assets.', permission: 'employees:create', feature: null, customFieldEntity: 'employee', matchFields: ['employeeCode', 'workEmail', 'personalEmail', 'phone'], uniqueFields: ['employeeCode', 'workEmail'] },
  candidates: { key: 'candidates', label: 'Candidates', description: 'Candidates from another ATS or a spreadsheet, optionally added to an open job.', permission: 'candidates:manage', feature: 'recruitment', customFieldEntity: 'candidate', matchFields: ['email', 'phone'], uniqueFields: ['email'] },
  clients: { key: 'clients', label: 'Clients', description: 'Client companies for staffing bids, with their main contact.', permission: 'bids:manage', feature: 'staffing_bids', customFieldEntity: 'client', matchFields: ['name'], uniqueFields: ['name'] },
  contacts: { key: 'contacts', label: 'Contacts', description: 'People at your clients: each contact is linked to a client by its name.', permission: 'bids:manage', feature: 'staffing_bids', customFieldEntity: null, matchFields: ['email', 'phone'], uniqueFields: ['email'] },
  departments: { key: 'departments', label: 'Departments', description: 'Your department structure, with codes and parent departments.', permission: 'org:manage', feature: null, customFieldEntity: null, matchFields: ['name', 'code'], uniqueFields: ['code'] },
  job_titles: { key: 'job_titles', label: 'Job titles', description: 'Designations with their seniority level and function.', permission: 'masterdata:manage', feature: null, customFieldEntity: null, matchFields: ['name'], uniqueFields: ['name'] },
  master_values: { key: 'master_values', label: 'Other lists', description: 'Job roles, skills, education, industries, seniority levels or candidate sources.', permission: 'masterdata:manage', feature: null, customFieldEntity: null, matchFields: ['label'], uniqueFields: ['label'] },
};

export const IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const IMPORT_JOB_MAX_ROWS = 20_000;
export const IMPORT_JOB_MAX_COLUMNS = 200;

export type ImportFieldKind = 'text' | 'email' | 'phone' | 'date' | 'number' | 'choice' | 'list' | 'bool' | 'url';

export interface ImportField {
  key: string;
  label: string;
  group: string;
  kind: ImportFieldKind;
  required?: boolean;
  /** Allowed values (a choice); matched without regard to case, spaces or punctuation. */
  choices?: readonly string[];
  /** Other names the column often has in other systems. */
  synonyms?: readonly string[];
  example?: string;
  help?: string;
  /** A custom field: its definition id. */
  customFieldId?: string;
  /** Master data list whose values it takes ("Other" values are added to the list). */
  masterList?: string;
}

const P = 'Personal';
const E = 'Employment';
const A = 'Address';
const C = 'Emergency contact';

export const EMPLOYEE_IMPORT_FIELDS: ImportField[] = [
  { key: 'employeeCode', label: 'Employee ID', group: E, kind: 'text', synonyms: ['emp id', 'employee code', 'emp code', 'emp no', 'employee number', 'staff id', 'staff number', 'personnel number', 'id'], example: 'FR-0142', help: 'Left empty, the next number in your series is given.' },
  { key: 'fullName', label: 'Full name', group: P, kind: 'text', synonyms: ['name', 'employee name', 'emp name', 'staff name'], example: 'Asha Verma', help: 'Used for the first and last name when those columns are not in the file.' },
  { key: 'firstName', label: 'First name', group: P, kind: 'text', synonyms: ['given name', 'employee first name', 'fname', 'first'], example: 'Asha' },
  { key: 'lastName', label: 'Last name', group: P, kind: 'text', synonyms: ['surname', 'family name', 'lname', 'last'], example: 'Verma' },
  { key: 'preferredName', label: 'Preferred name', group: P, kind: 'text', synonyms: ['nickname', 'known as', 'display name'] },
  { key: 'workEmail', label: 'Work email', group: E, kind: 'email', synonyms: ['email', 'email id', 'email address', 'official email', 'office email', 'company email', 'mail'], example: 'asha.verma@company.example' },
  { key: 'personalEmail', label: 'Personal email', group: P, kind: 'email', synonyms: ['private email', 'personal mail', 'home email', 'alternate email'], example: 'asha.verma@gmail.example' },
  { key: 'phone', label: 'Phone number', group: P, kind: 'phone', synonyms: ['phone', 'mobile', 'mobile number', 'mobile no', 'contact number', 'contact no', 'cell', 'cell phone', 'telephone', 'phone no'], example: '+91 98201 23456' },
  { key: 'dateOfBirth', label: 'Date of birth', group: P, kind: 'date', synonyms: ['dob', 'birth date', 'birthday', 'birthdate'], example: '1994-07-21' },
  { key: 'gender', label: 'Gender', group: P, kind: 'choice', choices: GENDERS, synonyms: ['sex'], example: 'female' },
  { key: 'nationality', label: 'Nationality', group: P, kind: 'text', synonyms: ['citizenship'] },
  { key: 'maritalStatus', label: 'Marital status', group: P, kind: 'choice', choices: MARITAL_STATUSES, synonyms: ['marital'] },
  { key: 'bloodGroup', label: 'Blood group', group: P, kind: 'choice', choices: BLOOD_GROUPS, synonyms: ['blood type'] },
  { key: 'addressLine1', label: 'Address', group: A, kind: 'text', synonyms: ['address line 1', 'street', 'current address', 'residential address', 'address 1'] },
  { key: 'addressLine2', label: 'Address line 2', group: A, kind: 'text', synonyms: ['address 2', 'locality', 'area'] },
  { key: 'city', label: 'City', group: A, kind: 'text', synonyms: ['town'] },
  { key: 'state', label: 'State', group: A, kind: 'text', synonyms: ['province', 'region', 'county'] },
  { key: 'postalCode', label: 'Postal code', group: A, kind: 'text', synonyms: ['pin', 'pincode', 'pin code', 'zip', 'zip code', 'postcode'] },
  { key: 'country', label: 'Country', group: A, kind: 'text' },
  { key: 'emergencyName', label: 'Emergency contact name', group: C, kind: 'text', synonyms: ['emergency contact', 'emergency name', 'next of kin'] },
  { key: 'emergencyRelationship', label: 'Emergency contact relationship', group: C, kind: 'text', synonyms: ['relationship', 'emergency relation'] },
  { key: 'emergencyPhone', label: 'Emergency contact phone', group: C, kind: 'phone', synonyms: ['emergency phone', 'emergency number', 'emergency mobile'] },
  { key: 'department', label: 'Department', group: E, kind: 'text', masterList: 'department', synonyms: ['dept', 'division', 'function', 'team'], example: 'Human Resources' },
  { key: 'designation', label: 'Job title', group: E, kind: 'text', masterList: 'job_title', synonyms: ['designation', 'title', 'position', 'role', 'job role', 'job title'], example: 'HR Executive', help: 'A title that does not exist yet is added to your job titles.' },
  { key: 'location', label: 'Work location', group: E, kind: 'text', masterList: 'location', synonyms: ['location', 'office', 'branch', 'work location', 'base location', 'site'], example: 'Gurugram' },
  { key: 'legalEntity', label: 'Legal entity', group: E, kind: 'text', synonyms: ['company', 'entity', 'employer', 'company name'], help: 'Needed when you have more than one.' },
  { key: 'hrWorkspace', label: 'HR Workspace', group: E, kind: 'text', synonyms: ['hr team', 'hr group', 'business unit hr'], help: 'Super Workspace only. Left empty, everyone goes where the import settings say.' },
  { key: 'dateOfJoining', label: 'Date of joining', group: E, kind: 'date', required: true, synonyms: ['joining date', 'doj', 'date joined', 'start date', 'hire date', 'original date of joining', 'joined on'], example: '2021-04-05' },
  { key: 'confirmationDate', label: 'Confirmation date', group: E, kind: 'date', synonyms: ['date of confirmation', 'confirmed on'] },
  { key: 'managerCode', label: 'Reporting manager employee ID', group: E, kind: 'text', synonyms: ['manager id', 'manager code', 'reporting manager', 'reports to', 'manager employee id', 'supervisor id', 'line manager'], example: 'FR-0007', help: 'Their manager may be in SampCrew already or in the same file.' },
  { key: 'employmentType', label: 'Employment type', group: E, kind: 'choice', choices: EMPLOYMENT_TYPES, synonyms: ['employee type', 'type of employment', 'contract type', 'worker type'], example: 'full_time' },
  { key: 'grade', label: 'Grade', group: E, kind: 'text', synonyms: ['band', 'level', 'employee grade', 'job grade'] },
  { key: 'highestQualification', label: 'Highest qualification', group: 'Education and skills', kind: 'text', masterList: 'education', synonyms: ['qualification', 'education', 'highest education', 'degree'] },
  { key: 'skills', label: 'Skills', group: 'Education and skills', kind: 'list', masterList: 'skill', synonyms: ['skill set', 'key skills', 'competencies'], help: 'Separate several with ; or ,' },
  { key: 'assetCodes', label: 'Assets held', group: 'Assets', kind: 'list', synonyms: ['assets', 'asset codes', 'asset id', 'laptop'], help: 'Asset codes separated by ;' },
];

export const CANDIDATE_IMPORT_FIELDS: ImportField[] = [
  { key: 'fullName', label: 'Full name', group: P, kind: 'text', synonyms: ['name', 'candidate name', 'applicant name'] },
  { key: 'firstName', label: 'First name', group: P, kind: 'text', synonyms: ['given name', 'fname'] },
  { key: 'lastName', label: 'Last name', group: P, kind: 'text', synonyms: ['surname', 'family name', 'lname'] },
  { key: 'email', label: 'Email', group: P, kind: 'email', required: true, synonyms: ['email id', 'email address', 'mail', 'candidate email'] },
  { key: 'phone', label: 'Phone number', group: P, kind: 'phone', synonyms: ['phone', 'mobile', 'mobile number', 'contact number', 'cell'] },
  { key: 'locationText', label: 'Location', group: P, kind: 'text', synonyms: ['city', 'current location', 'location'] },
  { key: 'currentTitle', label: 'Current job title', group: 'Experience', kind: 'text', masterList: 'job_title', synonyms: ['designation', 'title', 'current designation', 'current role', 'position'] },
  { key: 'currentCompany', label: 'Current company', group: 'Experience', kind: 'text', synonyms: ['company', 'employer', 'current employer', 'organisation', 'organization'] },
  { key: 'profileUrl', label: 'Profile link', group: 'Experience', kind: 'url', synonyms: ['linkedin', 'linkedin url', 'profile url', 'portfolio', 'resume link'] },
  { key: 'source', label: 'Source', group: 'Source', kind: 'text', masterList: 'candidate_source', synonyms: ['candidate source', 'channel', 'source of hire', 'how did you hear'], help: `A source from Master data (LinkedIn, Employee referral...) or one of: ${CANDIDATE_SOURCES.join(', ')}` },
  { key: 'tags', label: 'Tags', group: 'Source', kind: 'list', synonyms: ['labels', 'keywords', 'skills'], help: 'Separate several with ; or ,' },
  { key: 'requisition', label: 'Job (requisition code or title)', group: 'Source', kind: 'text', synonyms: ['job', 'job code', 'requisition', 'opening', 'applied for', 'position applied'] },
];

export const CLIENT_IMPORT_FIELDS: ImportField[] = [
  { key: 'name', label: 'Client name', group: 'Client', kind: 'text', required: true, synonyms: ['client', 'company', 'company name', 'account', 'account name', 'customer', 'organisation', 'organization'] },
  { key: 'legalName', label: 'Legal name', group: 'Client', kind: 'text', synonyms: ['registered name', 'legal entity'] },
  { key: 'industry', label: 'Industry', group: 'Client', kind: 'text', masterList: 'industry', synonyms: ['sector', 'vertical', 'domain'] },
  { key: 'contactName', label: 'Main contact name', group: 'Main contact', kind: 'text', synonyms: ['contact', 'contact person', 'poc', 'spoc'] },
  { key: 'contactEmail', label: 'Main contact email', group: 'Main contact', kind: 'email', synonyms: ['email', 'contact email', 'poc email'] },
  { key: 'contactPhone', label: 'Main contact phone', group: 'Main contact', kind: 'phone', synonyms: ['phone', 'contact phone', 'contact number', 'mobile'] },
  { key: 'address', label: 'Address', group: 'Client', kind: 'text', synonyms: ['billing address', 'office address'] },
  { key: 'currency', label: 'Currency', group: 'Client', kind: 'text', synonyms: ['billing currency'], help: 'Three letters, such as INR or USD. Left empty: INR.' },
  { key: 'notes', label: 'Notes', group: 'Client', kind: 'text', synonyms: ['remarks', 'comments', 'description'] },
];

export const CONTACT_IMPORT_FIELDS: ImportField[] = [
  { key: 'client', label: 'Client name', group: 'Contact', kind: 'text', required: true, synonyms: ['client', 'company', 'company name', 'account', 'account name', 'organisation', 'organization'] },
  { key: 'fullName', label: 'Full name', group: 'Contact', kind: 'text', synonyms: ['name', 'contact name', 'contact'] },
  { key: 'firstName', label: 'First name', group: 'Contact', kind: 'text', synonyms: ['given name', 'fname'] },
  { key: 'lastName', label: 'Last name', group: 'Contact', kind: 'text', synonyms: ['surname', 'lname'] },
  { key: 'email', label: 'Email', group: 'Contact', kind: 'email', synonyms: ['email id', 'email address', 'mail'] },
  { key: 'phone', label: 'Phone number', group: 'Contact', kind: 'phone', synonyms: ['phone', 'mobile', 'contact number', 'cell'] },
  { key: 'jobTitle', label: 'Job title', group: 'Contact', kind: 'text', masterList: 'job_title', synonyms: ['designation', 'title', 'position', 'role'] },
  { key: 'isPrimary', label: 'Main contact', group: 'Contact', kind: 'bool', synonyms: ['primary', 'primary contact', 'main'] },
  { key: 'notes', label: 'Notes', group: 'Contact', kind: 'text', synonyms: ['remarks', 'comments'] },
];

export const DEPARTMENT_IMPORT_FIELDS: ImportField[] = [
  { key: 'name', label: 'Department name', group: 'Department', kind: 'text', required: true, synonyms: ['department', 'dept', 'name', 'department name'] },
  { key: 'code', label: 'Code', group: 'Department', kind: 'text', synonyms: ['department code', 'dept code', 'short name'] },
  { key: 'parent', label: 'Parent department', group: 'Department', kind: 'text', synonyms: ['parent', 'parent department', 'under', 'reports into'], help: 'The name or code of a department in SampCrew or in the same file.' },
  { key: 'legalEntity', label: 'Legal entity', group: 'Department', kind: 'text', synonyms: ['company', 'entity'] },
];

export const JOB_TITLE_IMPORT_FIELDS: ImportField[] = [
  { key: 'name', label: 'Job title', group: 'Job title', kind: 'text', required: true, synonyms: ['designation', 'title', 'name', 'job title', 'position'] },
  { key: 'code', label: 'Code', group: 'Job title', kind: 'text', synonyms: ['short code', 'designation code'] },
  { key: 'level', label: 'Seniority level (0 to 100)', group: 'Job title', kind: 'number', synonyms: ['level', 'seniority', 'grade level', 'rank'] },
  { key: 'category', label: 'Function', group: 'Job title', kind: 'text', synonyms: ['category', 'function', 'job family', 'group'] },
];

export const MASTER_VALUE_IMPORT_FIELDS: ImportField[] = [
  { key: 'label', label: 'Value', group: 'Value', kind: 'text', required: true, synonyms: ['name', 'value', 'label', 'title', 'skill', 'job role', 'role', 'industry', 'qualification', 'source'] },
  { key: 'category', label: 'Category', group: 'Value', kind: 'text', synonyms: ['group', 'type', 'family'] },
  { key: 'code', label: 'Code', group: 'Value', kind: 'text', synonyms: ['short code'] },
];

export const IMPORT_FIELDS: Record<ImportType, ImportField[]> = {
  employees: EMPLOYEE_IMPORT_FIELDS, candidates: CANDIDATE_IMPORT_FIELDS, clients: CLIENT_IMPORT_FIELDS, contacts: CONTACT_IMPORT_FIELDS,
  departments: DEPARTMENT_IMPORT_FIELDS, job_titles: JOB_TITLE_IMPORT_FIELDS, master_values: MASTER_VALUE_IMPORT_FIELDS,
};

/** The prefix of a custom field's key in a mapping ("cf:uan_number"), and of a leave balance column ("leave:CL"). */
export const CUSTOM_FIELD_PREFIX = 'cf:';
export const LEAVE_FIELD_PREFIX = 'leave:';

// Mapping suggestions --------------------------------------------------------------------------------------------------

/** Header text compared without case, spaces, punctuation, a trailing "*" or words such as "the". */
export function headerNorm(h: string): string {
  return h.toLowerCase().replace(/\*+\s*$/, '').replace(/&/g, ' and ').replace(/\b(the|of|no\.?|number|num)\b/g, (w) => (w.startsWith('n') ? 'no' : '')).replace(/[^a-z0-9]+/g, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity of two normalised headers, 0 to 1. */
export function headerSimilarity(a: string, b: string): number {
  const x = headerNorm(a);
  const y = headerNorm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let both = 0;
  for (const [g, n] of bx) both += Math.min(n, by.get(g) ?? 0);
  return (2 * both) / (x.length - 1 + y.length - 1);
}

export type MatchConfidence = 'exact' | 'likely' | 'none';

export interface MappingSuggestion {
  column: number;
  header: string;
  field: string | null;
  confidence: MatchConfidence;
  /** Other fields that fit nearly as well, best first. */
  alternatives: string[];
}

/**
 * Suggests a field for every column. An exact match (the field's name, key or a known synonym) is "exact"; a close
 * spelling is only "likely" and the screen asks the person to confirm it. Nothing below that is suggested, and no
 * field is suggested for two columns: the better match wins and the other column is left for the person.
 */
export function suggestMapping(headers: string[], fields: ImportField[]): MappingSuggestion[] {
  const names = (f: ImportField) => [f.label, f.key, ...(f.synonyms ?? [])];
  const scored = headers.map((header, column) => {
    const h = headerNorm(header);
    const scores = fields.map((f) => {
      const exact = h !== '' && names(f).some((n) => headerNorm(n) === h);
      const best = exact ? 1 : Math.max(...names(f).map((n) => headerSimilarity(header, n)));
      return { field: f.key, score: exact ? 2 : best };
    }).filter((s) => s.score >= 0.72).sort((a, b) => b.score - a.score);
    return { column, header, scores };
  });
  const taken = new Map<string, { column: number; score: number }>();
  // Best matches first, so a stronger column keeps a field a weaker one also wanted.
  const order = scored.flatMap((s) => s.scores.map((x) => ({ column: s.column, ...x }))).sort((a, b) => b.score - a.score);
  const chosen = new Map<number, { field: string; score: number }>();
  for (const o of order) {
    if (chosen.has(o.column) || taken.has(o.field)) continue;
    chosen.set(o.column, { field: o.field, score: o.score });
    taken.set(o.field, { column: o.column, score: o.score });
  }
  return scored.map((s) => {
    const c = chosen.get(s.column);
    return {
      column: s.column,
      header: s.header,
      field: c?.field ?? null,
      confidence: !c ? 'none' : c.score >= 2 ? 'exact' : 'likely',
      alternatives: s.scores.map((x) => x.field).filter((f) => f !== c?.field).slice(0, 3),
    };
  });
}

export const CUSTOM_FIELD_TYPE_FOR_SAMPLE = ['short_text', 'long_text', 'number', 'decimal', 'date', 'email', 'phone', 'url', 'yes_no', 'dropdown'] as const;

/** A sensible field type for a column nobody mapped, from its values: dates, numbers, emails, yes/no or a short list. */
export function guessFieldType(values: string[], parseDate: (v: string) => string | null): { type: (typeof CUSTOM_FIELD_TYPE_FOR_SAMPLE)[number]; options: string[] } {
  const v = values.map((x) => x.trim()).filter(Boolean);
  if (!v.length) return { type: 'short_text', options: [] };
  const all = (re: RegExp) => v.every((x) => re.test(x));
  if (v.every((x) => /^(yes|no|y|n|true|false)$/i.test(x))) return { type: 'yes_no', options: [] };
  if (all(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/)) return { type: 'email', options: [] };
  if (all(/^https?:\/\/\S+$/i)) return { type: 'url', options: [] };
  if (all(/^-?\d+$/) && v.some((x) => x.length > 6) && v.every((x) => x.replace(/^-/, '').length <= 15) && all(/^\+?\d{10,15}$/)) return { type: 'phone', options: [] };
  if (all(/^-?\d+$/)) return { type: 'number', options: [] };
  if (all(/^-?\d+(\.\d+)?$/)) return { type: 'decimal', options: [] };
  if (all(/[-/ ]/) && v.every((x) => parseDate(x) !== null)) return { type: 'date', options: [] };
  const distinct = [...new Set(v.map((x) => x.replace(/\s+/g, ' ')))];
  if (v.length >= 4 && distinct.length <= Math.min(12, Math.ceil(v.length / 2)) && distinct.every((x) => x.length <= 40)) return { type: 'dropdown', options: distinct.sort((a, b) => a.localeCompare(b)) };
  return { type: v.some((x) => x.length > 120) ? 'long_text' : 'short_text', options: [] };
}

// Jobs ---------------------------------------------------------------------------------------------------------------

export const IMPORT_JOB_STATUSES = ['mapping', 'validated', 'importing', 'completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];
export const IMPORT_JOB_STATUS_LABEL: Record<ImportJobStatus, string> = {
  mapping: 'Mapping columns', validated: 'Checked, ready to import', importing: 'Importing', completed: 'Completed', completed_with_errors: 'Completed with errors',
  failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Stopped, can carry on',
};

export const IMPORT_ROW_STATUSES = ['pending', 'valid', 'warning', 'error', 'duplicate', 'imported', 'updated', 'skipped', 'failed'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export const DUPLICATE_STRATEGIES = ['skip', 'update', 'create', 'ask'] as const;
export type DuplicateStrategy = (typeof DUPLICATE_STRATEGIES)[number];
export const DUPLICATE_STRATEGY_LABEL: Record<DuplicateStrategy, string> = {
  skip: 'Skip it (keep what is in SampCrew)', update: 'Update the existing record', create: 'Create a new record anyway', ask: 'Let me decide for each one',
};
export const ROW_DECISIONS = ['skip', 'update', 'create'] as const;

export interface ImportIssue {
  /** The field it is about (or "row"). */
  field: string;
  /** The column as named in the file. */
  column: string | null;
  level: 'error' | 'warning';
  message: string;
  /** What to change in the file. */
  suggestion?: string;
}

export interface ImportSummary {
  total: number;
  valid: number;
  warnings: number;
  errors: number;
  duplicates: number;
  /** Rows that will make a new record. */
  new: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface ImportOptions {
  duplicates: DuplicateStrategy;
  /** Fields that find an existing record, in order. */
  matchBy: string[];
  /** Employees: the HR Workspace they join (null: the central group, Super Workspace only). Left out: the importer's own. */
  hrWorkspaceId?: string | null;
  /** Candidates: the importer confirms the workspace may hold these people's details. */
  lawfulBasisConfirmed?: boolean;
  /** Master values: which list. */
  list?: string;
  /** Add values missing from a master data list (job titles, departments are never created this way). */
  addMissingValues: boolean;
}

export interface ImportJobView {
  id: string;
  number: number;
  type: ImportType;
  status: ImportJobStatus;
  fileName: string;
  fileSize: number;
  headers: string[];
  sample: string[][];
  rowCount: number;
  mapping: { column: number; field: string | null }[];
  suggestions: MappingSuggestion[];
  options: ImportOptions;
  summary: ImportSummary;
  progress: { done: number; total: number };
  createdFields: { key: string; label: string; column: number }[];
  createdBy: string | null;
  hrWorkspace: string | null;
  createdAt: string;
  validatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** Rows that match an existing record and still need a decision (duplicates: "let me decide"). */
  undecided: number;
  /** Other lists: which list the values go to. */
  list: string | null;
  /** The fields a column can be mapped to (in the job's detail only). */
  fields?: ImportField[];
  /** What the person may do next. */
  can: { map: boolean; validate: boolean; run: boolean; cancel: boolean; resume: boolean };
}

export interface ImportRowView {
  row: number;
  status: ImportRowStatus;
  cells: Record<string, string>;
  issues: ImportIssue[];
  match: { recordId: string; label: string; by: string; unique: boolean } | null;
  decision: (typeof ROW_DECISIONS)[number] | null;
  record: { id: string; label: string; href: string | null } | null;
}

export interface ImportTargetField extends ImportField {
  /** Shown in the mapping dropdown under this group. */
  group: string;
}

const uuid = z.uuid();
export const importStartQuery = z.object({ type: z.enum(IMPORT_TYPES), list: z.enum(VALUE_LISTS).optional() });
export const newImportFieldInput = z.object({
  column: z.number().int().min(0).max(IMPORT_JOB_MAX_COLUMNS),
  label: z.string().trim().min(1).max(120),
  type: z.enum(CUSTOM_FIELD_TYPES),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
  /** Access levels that see it: Super Workspace and HR Workspace always; Employee Workspace when ticked. */
  visibleToEmployee: z.boolean().default(false),
  employeeEditable: z.boolean().default(false),
  searchable: z.boolean().default(false),
}).strict();
export const importMappingInput = z.object({
  mapping: z.array(z.object({ column: z.number().int().min(0).max(IMPORT_JOB_MAX_COLUMNS), field: z.string().max(80).nullable() }).strict()).max(IMPORT_JOB_MAX_COLUMNS),
  newFields: z.array(newImportFieldInput).max(50).default([]),
  options: z.object({
    duplicates: z.enum(DUPLICATE_STRATEGIES).default('skip'),
    matchBy: z.array(z.string().max(40)).min(1).max(5),
    hrWorkspaceId: uuid.nullable().optional(),
    lawfulBasisConfirmed: z.boolean().optional(),
    addMissingValues: z.boolean().default(true),
  }).strict(),
}).strict();
export type ImportMappingInput = z.infer<typeof importMappingInput>;
export const importDecisionsInput = z.object({
  decisions: z.array(z.object({ row: z.number().int().min(2), decision: z.enum(ROW_DECISIONS) }).strict()).min(1).max(IMPORT_JOB_MAX_ROWS),
}).strict();
export const importRowsQuery = z.object({
  status: z.enum(['all', 'problems', 'error', 'warning', 'duplicate', 'valid', 'imported', 'updated', 'skipped', 'failed']).default('all'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});
export const importHistoryQuery = z.object({
  type: z.enum(IMPORT_TYPES).optional(),
  status: z.enum(IMPORT_JOB_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Yes/No in a sheet: yes, y, true, 1, ticked... */
export function sheetBool(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'true', '1', 'x', '✓', 'primary', 'main'].includes(s)) return true;
  if (['no', 'n', 'false', '0', '-'].includes(s)) return false;
  return null;
}

/** A list cell: "a; b, c" or one per line. */
export function sheetList(v: string): string[] {
  return [...new Set(v.split(/[;,\n|]+/).map((s) => s.trim()).filter(Boolean))];
}

/** A choice cell matched to an allowed value without regard to case, spaces, dashes or underscores. */
export function sheetChoice<T extends string>(v: string, choices: readonly T[], aliases: Record<string, T> = {}): T | null {
  const n = v.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!n) return null;
  const hit = choices.find((c) => c.toLowerCase().replace(/[\s_-]+/g, '') === n);
  if (hit) return hit;
  return aliases[n] ?? null;
}

export const CHOICE_ALIASES: Record<string, Record<string, string>> = {
  gender: { f: 'female', m: 'male', woman: 'female', man: 'male', nonbinary: 'non_binary', other: 'non_binary', notsaid: 'undisclosed', prefernottosay: 'undisclosed' },
  employmentType: { fulltime: 'full_time', permanent: 'full_time', regular: 'full_time', ft: 'full_time', parttime: 'part_time', pt: 'part_time', contractual: 'contract', contractor: 'contract', consultant: 'contract', internship: 'intern', trainee: 'intern', temp: 'temporary', casual: 'temporary' },
  maritalStatus: { unmarried: 'single', divorcee: 'divorced', widow: 'widowed', widower: 'widowed' },
};

// Bulk changes to employees -------------------------------------------------------------------------------------------

/** One change made to several employees at once. Each person is changed on their own, with the same checks as one by one. */
export const employeeBulkInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('department'), employeeIds: z.array(uuid).min(1).max(500), departmentId: uuid.nullable(), effectiveFrom: z.iso.date(), note: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal('job_title'), employeeIds: z.array(uuid).min(1).max(500), designationId: uuid, effectiveFrom: z.iso.date(), note: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal('location'), employeeIds: z.array(uuid).min(1).max(500), locationId: uuid.nullable(), effectiveFrom: z.iso.date(), note: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal('manager'), employeeIds: z.array(uuid).min(1).max(500), managerEmployeeId: uuid.nullable(), effectiveFrom: z.iso.date(), note: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal('custom_field'), employeeIds: z.array(uuid).min(1).max(500), key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), value: z.unknown() }).strict(),
]);
export type EmployeeBulkInput = z.infer<typeof employeeBulkInput>;
export interface EmployeeBulkResult {
  done: number;
  failed: number;
  results: { employeeId: string; name: string | null; ok: boolean; message: string | null }[];
}
