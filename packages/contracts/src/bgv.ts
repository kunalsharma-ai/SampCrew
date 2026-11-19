import { z } from 'zod';
import { email } from './schemas/common';
import { optionalPhone } from './phone';

/**
 * Background verification (BGV): a case per employee holds one check per thing verified (identity, address,
 * education, previous employment, references, documents). A case is worked internally by HR, or assigned to an
 * external agency, which reads the shared documents and sends its findings and report through a private link.
 */

export const BGV_CHECK_TYPES = ['identity', 'address', 'education', 'employment', 'reference', 'document'] as const;
export type BgvCheckType = (typeof BGV_CHECK_TYPES)[number];

export const BGV_CHECK_LABEL: Record<BgvCheckType, string> = {
  identity: 'Identity',
  address: 'Address',
  education: 'Education',
  employment: 'Previous employment',
  reference: 'Reference',
  document: 'Document',
};

/** A case's and a check's status. A case's final result is verified, failed or on hold, set by someone who may approve. */
export const BGV_STATUSES = ['pending', 'in_progress', 'verified', 'failed', 'on_hold'] as const;
export type BgvStatus = (typeof BGV_STATUSES)[number];
export const BGV_STATUS_LABEL: Record<BgvStatus | 'cancelled', string> = {
  pending: 'Pending', in_progress: 'In progress', verified: 'Verified', failed: 'Failed', on_hold: 'On hold', cancelled: 'Cancelled',
};

export const BGV_METHODS = ['internal', 'external'] as const;
export type BgvMethod = (typeof BGV_METHODS)[number];

/** The details HR records for each kind of check, shown as form fields. Values are free text, at most 500 characters. */
export const BGV_CHECK_FIELDS: Record<BgvCheckType, { key: string; label: string; type?: 'date' | 'email' | 'text' | 'textarea' }[]> = {
  identity: [
    { key: 'idType', label: 'Document type (passport, Aadhaar, PAN, driving licence ...)' },
    { key: 'idNumber', label: 'Document number' },
    { key: 'nameOnDocument', label: 'Name on the document' },
  ],
  address: [
    { key: 'address', label: 'Address', type: 'textarea' },
    { key: 'city', label: 'City' },
    { key: 'postalCode', label: 'Postal code' },
    { key: 'country', label: 'Country' },
    { key: 'residingSince', label: 'Living there since', type: 'date' },
  ],
  education: [
    { key: 'institution', label: 'Institution' },
    { key: 'qualification', label: 'Qualification' },
    { key: 'specialisation', label: 'Specialisation' },
    { key: 'yearOfPassing', label: 'Year of passing' },
    { key: 'rollNumber', label: 'Roll or registration number' },
  ],
  employment: [
    { key: 'company', label: 'Company' },
    { key: 'designation', label: 'Designation' },
    { key: 'from', label: 'From', type: 'date' },
    { key: 'to', label: 'To', type: 'date' },
    { key: 'hrContact', label: 'HR or manager contact' },
    { key: 'reasonForLeaving', label: 'Reason for leaving' },
  ],
  reference: [
    { key: 'refereeName', label: 'Referee name' },
    { key: 'relationship', label: 'Relationship' },
    { key: 'company', label: 'Company' },
    { key: 'refereeEmail', label: 'Referee email', type: 'email' },
    { key: 'refereePhone', label: 'Referee phone' },
  ],
  document: [
    { key: 'documentTitle', label: 'Document' },
    { key: 'issuedBy', label: 'Issued by' },
    { key: 'documentNumber', label: 'Document number' },
  ],
};

/** Detail keys whose values are personal identifiers: stored encrypted, shown masked except to people who may edit checks. */
export const BGV_SECRET_DETAILS = new Set(['idNumber', 'rollNumber', 'documentNumber']);

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD)');

export const bgvDetails = z.record(z.string().regex(/^[a-zA-Z]{1,40}$/), text(500)).refine((d) => Object.keys(d).length <= 20, 'Too many details');

export const bgvAgencyInput = z.object({
  name: z.string().trim().min(2).max(160),
  contactName: optionalText(160),
  email,
  phone: optionalPhone,
  website: z.string().trim().max(300).url('Use a full address, for example https://agency.example').optional().or(z.literal('').transform(() => undefined)),
  address: optionalText(500),
  services: z.array(z.enum(BGV_CHECK_TYPES)).min(1, 'Choose at least one kind of check').max(BGV_CHECK_TYPES.length).transform((a) => [...new Set(a)]),
  turnaroundDays: z.coerce.number().int().min(1).max(180).optional(),
  notes: optionalText(1000),
  active: z.boolean().default(true),
}).strict();
export type BgvAgencyInput = z.infer<typeof bgvAgencyInput>;

export const bgvCheckInput = z.object({
  type: z.enum(BGV_CHECK_TYPES),
  details: bgvDetails.default({}),
  /** Employee documents (employee_documents ids) this check looks at. */
  documentIds: z.array(z.uuid()).max(20).default([]),
}).strict();

export const bgvCaseInput = z.object({
  employeeId: z.uuid(),
  method: z.enum(BGV_METHODS),
  agencyId: z.uuid().optional(),
  checks: z.array(bgvCheckInput).min(1, 'Add at least one check').max(30),
  dueDate: isoDate.optional(),
  /** Internal verifier (a workspace member who may edit checks). */
  assigneeMembershipId: z.uuid().optional(),
  notes: optionalText(2000),
}).strict().refine((v) => v.method === 'internal' || !!v.agencyId, { message: 'Choose the agency', path: ['agencyId'] });
export type BgvCaseInput = z.infer<typeof bgvCaseInput>;

export const bgvCaseUpdateInput = z.object({
  dueDate: isoDate.nullable().optional(),
  assigneeMembershipId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  agencyReference: z.string().trim().max(120).nullable().optional(),
}).strict();

export const bgvAddCheckInput = bgvCheckInput;

export const bgvCheckUpdateInput = z.object({
  status: z.enum(BGV_STATUSES).optional(),
  details: bgvDetails.optional(),
  documentIds: z.array(z.uuid()).max(20).optional(),
  /** Internal remarks and observations: never shown to the agency or the employee. */
  remarks: z.string().trim().max(4000).nullable().optional(),
  /** What the agency (or the source contacted) said. */
  agencyFeedback: z.string().trim().max(4000).nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const bgvDecisionInput = z.object({
  status: z.enum(['verified', 'failed', 'on_hold', 'in_progress']),
  remarks: z.string().trim().min(3, 'Say why, in a few words').max(4000),
  /** Verification completion date; today when left out for verified or failed. */
  completedOn: isoDate.optional(),
}).strict();

export const bgvCancelInput = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();

/** Assigning a case to an agency: a private link (emailed to the agency) to the shared documents and the findings form. */
export const bgvShareInput = z.object({
  agencyId: z.uuid(),
  message: optionalText(2000),
  expiresInDays: z.coerce.number().int().min(1).max(90).default(30),
}).strict();

export const bgvFileShareInput = z.object({ shared: z.boolean() }).strict();

/** What an agency sends back through its link. */
export const bgvAgencyFindingsInput = z.object({
  reporterName: z.string().trim().min(2).max(160),
  summary: z.string().trim().max(4000).optional(),
  completedOn: isoDate.optional(),
  checks: z.array(z.object({
    checkId: z.uuid(),
    status: z.enum(['in_progress', 'verified', 'failed', 'on_hold']),
    feedback: z.string().trim().max(4000).optional(),
  }).strict()).max(30).default([]),
}).strict();

export const bgvListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum([...BGV_STATUSES, 'cancelled', 'open']).optional(),
  method: z.enum(BGV_METHODS).optional(),
  agencyId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** A case's overall status from its checks, while no final result has been set: pending until any check moves. */
export function caseProgress(checks: { status: BgvStatus }[]): 'pending' | 'in_progress' {
  return checks.some((c) => c.status !== 'pending') ? 'in_progress' : 'pending';
}

/** Shows only the last 4 characters of an identifier: 'XXXXXXXX1234'. */
export function maskIdentifier(v: string): string {
  const s = v.replace(/\s+/g, '');
  if (s.length <= 4) return '•'.repeat(s.length);
  return `${'•'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}`;
}
