import { z } from 'zod';
import { phoneNumber } from './phone';
import { email } from './schemas/common';
import { GENDERS } from './schemas/people';

/**
 * The complete employee profile: personal, contact and address, education, previous employment, skills, bank and
 * identity details. Employees change their own profile by submitting a profile update, which HR approves before it
 * touches the official record; protected official information (employee ID, job, manager, salary, status) is never
 * part of a profile update. Bank and identity numbers are stored encrypted and shown masked.
 */

export const PROFILE_SECTIONS = ['personal', 'address', 'emergency', 'education', 'employment', 'skills', 'bank', 'identity'] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];
export const PROFILE_SECTION_LABELS: Record<ProfileSection, string> = {
  personal: 'Personal details', address: 'Address', emergency: 'Emergency contacts', education: 'Education',
  employment: 'Previous employment', skills: 'Skills & languages', bank: 'Bank details', identity: 'Identity numbers',
};
/** Sections holding numbers that are encrypted at rest and masked on screen. */
export const SENSITIVE_SECTIONS: ProfileSection[] = ['bank', 'identity'];

export const PROFILE_CHANGE_STATUSES = ['pending', 'approved', 'rejected', 'info_requested', 'cancelled', 'superseded'] as const;
export type ProfileChangeStatus = (typeof PROFILE_CHANGE_STATUSES)[number];

const text = (max: number) => z.string().trim().max(max);
const opt = (max: number) => text(max).nullable().default(null).transform((v) => (v === '' ? null : v));
const year = z.number().int().min(1950).max(2100);
const percent = z.number().min(0).max(100).nullable().default(null);
const date = z.iso.date('Use a date in YYYY-MM-DD format');

export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed', 'undisclosed'] as const;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

export const personalSection = z.object({
  firstName: text(80).min(1, 'Enter the first name'),
  /** Legal middle name, if any (issue #86: the profile shows the legal name, first, middle and last). */
  middleName: opt(80),
  lastName: text(80).default(''),
  preferredName: opt(80),
  dateOfBirth: date.nullable().default(null),
  gender: z.enum(GENDERS).nullable().default(null),
  personalEmail: email.nullable().default(null),
  phone: phoneNumber.nullable().default(null),
  nationality: opt(60),
  maritalStatus: z.enum(MARITAL_STATUSES).nullable().default(null),
  bloodGroup: z.enum(BLOOD_GROUPS).nullable().default(null),
});

export const postalAddress = z.object({
  line1: text(200).default(''),
  line2: text(200).default(''),
  city: text(80).default(''),
  state: text(80).default(''),
  postalCode: text(12).default(''),
  country: text(60).default(''),
});
export type PostalAddress = z.infer<typeof postalAddress>;
export const addressSection = z.object({
  current: postalAddress,
  permanentSameAsCurrent: z.boolean().default(true),
  permanent: postalAddress.nullable().default(null),
});

export const emergencyContact = z.object({ name: text(120).min(1, 'Enter the contact name'), relationship: text(60).min(1, 'Say how they are related'), phone: phoneNumber, email: email.nullable().default(null) });
export const emergencySection = z.object({ contacts: z.array(emergencyContact).max(3) });

export const EDUCATION_LEVELS = ['10th', '12th', 'diploma', 'graduation', 'post_graduation', 'doctorate', 'certification', 'other'] as const;
export const EDUCATION_LEVEL_LABELS: Record<(typeof EDUCATION_LEVELS)[number], string> = {
  '10th': '10th standard', '12th': '12th standard', diploma: 'Diploma', graduation: 'Graduation', post_graduation: 'Post-graduation',
  doctorate: 'Doctorate', certification: 'Professional certification', other: 'Other',
};
export const educationRecord = z.object({
  level: z.enum(EDUCATION_LEVELS),
  degree: opt(120),
  institution: text(160).min(1, 'Enter the school, university or institute'),
  yearCompleted: year.nullable().default(null),
  percentage: percent,
  /** A document in the employee's documents (a certificate or mark sheet). */
  documentId: z.uuid().nullable().default(null),
});
export const educationSection = z.object({
  highestQualification: opt(120),
  records: z.array(educationRecord).max(20),
});

export const employmentRecord = z.object({
  company: text(160).min(1, 'Enter the company name'),
  designation: opt(120),
  from: date,
  to: date.nullable().default(null),
  lastSalary: z.number().min(0).max(1e10).nullable().default(null),
  reasonForLeaving: opt(300),
  documentId: z.uuid().nullable().default(null),
});
export const employmentSection = z
  .object({ totalExperienceMonths: z.number().int().min(0).max(720).nullable().default(null), records: z.array(employmentRecord).max(20) })
  .superRefine((v, ctx) => v.records.forEach((r, i) => { if (r.to && r.to < r.from) ctx.addIssue({ code: 'custom', path: ['records', i, 'to'], message: 'Ends before it starts' }); }));

const list = (max: number) => z.array(text(80).min(1)).max(max).default([]);
export const skillsSection = z.object({ skills: list(40), languages: list(15), certifications: list(30) });

export const ACCOUNT_TYPES = ['savings', 'current', 'salary', 'nre', 'nro', 'other'] as const;
export const bankSection = z.object({
  accountHolderName: text(120).min(1, 'Enter the account holder name'),
  bankName: text(120).min(1, 'Enter the bank name'),
  accountNumber: text(34).regex(/^[0-9A-Z]{4,34}$/i, 'Account numbers use letters and digits only, no spaces'),
  ifsc: text(15).regex(/^[0-9A-Z-]{4,15}$/i, 'Enter the IFSC (or sort code / routing number outside India)'),
  branchName: opt(120),
  accountType: z.enum(ACCOUNT_TYPES).default('savings'),
});

export const AADHAAR = /^\d{12}$/;
export const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
export const identitySection = z.object({
  aadhaar: text(14).transform((v) => v.replace(/\s/g, '')).pipe(z.string().regex(AADHAAR, 'Aadhaar has 12 digits')).nullable().default(null),
  pan: text(10).transform((v) => v.toUpperCase()).pipe(z.string().regex(PAN, 'PAN looks like ABCDE1234F')).nullable().default(null),
  otherIdType: opt(60),
  otherIdNumber: opt(40),
  /** Uploaded identity and address proof documents. */
  identityDocumentId: z.uuid().nullable().default(null),
  addressProofDocumentId: z.uuid().nullable().default(null),
});

export const PROFILE_SECTION_SCHEMAS = {
  personal: personalSection, address: addressSection, emergency: emergencySection, education: educationSection,
  employment: employmentSection, skills: skillsSection, bank: bankSection, identity: identitySection,
} as const;
export type ProfileSectionData<S extends ProfileSection> = z.infer<(typeof PROFILE_SECTION_SCHEMAS)[S]>;

/** A profile update: the employee's new values for one section. */
export const profileChangeInput = z.object({
  section: z.enum(PROFILE_SECTIONS),
  data: z.record(z.string(), z.unknown()),
  note: text(500).nullable().optional(),
});
export const profileDecisionInput = z
  .object({ decision: z.enum(['approve', 'reject', 'request_info']), remarks: text(1000).nullable().optional() })
  .superRefine((v, ctx) => {
    if (v.decision !== 'approve' && !v.remarks?.trim()) ctx.addIssue({ code: 'custom', path: ['remarks'], message: v.decision === 'reject' ? 'Say why so the employee can fix it' : 'Say what information you need' });
  });
export const profileChangesQuery = z.object({ status: z.enum(['pending', 'all']).default('pending') });

/** Shows the last four characters only, such as XXXX XXXX 1234. */
export function mask(value: string | null | undefined, keep = 4): string | null {
  if (!value) return null;
  const v = value.replace(/\s/g, '');
  if (v.length <= keep) return '•'.repeat(v.length);
  return `${'•'.repeat(Math.min(8, v.length - keep))}${v.slice(-keep)}`;
}

/** How complete a profile is, by the sections that hold something. */
export function profileCompleteness(filled: Partial<Record<ProfileSection, boolean>>): number {
  const n = PROFILE_SECTIONS.filter((s) => filled[s]).length;
  return Math.round((n / PROFILE_SECTIONS.length) * 100);
}
