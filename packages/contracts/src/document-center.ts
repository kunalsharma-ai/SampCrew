import { z } from 'zod';
import type { DOCUMENT_CATEGORIES } from './schemas/people';

/**
 * Centralized document management: one record per uploaded file (employee_documents), document requests raised by
 * Super Workspace or an HR Workspace, verification through the approvals engine, a Documents section in every
 * profile, and per-HR-Workspace document access switches that only Super Workspace can change.
 */

// Categories and types ---------------------------------------------------------------------------------------------

export const DOCUMENT_GROUPS = ['identity', 'employment', 'education', 'financial', 'organizational', 'other'] as const;
export type DocumentGroup = (typeof DOCUMENT_GROUPS)[number];
/** The group of a document filed before groups existed (by its original category). */
export const LEGACY_CATEGORY_GROUP: Record<(typeof DOCUMENT_CATEGORIES)[number], DocumentGroup> = {
  id_proof: 'identity', address_proof: 'identity', contract: 'employment', offer_letter: 'employment',
  policy: 'organizational', certificate: 'education', tax: 'financial', other: 'other',
};
export const legacyCategoriesOf = (group: string) => Object.entries(LEGACY_CATEGORY_GROUP).filter(([, g]) => g === group).map(([c]) => c);
export const DOCUMENT_GROUP_LABEL: Record<DocumentGroup, string> = {
  identity: 'Identity documents', employment: 'Employment documents', education: 'Education documents',
  financial: 'Financial documents', organizational: 'Organizational documents', other: 'Other documents',
};

/** Who a document type is for: a person (Employee or HR Workspace person) or an HR Workspace itself. */
export type DocumentOwnerType = 'employee' | 'hr_workspace';

export interface DocumentTypeDef {
  key: string;
  name: string;
  /** A built-in group, or the key of a custom category. */
  category: string;
  /** Identity numbers, bank details and the like: downloads are audited as sensitive and file names masked in lists. */
  sensitive: boolean;
  owners: readonly DocumentOwnerType[];
  /** The old profile category the file is also filed under, so earlier screens and exports keep working. */
  legacy: (typeof DOCUMENT_CATEGORIES)[number];
  builtIn: boolean;
}

const t = (key: string, name: string, category: DocumentGroup, legacy: DocumentTypeDef['legacy'], o: { sensitive?: boolean; owners?: DocumentOwnerType[] } = {}): DocumentTypeDef => ({
  key, name, category, legacy, sensitive: o.sensitive ?? false, owners: o.owners ?? ['employee'], builtIn: true,
});

export const BUILT_IN_DOCUMENT_TYPES: readonly DocumentTypeDef[] = [
  t('aadhaar', 'Aadhaar Card', 'identity', 'id_proof', { sensitive: true }),
  t('pan', 'PAN Card', 'identity', 'id_proof', { sensitive: true }),
  t('passport', 'Passport', 'identity', 'id_proof', { sensitive: true }),
  t('driving_licence', 'Driving Licence', 'identity', 'id_proof', { sensitive: true }),
  t('voter_id', 'Voter ID', 'identity', 'id_proof', { sensitive: true }),
  t('resume', 'Resume / CV', 'employment', 'other'),
  t('offer_letter', 'Offer Letter', 'employment', 'offer_letter'),
  t('appointment_letter', 'Appointment Letter', 'employment', 'contract'),
  t('employment_agreement', 'Employment Agreement', 'employment', 'contract'),
  t('experience_letter', 'Experience Letter', 'employment', 'certificate'),
  t('relieving_letter', 'Relieving Letter', 'employment', 'certificate'),
  t('salary_slip', 'Salary Slip', 'employment', 'tax', { sensitive: true }),
  t('marksheet_10', '10th Marksheet', 'education', 'certificate'),
  t('marksheet_12', '12th Marksheet', 'education', 'certificate'),
  t('graduation', 'Graduation Certificate', 'education', 'certificate'),
  t('postgraduate', 'Postgraduate Certificate', 'education', 'certificate'),
  t('diploma', 'Diploma', 'education', 'certificate'),
  t('professional_certification', 'Professional Certification', 'education', 'certificate'),
  t('bank_details', 'Bank Details Document', 'financial', 'other', { sensitive: true }),
  t('cancelled_cheque', 'Cancelled Cheque', 'financial', 'other', { sensitive: true }),
  t('tax_documents', 'Tax Documents', 'financial', 'tax', { sensitive: true }),
  t('other_financial', 'Other Financial Document', 'financial', 'other', { sensitive: true }),
  t('company_registration', 'Company Registration', 'organizational', 'other', { owners: ['hr_workspace'] }),
  t('business_registration', 'Business Registration', 'organizational', 'other', { owners: ['hr_workspace'] }),
  t('gst_certificate', 'GST Certificate', 'organizational', 'tax', { owners: ['hr_workspace'] }),
  t('authorization_letter', 'Authorization Letter', 'organizational', 'other', { owners: ['hr_workspace', 'employee'] }),
  t('other_company', 'Other Company Document', 'organizational', 'other', { owners: ['hr_workspace'] }),
  t('custom', 'Custom Document', 'other', 'other', { owners: ['employee', 'hr_workspace'] }),
  t('supporting', 'Supporting Document', 'other', 'other', { owners: ['employee', 'hr_workspace'] }),
  t('additional', 'Additional Attachment', 'other', 'other', { owners: ['employee', 'hr_workspace'] }),
];

export function builtInType(key: string | null | undefined): DocumentTypeDef | undefined {
  return BUILT_IN_DOCUMENT_TYPES.find((x) => x.key === key);
}

const slug = z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9_]*$/, 'Use lower-case letters, digits and underscores');
export const documentCategoryInput = z.object({ key: slug, name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).optional().nullable() });
export const documentTypeInput = z.object({
  key: slug,
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(60),
  sensitive: z.boolean().default(false),
  owners: z.array(z.enum(['employee', 'hr_workspace'])).min(1).default(['employee']),
});

// Files ------------------------------------------------------------------------------------------------------------

/** What a document request accepts: PDF, images, Word and Excel (old and new formats). */
export const REQUEST_FILE_FORMATS = {
  pdf: ['application/pdf'],
  image: ['image/png', 'image/jpeg'],
  word: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  excel: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
} as const;
export type RequestFileFormat = keyof typeof REQUEST_FILE_FORMATS;
export const REQUEST_FILE_FORMAT_KEYS = Object.keys(REQUEST_FILE_FORMATS) as RequestFileFormat[];
export const REQUEST_FILE_LABEL: Record<RequestFileFormat, string> = { pdf: 'PDF', image: 'JPG, JPEG or PNG', word: 'Word (DOC, DOCX)', excel: 'Excel (XLS, XLSX)' };
export const REQUEST_FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx';

// Requests ---------------------------------------------------------------------------------------------------------

/**
 * A request's life: raised (new_request), opened by the person who must submit (pending_submission), a file sent
 * (submitted, or resubmitted after a correction or rejection), a reviewer opened it (under_verification), then
 * approved (and so completed: the document is collected), rejected, or sent back for correction. "Overdue" is shown,
 * not stored: an open request past its deadline.
 */
export const DOCUMENT_REQUEST_STATUSES = ['new_request', 'pending_submission', 'submitted', 'resubmitted', 'under_verification', 'correction_required', 'rejected', 'completed', 'cancelled'] as const;
export type DocumentRequestStatus = (typeof DOCUMENT_REQUEST_STATUSES)[number];
export const DOCUMENT_REQUEST_STATUS_LABEL: Record<DocumentRequestStatus | 'overdue' | 'approved', string> = {
  new_request: 'New request', pending_submission: 'Pending submission', submitted: 'Submitted', resubmitted: 'Resubmitted', under_verification: 'Under verification',
  correction_required: 'Correction required', rejected: 'Rejected', completed: 'Completed', cancelled: 'Cancelled', overdue: 'Overdue', approved: 'Approved',
};
/** Waiting for the person to send a file. */
export const AWAITING_SUBMISSION: readonly DocumentRequestStatus[] = ['new_request', 'pending_submission', 'correction_required', 'rejected'];
/** A file is with the reviewer. */
export const AWAITING_REVIEW: readonly DocumentRequestStatus[] = ['submitted', 'resubmitted', 'under_verification'];
export const OPEN_REQUEST_STATUSES: readonly DocumentRequestStatus[] = [...AWAITING_SUBMISSION, ...AWAITING_REVIEW];

export function requestDisplayStatus(status: DocumentRequestStatus, dueOn: string | null, today: string): DocumentRequestStatus | 'overdue' {
  if (dueOn && dueOn < today && AWAITING_SUBMISSION.includes(status)) return 'overdue';
  return status;
}

/** The status of the file itself (employee_documents.verification_status), as people see it. */
export const DOCUMENT_STATUS_LABEL: Record<string, string> = {
  pending: 'Pending verification', verified: 'Approved', rejected: 'Rejected', correction_required: 'Correction required', unverified: 'Not verified', expired: 'Expired', superseded: 'Replaced',
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31');
const text = (max: number) => z.string().trim().max(max);

export const documentRequestInput = z
  .object({
    target: z.enum(['employee', 'hr_workspace']),
    /** Employee targets: one or more people (each gets their own request and task). */
    employeeIds: z.array(z.uuid()).max(200).optional(),
    /** HR Workspace target: the workspace, and which of its admins the task goes to (any admin may submit). */
    hrWorkspaceId: z.uuid().optional().nullable(),
    assigneeMembershipId: z.uuid().optional().nullable(),
    typeKey: z.string().trim().min(2).max(60),
    /**
     * Ask for several documents at once (issue #83): every type listed here (typeKey included) becomes its own
     * request and task. The name below then applies only to a custom document.
     */
    typeKeys: z.array(z.string().trim().min(2).max(60)).max(20).optional(),
    /** Shown to the person; defaults to the type's name. A custom requirement must be named. */
    title: text(200).optional().nullable(),
    instructions: text(2000).optional().nullable(),
    reason: text(1000).min(3, 'Say why the document is needed'),
    dueOn: day.optional().nullable(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    formats: z.array(z.enum(REQUEST_FILE_FORMAT_KEYS as [RequestFileFormat, ...RequestFileFormat[]])).min(1).max(4).default(['pdf', 'image']),
    maxMb: z.number().int().min(1).max(10).default(10),
    /** Ask for the document's expiry date with the upload (passports, licences, certificates). */
    expiryRequired: z.boolean().default(false),
    /** A replacement for this earlier document (expired, or to be renewed). */
    replacesDocumentId: z.uuid().optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.target === 'employee' && !v.employeeIds?.length) ctx.addIssue({ code: 'custom', path: ['employeeIds'], message: 'Choose who must submit it' });
    if (v.target === 'hr_workspace' && !v.hrWorkspaceId) ctx.addIssue({ code: 'custom', path: ['hrWorkspaceId'], message: 'Choose the HR Workspace' });
    if ((v.typeKey === 'custom' || v.typeKeys?.includes('custom')) && !v.title?.trim()) ctx.addIssue({ code: 'custom', path: ['title'], message: 'Name the document you need' });
    if (v.replacesDocumentId && v.typeKeys && new Set([v.typeKey, ...v.typeKeys]).size > 1) ctx.addIssue({ code: 'custom', path: ['typeKeys'], message: 'A replacement asks for one document' });
  });
/** Every document type one request form asks for, typeKey first, without repeats. */
export function requestedTypeKeys(v: { typeKey: string; typeKeys?: string[] }): string[] {
  return [...new Set([v.typeKey, ...(v.typeKeys ?? [])])];
}
export type DocumentRequestInput = z.infer<typeof documentRequestInput>;

export const documentSubmitMeta = z.object({
  remarks: text(2000).optional().nullable(),
  expiresOn: day.optional().nullable().or(z.literal('').transform(() => null)),
});

export const documentDecisionInput = z
  .object({
    decision: z.enum(['approve', 'reject', 'correction']),
    comment: text(2000).optional().nullable(),
    /** The expiry date the reviewer confirms (or corrects) when approving. */
    expiresOn: day.optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'reject' && (v.comment?.trim().length ?? 0) < 3) ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Give the reason for rejecting it' });
    if (v.decision === 'correction' && (v.comment?.trim().length ?? 0) < 3) ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Say what must be corrected' });
  });

export const documentCancelInput = z.object({ reason: text(1000).min(3, 'Say why') });

// Repository -------------------------------------------------------------------------------------------------------

export const DOCUMENT_STATUS_FILTERS = ['pending', 'verified', 'rejected', 'correction_required', 'unverified', 'expired'] as const;

export const documentRepositoryQuery = z.object({
  q: text(100).optional(),
  owner: z.enum(['employee', 'hr_workspace']).optional(),
  employeeId: z.uuid().optional(),
  hrWorkspaceId: z.string().max(60).optional(),
  category: z.string().max(60).optional(),
  typeKey: z.string().max(60).optional(),
  status: z.enum(DOCUMENT_STATUS_FILTERS).optional(),
  requestedBy: z.enum(['super_workspace', 'hr_workspace', 'none']).optional(),
  verifierMembershipId: z.uuid().optional(),
  from: day.optional(),
  to: day.optional(),
  includeReplaced: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type DocumentRepositoryQuery = z.infer<typeof documentRepositoryQuery>;

export const documentRequestQuery = z.object({
  /** mine: requests I must submit; raised: requests I (or my level) raised; review: waiting for my verification; all: everything I can see. */
  scope: z.enum(['mine', 'raised', 'review', 'all']).default('all'),
  status: z.enum([...DOCUMENT_REQUEST_STATUSES, 'open', 'overdue', 'awaiting_review', 'awaiting_submission']).optional(),
  employeeId: z.uuid().optional(),
  hrWorkspaceId: z.string().max(60).optional(),
  requestedBy: z.enum(['super_workspace', 'hr_workspace']).optional(),
  typeKey: z.string().max(60).optional(),
  q: text(100).optional(),
  dueBefore: day.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

// Access switches (Super Workspace > Settings > Permissions > Document Access Management) ----------------------------

export const DOCUMENT_ACCESS_SWITCHES = [
  { key: 'enabled', label: 'Document management', description: 'Switching this off removes every document view and action below for this HR Workspace. Nothing is deleted.' },
  { key: 'view_employee', label: 'View employee documents', description: 'Every employee document, whatever its status.' },
  { key: 'view_approved', label: 'View approved employee documents', description: 'Only documents that were verified and approved (and files added directly by HR).' },
  { key: 'view_pending', label: 'View pending documents', description: 'Documents waiting for verification, rejected or sent back for correction.' },
  { key: 'preview', label: 'Preview documents', description: 'Open a file in the secure preview.' },
  { key: 'download', label: 'Download documents', description: 'Save a copy of a file. Every download is recorded.' },
  { key: 'view_hr_documents', label: 'View HR Workspace documents', description: "The HR Workspace's own documents (registration, GST and so on)." },
  { key: 'view_other_hr', label: 'View documents of other authorized HR Workspaces', description: 'Read-only access to the HR Workspaces listed below.' },
  { key: 'request_other_hr', label: 'Request documents from other authorized HR Workspaces', description: 'Raise requests to the HR Workspaces listed below; this HR Workspace verifies them.' },
  { key: 'request', label: 'Request employee documents', description: 'Raise document requests to its employees.' },
  { key: 'verify', label: 'Verify employee documents', description: 'Open submissions in the verification queue. Needed for approving, rejecting and corrections.' },
  { key: 'approve', label: 'Approve employee documents', description: '' },
  { key: 'reject', label: 'Reject employee documents', description: '' },
  { key: 'correct', label: 'Request document corrections', description: '' },
  { key: 'export', label: 'Export document records', description: 'Download the list of documents as a spreadsheet (records only, never the files).' },
] as const;
export type DocumentAccessKey = (typeof DOCUMENT_ACCESS_SWITCHES)[number]['key'];
export const DOCUMENT_ACCESS_KEYS = DOCUMENT_ACCESS_SWITCHES.map((s) => s.key) as DocumentAccessKey[];
export type DocumentAccess = Record<DocumentAccessKey, boolean>;

/**
 * What an HR Workspace has before Super Workspace changes anything: what HR Workspace could already do with documents
 * (so nothing that worked stops working), but never other HR Workspaces' documents and no exports.
 */
export const DEFAULT_DOCUMENT_ACCESS: DocumentAccess = {
  enabled: true, view_employee: true, view_approved: true, view_pending: true, preview: true, download: true, view_hr_documents: true,
  view_other_hr: false, request_other_hr: false, request: true, verify: true, approve: true, reject: true, correct: true, export: false,
};
export const NO_DOCUMENT_ACCESS: DocumentAccess = Object.fromEntries(DOCUMENT_ACCESS_KEYS.map((k) => [k, false])) as DocumentAccess;

/** Switches as stored, made whole: unknown keys dropped, missing ones defaulted, everything off while disabled. */
export function effectiveDocumentAccess(stored: Partial<Record<string, unknown>> | null | undefined): DocumentAccess {
  const out = { ...DEFAULT_DOCUMENT_ACCESS };
  for (const k of DOCUMENT_ACCESS_KEYS) if (typeof stored?.[k] === 'boolean') out[k] = stored[k] as boolean;
  return out.enabled ? out : { ...NO_DOCUMENT_ACCESS };
}

export const documentAccessInput = z.object({
  switches: z.object(Object.fromEntries(DOCUMENT_ACCESS_KEYS.map((k) => [k, z.boolean()])) as Record<DocumentAccessKey, z.ZodBoolean>),
  /** For the "other authorized HR Workspaces" switches. */
  sharedHrWorkspaceIds: z.array(z.uuid()).max(200).default([]),
  /** The version shown when the form was opened, so two people saving at once cannot overwrite each other. */
  version: z.number().int().min(0).optional(),
});

/** Activity recorded for every document (append only). */
export const DOCUMENT_ACTIVITY_LABEL: Record<string, string> = {
  requested: 'Requested', opened: 'Request opened', submitted: 'Submitted', resubmitted: 'Resubmitted', review_started: 'Verification started',
  approved: 'Approved', rejected: 'Rejected', correction_requested: 'Correction requested', cancelled: 'Request cancelled', viewed: 'Previewed',
  downloaded: 'Downloaded', exported: 'Exported in a list', expired: 'Expired', replacement_requested: 'Replacement requested', replaced: 'Replaced by a newer version',
  uploaded: 'Added to the profile', archived: 'Archived', access_changed: 'Access changed', reminder: 'Deadline reminder sent', overdue: 'Overdue notice sent',
};
