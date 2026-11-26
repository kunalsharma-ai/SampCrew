import { z } from 'zod';
import { REQUEST_FILE_FORMAT_KEYS, type DocumentRequestStatus, type RequestFileFormat } from './document-center';

/**
 * Onboarding documents (issue #89): the Super Workspace's library of documents a new joiner may be asked for, grouped
 * in categories, and templates that pick from it. HR assigns a checklist from a template when adding an employee; each
 * item becomes a document request (the same record the employee's My Tasks, the HR approval queue and the document
 * repository read), so both sides always show the same status. Nothing counts as done before HR approves it.
 */

export const ONBOARDING_REQUIREMENTS = ['mandatory', 'conditional', 'optional', 'role_specific'] as const;
export type OnboardingRequirement = (typeof ONBOARDING_REQUIREMENTS)[number];
export const ONBOARDING_REQUIREMENT_LABEL: Record<OnboardingRequirement, string> = {
  mandatory: 'Mandatory', conditional: 'Conditional', optional: 'Optional', role_specific: 'Role-specific',
};

/** The statuses people see for one assigned document. */
export const ONBOARDING_DOC_STATUSES = ['not_assigned', 'assigned', 'not_submitted', 'pending_hr_approval', 'approved', 'rejected', 'resubmission_required', 'cancelled'] as const;
export type OnboardingDocStatus = (typeof ONBOARDING_DOC_STATUSES)[number];
export const ONBOARDING_DOC_STATUS_LABEL: Record<OnboardingDocStatus, string> = {
  not_assigned: 'Not Assigned', assigned: 'Assigned', not_submitted: 'Not Submitted', pending_hr_approval: 'Pending HR Approval', approved: 'Approved',
  rejected: 'Rejected', resubmission_required: 'Resubmission Required', cancelled: 'Removed',
};

/** The document request's status as an onboarding status. Approved only after HR approves (never on upload). */
export function onboardingDocStatus(status: DocumentRequestStatus, opened = false): OnboardingDocStatus {
  switch (status) {
    case 'new_request': return opened ? 'not_submitted' : 'assigned';
    case 'pending_submission': return 'not_submitted';
    case 'submitted': case 'resubmitted': case 'under_verification': return 'pending_hr_approval';
    case 'completed': return 'approved';
    case 'rejected': return 'rejected';
    case 'correction_required': return 'resubmission_required';
    default: return 'cancelled';
  }
}

export interface ChecklistProgress {
  total: number; mandatory: number; submitted: number; pendingApproval: number; approved: number; mandatoryApproved: number; notSubmitted: number; rejected: number;
  /** Approved mandatory documents out of all mandatory ones (all documents when none is mandatory). */
  percent: number;
  /** Every mandatory document (or every document when none is mandatory) approved by HR. */
  complete: boolean;
}

/** Counts for one checklist from its items' statuses. Cancelled items do not count. */
export function checklistProgress(items: { status: OnboardingDocStatus; mandatory: boolean }[]): ChecklistProgress {
  const live = items.filter((i) => i.status !== 'cancelled' && i.status !== 'not_assigned');
  const mand = live.filter((i) => i.mandatory);
  const basis = mand.length ? mand : live;
  const approvedOf = (l: typeof live) => l.filter((i) => i.status === 'approved').length;
  const done = approvedOf(basis);
  return {
    total: live.length,
    mandatory: mand.length,
    submitted: live.filter((i) => i.status === 'pending_hr_approval' || i.status === 'approved').length,
    pendingApproval: live.filter((i) => i.status === 'pending_hr_approval').length,
    approved: approvedOf(live),
    mandatoryApproved: approvedOf(mand),
    notSubmitted: live.filter((i) => i.status === 'assigned' || i.status === 'not_submitted').length,
    rejected: live.filter((i) => i.status === 'rejected' || i.status === 'resubmission_required').length,
    percent: basis.length ? Math.floor((done / basis.length) * 100) : 0,
    complete: basis.length > 0 && done === basis.length,
  };
}

// The default library (prepopulated once per company; the Super Workspace changes it from there) ------------------

export interface LibraryCategoryDef { key: string; letter: string; name: string; description: string }
export interface LibraryItemDef {
  key: string; category: string; name: string; requirement: OnboardingRequirement; description: string; instructions: string;
  formats: RequestFileFormat[]; maxMb: number; multiple: boolean; maxFiles: number; verification: string;
  /** The document type the collected file is filed under in the employee's documents. */
  typeKey: string; sensitive: boolean;
}

export const DEFAULT_LIBRARY_CATEGORIES: readonly LibraryCategoryDef[] = [
  { key: 'identity', letter: 'A', name: 'Identity Verification', description: 'Government identity documents.' },
  { key: 'address', letter: 'B', name: 'Address Verification', description: 'Where the employee lives now and permanently.' },
  { key: 'education', letter: 'C', name: 'Educational Documents', description: 'Marksheets, degrees and certifications.' },
  { key: 'employment_history', letter: 'D', name: 'Employment History and Experience', description: 'Documents from previous employers.' },
  { key: 'banking', letter: 'E', name: 'Banking and Payroll Information', description: 'Where salary is paid.' },
  { key: 'hr_documentation', letter: 'F', name: 'Employment and HR Documentation', description: 'Signed letters, agreements and forms for this job.' },
  { key: 'additional', letter: 'G', name: 'Additional Documents (Conditional)', description: 'Only where the role or the law needs them.' },
];

const PDF_IMG: RequestFileFormat[] = ['pdf', 'image'];
const DOCS: RequestFileFormat[] = ['pdf', 'image', 'word'];
const i = (key: string, category: string, name: string, requirement: OnboardingRequirement, typeKey: string, o: Partial<Omit<LibraryItemDef, 'key' | 'category' | 'name' | 'requirement' | 'typeKey'>> = {}): LibraryItemDef => ({
  key, category, name, requirement, typeKey,
  description: o.description ?? '', instructions: o.instructions ?? 'Upload a clear, complete and readable copy.',
  formats: o.formats ?? PDF_IMG, maxMb: o.maxMb ?? 5, multiple: o.multiple ?? false, maxFiles: o.multiple ? (o.maxFiles ?? 2) : 1,
  verification: o.verification ?? 'Check the name and details match the employee record.', sensitive: o.sensitive ?? false,
});

/** The 35 documents of the default library, in order. Sensitive ones are never mandatory by default. */
export const DEFAULT_LIBRARY_ITEMS: readonly LibraryItemDef[] = [
  i('aadhaar', 'identity', 'Aadhaar Card – Front and Back', 'conditional', 'aadhaar', { multiple: true, maxFiles: 2, sensitive: true, description: 'Identity and address proof issued by UIDAI.', instructions: 'Upload the front and the back. You may mask the first 8 digits of the Aadhaar number.', verification: 'Name and date of birth match; only the last 4 digits need to be visible.' }),
  i('pan', 'identity', 'PAN Card', 'mandatory', 'pan', { sensitive: true, description: 'Needed for income tax deduction on salary.', verification: 'Name matches; PAN format is 5 letters, 4 digits, 1 letter.' }),
  i('passport', 'identity', 'Passport', 'optional', 'passport', { multiple: true, maxFiles: 2, sensitive: true, description: 'If available or applicable (for travel or foreign nationals).', instructions: 'Upload the first and last pages.', verification: 'Check the expiry date.' }),
  i('voter_id', 'identity', 'Voter ID', 'optional', 'voter_id', { multiple: true, maxFiles: 2, sensitive: true, description: 'If applicable.' }),
  i('driving_licence', 'identity', 'Driving Licence', 'role_specific', 'driving_licence', { multiple: true, maxFiles: 2, sensitive: true, description: 'If applicable, for roles that drive.', verification: 'Check the validity and vehicle classes.' }),
  i('current_address', 'address', 'Current Residential Address Proof', 'mandatory', 'custom', { description: 'A utility bill, rent agreement or bank statement from the last 3 months.' }),
  i('permanent_address', 'address', 'Permanent Address Proof', 'mandatory', 'custom', { description: 'Where the employee lives permanently, if different.' }),
  i('address_verification', 'address', 'Recent Address Verification Document', 'conditional', 'custom', { description: 'If required by the company, for example after a move.' }),
  i('marksheet_10', 'education', '10th Marksheet and Certificate', 'mandatory', 'marksheet_10', { multiple: true, maxFiles: 2 }),
  i('marksheet_12', 'education', '12th Marksheet and Certificate', 'mandatory', 'marksheet_12', { multiple: true, maxFiles: 2 }),
  i('graduation', 'education', 'Graduation Marksheet and Degree Certificate', 'mandatory', 'graduation', { multiple: true, maxFiles: 10, maxMb: 10, instructions: 'Upload every semester or year marksheet and the degree certificate.' }),
  i('postgraduate', 'education', 'Post-Graduation Certificate', 'optional', 'postgraduate', { multiple: true, maxFiles: 10, maxMb: 10, description: 'If applicable.' }),
  i('professional_certifications', 'education', 'Professional Certifications', 'optional', 'professional_certification', { multiple: true, maxFiles: 10, description: 'If applicable.' }),
  i('experience_letter', 'employment_history', 'Previous Employer Experience Letter', 'conditional', 'experience_letter', { multiple: true, maxFiles: 5, description: 'For each previous employer. Not needed for freshers.' }),
  i('relieving_letter', 'employment_history', 'Relieving Letter', 'conditional', 'relieving_letter', { description: 'From the last employer. Not needed for freshers.' }),
  i('previous_appointment_letter', 'employment_history', 'Previous Employment Appointment Letter', 'optional', 'appointment_letter', { description: 'If required.' }),
  i('salary_slips', 'employment_history', "Last Three Months' Salary Slips", 'optional', 'salary_slip', { multiple: true, maxFiles: 3, sensitive: true, description: 'If required.' }),
  i('form_16', 'employment_history', "Previous Employer's Form 16", 'optional', 'tax_documents', { sensitive: true, formats: ['pdf'], description: 'If required, for tax on salary already paid this year.' }),
  i('bank_proof', 'banking', 'Bank Account Proof', 'mandatory', 'bank_details', { sensitive: true, description: 'A bank statement or letter showing the account holder name.' }),
  i('cancelled_cheque', 'banking', 'Cancelled Cheque or Bank Passbook Copy', 'mandatory', 'cancelled_cheque', { sensitive: true }),
  i('bank_ifsc', 'banking', 'Bank Account Number and IFSC Details', 'mandatory', 'bank_details', { sensitive: true, formats: DOCS, description: 'A document or form with the account number and IFSC code.', verification: 'Account holder name matches; IFSC is 11 characters.' }),
  i('resume', 'hr_documentation', 'Updated Resume/CV', 'mandatory', 'resume', { formats: DOCS }),
  i('signed_offer', 'hr_documentation', 'Signed Offer Letter', 'mandatory', 'offer_letter', { formats: ['pdf', 'image'], instructions: 'Sign every page and upload the full letter.' }),
  i('signed_appointment', 'hr_documentation', 'Signed Appointment Letter', 'mandatory', 'appointment_letter', { formats: ['pdf', 'image'] }),
  i('signed_agreement', 'hr_documentation', 'Signed Employment Agreement', 'conditional', 'employment_agreement', { formats: ['pdf'], description: 'If applicable.' }),
  i('signed_nda', 'hr_documentation', 'Signed NDA/Confidentiality Agreement', 'conditional', 'custom', { formats: ['pdf'], description: 'If applicable.' }),
  i('employee_information_form', 'hr_documentation', 'Employee Information Form', 'mandatory', 'info_agreement', { formats: DOCS }),
  i('emergency_contacts', 'hr_documentation', 'Emergency Contact Details', 'mandatory', 'custom', { formats: DOCS, description: 'Name, relation and phone number of at least one person.' }),
  i('photograph', 'hr_documentation', 'Recent Passport-Size Photograph', 'mandatory', 'custom', { formats: ['image'], maxMb: 2, description: 'A recent photo on a plain background.' }),
  i('code_of_conduct', 'hr_documentation', 'Signed Code of Conduct and Company Policies Acknowledgement', 'mandatory', 'custom', { formats: ['pdf', 'image'] }),
  i('police_verification', 'additional', 'Police Verification Certificate', 'conditional', 'custom', { sensitive: true, description: 'If required for the role or by law.' }),
  i('medical_fitness', 'additional', 'Medical Fitness Certificate', 'conditional', 'custom', { sensitive: true, description: 'If legally or operationally required.' }),
  i('accommodation', 'additional', 'Disability-related Workplace Accommodation Documentation', 'optional', 'custom', { sensitive: true, description: 'Only where voluntarily and appropriately provided. Never required.', verification: 'Shared only with the people who arrange the accommodation.' }),
  i('professional_licence', 'additional', 'Professional Licence or Registration Certificate', 'role_specific', 'custom', { description: 'If applicable (for example a medical, legal or engineering registration).', verification: 'Check the validity with the issuing body.' }),
  i('role_compliance', 'additional', 'Other Role-Specific Compliance Documents', 'role_specific', 'custom', { multiple: true, maxFiles: 5, formats: DOCS }),
];

export interface TemplateDef { key: string; name: string; description: string; employmentTypes: string[]; items: string[]; isDefault?: boolean }
const CORE = ['pan', 'current_address', 'permanent_address', 'bank_proof', 'cancelled_cheque', 'bank_ifsc', 'resume', 'signed_offer', 'signed_appointment', 'employee_information_form', 'emergency_contacts', 'photograph', 'code_of_conduct'];
const EDU = ['marksheet_10', 'marksheet_12', 'graduation'];
const EXP = ['experience_letter', 'relieving_letter'];
export const DEFAULT_TEMPLATES: readonly TemplateDef[] = [
  { key: 'standard', name: 'Standard Employee Onboarding', description: 'The everyday checklist for most new joiners.', employmentTypes: [], items: [...CORE, ...EDU, 'aadhaar'], isDefault: true },
  { key: 'full_time', name: 'Full-Time Employee Onboarding', description: 'Full-time joiners with previous employment.', employmentTypes: ['full_time'], items: [...CORE, ...EDU, ...EXP, 'aadhaar', 'signed_agreement', 'signed_nda', 'salary_slips', 'form_16'] },
  { key: 'part_time', name: 'Part-Time Employee Onboarding', description: 'Part-time joiners.', employmentTypes: ['part_time'], items: [...CORE, 'graduation', 'aadhaar'] },
  { key: 'intern', name: 'Intern Onboarding', description: 'Interns and trainees: education instead of employment history.', employmentTypes: ['intern'], items: ['pan', 'current_address', 'bank_proof', 'cancelled_cheque', 'bank_ifsc', 'resume', 'signed_offer', 'emergency_contacts', 'photograph', 'code_of_conduct', ...EDU, 'aadhaar'] },
  { key: 'contract', name: 'Contract Employee Onboarding', description: 'Fixed-term and contract staff.', employmentTypes: ['contract', 'temporary'], items: ['pan', 'current_address', 'bank_proof', 'cancelled_cheque', 'bank_ifsc', 'resume', 'signed_agreement', 'signed_nda', 'emergency_contacts', 'photograph', 'code_of_conduct', 'aadhaar'] },
  { key: 'remote', name: 'Remote Employee Onboarding', description: 'People who work from home or another city.', employmentTypes: [], items: [...CORE, ...EDU, 'aadhaar', 'address_verification', 'signed_nda'] },
  { key: 'senior_management', name: 'Senior Management Onboarding', description: 'Leadership hires: full history and agreements.', employmentTypes: [], items: [...CORE, ...EDU, ...EXP, 'postgraduate', 'professional_certifications', 'previous_appointment_letter', 'salary_slips', 'form_16', 'signed_agreement', 'signed_nda', 'aadhaar', 'passport', 'police_verification'] },
  { key: 'department_specific', name: 'Department-Specific Onboarding', description: 'Map this to a department and add the documents it needs (licences, compliance).', employmentTypes: [], items: [...CORE, ...EDU, 'professional_licence', 'role_compliance', 'aadhaar'] },
];

// Inputs -----------------------------------------------------------------------------------------------------------

const name = z.string().trim().min(2).max(160);
const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);

export const libraryCategoryInput = z.object({ name: z.string().trim().min(2).max(80), description: text(300), sort: z.number().int().min(0).max(999).optional() });
export const libraryItemInput = z.object({
  categoryId: z.uuid(),
  name,
  requirement: z.enum(ONBOARDING_REQUIREMENTS),
  description: text(600),
  instructions: text(600),
  formats: z.array(z.enum(REQUEST_FILE_FORMAT_KEYS as [RequestFileFormat, ...RequestFileFormat[]])).min(1).max(4),
  maxMb: z.number().int().min(1).max(25),
  multiple: z.boolean().default(false),
  maxFiles: z.number().int().min(1).max(10).default(1),
  verification: text(600),
  sensitive: z.boolean().default(false),
  active: z.boolean().default(true),
}).refine((v) => v.multiple || v.maxFiles === 1, { message: 'A document with one file takes one file', path: ['maxFiles'] })
  .refine((v) => !v.multiple || v.maxFiles >= 2, { message: 'Allow at least 2 files when several are needed', path: ['maxFiles'] });
export type LibraryItemInput = z.infer<typeof libraryItemInput>;

export const libraryTemplateInput = z.object({
  name,
  description: text(400),
  items: z.array(z.object({ itemId: z.uuid(), required: z.boolean() })).min(1).max(60)
    .refine((l) => new Set(l.map((x) => x.itemId)).size === l.length, 'Each document once'),
  departmentIds: z.array(z.uuid()).max(100).default([]),
  employmentTypes: z.array(z.enum(['full_time', 'part_time', 'contract', 'intern', 'temporary'])).max(5).default([]),
  isDefault: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type LibraryTemplateInput = z.infer<typeof libraryTemplateInput>;

/** The checklist HR assigns: a template and the documents chosen from it (or straight from the library). */
export const assignChecklistInput = z.object({
  templateId: z.uuid().nullable().default(null),
  /** The documents to ask for; mandatory ones of the template cannot be left out. */
  itemIds: z.array(z.uuid()).min(1).max(60).refine((l) => new Set(l).size === l.length, 'Each document once'),
  dueOn: z.iso.date().nullable().optional(),
  note: text(600),
});
export type AssignChecklistInput = z.infer<typeof assignChecklistInput>;

/** HR asks the Super Workspace for a document the library does not have, or for permission to manage it. */
export const libraryRequestInput = z.object({
  kind: z.enum(['document', 'permission']),
  name: z.string().trim().max(160).optional(),
  categoryId: z.uuid().nullable().optional(),
  requirement: z.enum(ONBOARDING_REQUIREMENTS).optional(),
  reason: z.string().trim().min(5).max(600),
}).refine((v) => v.kind === 'permission' || (v.name ?? '').length >= 2, { message: 'Name the document', path: ['name'] });
export const libraryRequestDecision = z.object({ decision: z.enum(['approve', 'decline']), note: text(600) });

/**
 * Whether a person may make this document mandatory: the Super Workspace always; HR only with the library permission,
 * and then never a sensitive document (Aadhaar, bank details, medical) without the Super Workspace.
 */
export function mayRequireDocument(level: 'super' | 'hr', item: { sensitive: boolean }, canManage: boolean): boolean {
  if (level === 'super') return true;
  return canManage && !item.sensitive;
}
