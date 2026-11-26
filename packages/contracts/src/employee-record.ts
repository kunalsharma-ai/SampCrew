import { z } from 'zod';

/**
 * The employee record (issue #86, HR feedback of 25 November 2026): every detail and document HR keeps for a person,
 * with a completion score that says what is still pending. Most items come from the places they already live (the
 * employee, the profile, bank and identity details, salary, documents); the rest are kept with the record itself.
 */

export const WORK_STATUSES = ['working', 'on_notice', 'on_long_leave', 'inactive', 'left'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export const WORK_STATUS_LABEL: Record<WorkStatus, string> = { working: 'Working', on_notice: 'On notice', on_long_leave: 'On long leave', inactive: 'Inactive', left: 'Left the company' };

const opt = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
const money = z.union([z.number(), z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Use an amount such as 600000 or 50000.50')]).nullable().optional()
  .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : Number(v)));

/** The record's own fields (everything else is edited where it already lives). Leave a field out to keep it. */
export const employeeRecordInput = z.object({
  fatherName: opt(120),
  motherName: opt(120),
  /** A parent's Aadhaar number (12 digits); stored encrypted, shown masked. */
  parentAadhaar: z.string().trim().regex(/^(\d{4}\s?\d{4}\s?\d{4})?$/, 'Use the 12-digit Aadhaar number').nullable().optional().transform((v) => (v ? v.replace(/\s/g, '') : v === '' ? null : v)),
  parentsAddress: opt(400),
  gatePassId: opt(60),
  workStatus: z.enum(WORK_STATUSES).nullable().optional(),
  ctcAnnual: money,
  ctcAnnualInHand: money,
  ctcMonthlyFixed: money,
  anyDetails: opt(2000),
}).strict();
export type EmployeeRecordInput = z.infer<typeof employeeRecordInput>;

/** The documents the record asks for, by document type (contracts BUILT_IN_DOCUMENT_TYPES); any one of `types` counts. */
export const RECORD_DOCUMENTS = [
  { key: 'resume', label: 'Resume', types: ['resume'] },
  { key: 'school', label: 'School certificate (10th or 12th)', types: ['marksheet_10', 'marksheet_12'] },
  { key: 'graduation', label: 'Graduation certificate', types: ['graduation'] },
  { key: 'postgraduate', label: 'Post graduation certificate', types: ['postgraduate'], optional: true },
  { key: 'aadhaar', label: 'Aadhaar card', types: ['aadhaar'] },
  { key: 'pan', label: 'PAN card', types: ['pan'] },
  { key: 'offer_letter', label: 'Offer letter', types: ['offer_letter'] },
  { key: 'info_agreement', label: 'Information agreement', types: ['info_agreement'] },
  { key: 'previous_verification', label: 'Previous company verification', types: ['previous_company_verification'], optional: true },
  { key: 'experience', label: 'Experience letter', types: ['experience_letter', 'relieving_letter'], optional: true },
  { key: 'cloud_verification', label: 'Cloud verification document', types: ['cloud_verification'] },
] as const;

export interface RecordItem {
  key: string;
  label: string;
  group: 'identity' | 'job' | 'pay' | 'contact' | 'family' | 'bank' | 'emergency' | 'documents';
  done: boolean;
  /** Not counted in the score when empty (for example Last working day for someone still working). */
  optional: boolean;
  /** What is shown (masked where sensitive); null when empty or not visible to this viewer. */
  value: string | null;
  /** Where to fill it in (a page and tab), when it lives elsewhere. */
  href: string | null;
}

export interface EmployeeRecord {
  employeeId: string;
  /** Completion: required items filled, out of all required items, as a whole percent. */
  score: number;
  done: number;
  total: number;
  items: RecordItem[];
  /** The record's own values for the edit form (CTC only for people who may see pay). */
  values: {
    fatherName: string | null; motherName: string | null; parentAadhaarMasked: string | null; parentsAddress: string | null; gatePassId: string | null;
    workStatus: WorkStatus | null; ctcAnnual: number | null; ctcAnnualInHand: number | null; ctcMonthlyFixed: number | null; anyDetails: string | null;
  };
  can: { edit: boolean; seePay: boolean; uploadDocuments: boolean };
}

/** Score of a set of items (required ones only). */
export function recordScore(items: Pick<RecordItem, 'done' | 'optional'>[]): { score: number; done: number; total: number } {
  const counted = items.filter((i) => !i.optional || i.done);
  const done = counted.filter((i) => i.done).length;
  return { done, total: counted.length, score: counted.length ? Math.round((done / counted.length) * 100) : 100 };
}
