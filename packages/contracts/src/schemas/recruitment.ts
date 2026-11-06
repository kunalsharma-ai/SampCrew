import { z } from 'zod';
import { currencyCode, email, slug } from './common';
import { EMPLOYMENT_TYPES, isoDate } from './people';

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).optional();
const money = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use an amount such as 1200000 or 1200000.50');
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'Enter a phone number with digits, spaces or +');
const url = z
  .string()
  .trim()
  .max(500)
  .url('Enter a full link starting with https://')
  .refine((u) => /^https?:\/\//i.test(u), 'Enter a full link starting with https://');

// Requisitions --------------------------------------------------------------------------------------------

export const REQUISITION_STATUSES = ['draft', 'pending_approval', 'approved', 'open', 'on_hold', 'filled', 'closed', 'cancelled', 'rejected'] as const;
export const REQUISITION_REASONS = ['new_role', 'replacement'] as const;
export const WORK_MODES = ['onsite', 'hybrid', 'remote'] as const;

export const requisitionInput = z
  .object({
    title: z.string().trim().min(2).max(120),
    legalEntityId: z.uuid(),
    departmentId: z.uuid(),
    locationId: z.uuid().nullable().default(null),
    designationId: z.uuid().nullable().default(null),
    hiringManagerMembershipId: z.uuid(),
    employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
    workMode: z.enum(WORK_MODES).default('onsite'),
    headcount: z.number().int().min(1).max(500).default(1),
    reason: z.enum(REQUISITION_REASONS).default('new_role'),
    replacingEmployeeId: z.uuid().nullable().default(null),
    salaryMin: money.nullable().default(null),
    salaryMax: money.nullable().default(null),
    currency: currencyCode,
    targetStartDate: isoDate.nullable().default(null),
    justification: text(2000).default(''),
    description: text(20000).default(''),
    /** What interviewers rate. Each interviewer scores every criterion from 1 to 4. */
    scorecard: z.array(z.string().trim().min(2).max(80)).min(1).max(12).default(['Role skills', 'Problem solving', 'Communication', 'Team fit']),
  })
  .refine((v) => v.salaryMin === null || v.salaryMax === null || Number(v.salaryMin) <= Number(v.salaryMax), { message: 'The minimum is above the maximum', path: ['salaryMax'] })
  .refine((v) => v.reason !== 'replacement' || !!v.replacingEmployeeId, { message: 'Choose who this role replaces', path: ['replacingEmployeeId'] });
export type RequisitionInput = z.infer<typeof requisitionInput>;

export const requisitionStatusInput = z.object({
  action: z.enum(['open', 'hold', 'reopen', 'close', 'cancel']),
  reason: optionalText(500),
});

export const postingInput = z.object({
  publicTitle: z.string().trim().min(2).max(120),
  slug,
  summary: text(400).default(''),
  description: z.string().trim().min(20, 'Describe the role in at least a few sentences').max(20000),
  locationText: text(120).default(''),
  showSalary: z.boolean().default(false),
});
export type PostingInput = z.infer<typeof postingInput>;

// Candidates and applications -----------------------------------------------------------------------------

export const CANDIDATE_SOURCES = ['career_site', 'referral', 'agency', 'sourced', 'manual'] as const;
export const APPLICATION_STATUSES = ['active', 'rejected', 'withdrawn', 'hired'] as const;
export const CANDIDATE_SORTS = ['activity', 'name', 'added'] as const;
/** The candidate list: search, tag, job, source, where their applications stand, and the order. */
export const candidateListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(30).optional(),
  requisitionId: z.uuid().optional(),
  source: z.enum(CANDIDATE_SOURCES).optional(),
  /** Candidates with an application in this state; "none" for people not in any job. */
  status: z.enum([...APPLICATION_STATUSES, 'none']).optional(),
  sort: z.enum(CANDIDATE_SORTS).default('activity'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type CandidateListQuery = z.infer<typeof candidateListQuery>;
export const STAGE_KINDS = ['new', 'screen', 'interview', 'offer', 'hired'] as const;

export const candidateInput = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(''),
  email,
  phone: phone.optional(),
  locationText: optionalText(120),
  currentTitle: optionalText(120),
  currentCompany: optionalText(120),
  profileUrl: url.optional(),
  source: z.enum(CANDIDATE_SOURCES).default('manual'),
  sourceDetail: optionalText(120),
  referredByMembershipId: z.uuid().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  /** Apply to this requisition straight away. */
  requisitionId: z.uuid().optional(),
  /**
   * Recruiters adding someone by hand confirm they have a lawful basis to hold the person's details (for example
   * the candidate sent their CV). The career site records the candidate's own consent instead.
   */
  lawfulBasisConfirmed: z.literal(true, { message: 'Confirm you may store this person’s details' }),
});
export type CandidateInput = z.infer<typeof candidateInput>;

export const candidatePatch = candidateInput
  .omit({ requisitionId: true, lawfulBasisConfirmed: true, source: true, referredByMembershipId: true })
  .partial()
  .strict();

export const applyInput = z.object({ requisitionId: z.uuid() });

export const moveStageInput = z.object({ stageId: z.uuid(), note: optionalText(2000) });

export const REJECTION_REASONS = ['not_qualified', 'better_candidate', 'salary', 'location', 'no_show', 'withdrew', 'position_closed', 'other'] as const;
export const rejectInput = z.object({
  reason: z.enum(REJECTION_REASONS),
  note: optionalText(2000),
  /** Queue a short, neutral rejection email to the candidate. */
  notifyCandidate: z.boolean().default(false),
});

/**
 * One action on several applications for the same job: move them to a stage, reject them (optionally telling each
 * candidate), or email them. In emails, {firstName} and {jobTitle} are filled in per candidate.
 */
export const bulkApplicationsInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('move'), applicationIds: z.array(z.uuid()).min(1).max(100), stageId: z.uuid(), note: optionalText(2000) }).strict(),
  z.object({ action: z.literal('reject'), applicationIds: z.array(z.uuid()).min(1).max(100), reason: z.enum(REJECTION_REASONS), note: optionalText(2000), notifyCandidate: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('email'), applicationIds: z.array(z.uuid()).min(1).max(100), subject: z.string().trim().min(3).max(200), message: z.string().trim().min(10).max(5000) }).strict(),
]);
export type BulkApplicationsInput = z.infer<typeof bulkApplicationsInput>;

/** Fills {firstName} and {jobTitle} in a bulk email. Unknown placeholders are left as typed. */
export function fillCandidateEmail(text: string, v: { firstName: string; jobTitle: string }) {
  return text.replace(/\{(firstName|jobTitle)\}/g, (_m, k: 'firstName' | 'jobTitle') => v[k]);
}

export const noteInput = z.object({ body: z.string().trim().min(1).max(5000) });

export const applicationListQuery = z.object({
  requisitionId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  q: z.string().trim().max(120).optional(),
});

// Interviews and feedback ---------------------------------------------------------------------------------

export const INTERVIEW_MODES = ['in_person', 'video', 'phone'] as const;
export const RECOMMENDATIONS = ['strong_no', 'no', 'yes', 'strong_yes'] as const;

export const interviewInput = z
  .object({
    title: z.string().trim().min(2).max(120),
    startsAt: z.iso.datetime({ offset: true, message: 'Use a date and time' }),
    durationMinutes: z.number().int().min(10).max(480).default(45),
    mode: z.enum(INTERVIEW_MODES).default('video'),
    /** A meeting link the organiser created in their own tool; SampCrew does not create meetings. */
    meetingUrl: url.optional(),
    locationText: optionalText(200),
    panelMembershipIds: z.array(z.uuid()).min(1, 'Add at least one interviewer').max(10),
    /** Queue an invitation email to the candidate with the time and joining details. */
    notifyCandidate: z.boolean().default(true),
  })
  .refine((v) => v.mode !== 'video' || !!v.meetingUrl, { message: 'Add the meeting link for a video interview', path: ['meetingUrl'] })
  .refine((v) => v.mode !== 'in_person' || !!v.locationText, { message: 'Add where the interview takes place', path: ['locationText'] });
export type InterviewInput = z.infer<typeof interviewInput>;

export const feedbackInput = z.object({
  ratings: z.array(z.object({ criterion: z.string().trim().min(1).max(80), score: z.number().int().min(1).max(4), note: optionalText(1000) })).min(1).max(12),
  recommendation: z.enum(RECOMMENDATIONS),
  summary: z.string().trim().min(10, 'Write at least a sentence on why').max(5000),
});
export type FeedbackInput = z.infer<typeof feedbackInput>;

// Offers --------------------------------------------------------------------------------------------------

export const OFFER_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'withdrawn', 'rejected'] as const;
export const PAY_PERIODS = ['annual', 'monthly', 'hourly'] as const;

export const offerInput = z.object({
  jobTitle: z.string().trim().min(2).max(120),
  designationId: z.uuid().nullable().default(null),
  baseSalary: money,
  currency: currencyCode,
  payPeriod: z.enum(PAY_PERIODS).default('annual'),
  variablePay: optionalText(300),
  joiningDate: isoDate,
  expiresOn: isoDate,
  notes: optionalText(2000),
});
export type OfferInput = z.infer<typeof offerInput>;

export const offerResponseInput = z.object({
  response: z.enum(['accepted', 'declined']),
  note: optionalText(1000),
});

export const hireInput = z.object({
  workEmail: email.optional(),
  inviteToCrew: z.boolean().default(false),
  probationMonths: z.number().int().min(0).max(24).default(6),
  dateOfJoining: isoDate.optional(),
});

// Settings and the career site ----------------------------------------------------------------------------

export const stageInput = z.object({
  name: z.string().trim().min(2).max(40),
  kind: z.enum(STAGE_KINDS),
});
export const stageOrderInput = z.object({ stageIds: z.array(z.uuid()).min(2).max(20) });

export const careerSiteInput = z.object({
  enabled: z.boolean(),
  slug,
  headline: z.string().trim().min(2).max(120),
  intro: text(2000).default(''),
  /** Shown above the apply button and stored with each application as what the candidate agreed to. */
  privacyNotice: z.string().trim().min(40, 'Explain how applicants’ data is used, in at least a couple of sentences').max(4000),
  /** Candidates with no open application are anonymised this many days after their last activity. */
  retentionDays: z.number().int().min(30).max(1825).default(365),
});
export type CareerSiteInput = z.infer<typeof careerSiteInput>;

/** Public apply form. Files come as multipart; these are the text fields. */
export const publicApplyInput = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(''),
  email,
  phone: phone.optional(),
  locationText: optionalText(120),
  profileUrl: url.optional(),
  coverNote: optionalText(3000),
  consent: z.literal('true', { message: 'Please agree to the privacy notice to apply' }),
  /** Honeypot: real people leave this empty. */
  website: z.string().max(500).optional(),
});
export type PublicApplyInput = z.infer<typeof publicApplyInput>;

export const RESUME_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;
export const RESUME_MAX_BYTES = 5 * 1024 * 1024;
