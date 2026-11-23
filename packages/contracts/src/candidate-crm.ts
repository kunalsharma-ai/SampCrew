import { z } from 'zod';
import { checkPhone, optionalPhone } from './phone';
import { isoDate } from './schemas/people';

/**
 * Candidate CRM (Recruitment & ATS > Candidate CRM): the company's one candidate database, worked like a sales CRM.
 * The candidate record is the existing ATS candidate (one per person per company); the CRM adds the full profile,
 * recruiter remarks, references, documents, activities, follow-ups, a relationship pipeline, custom fields, imports
 * and exports. Job applications stay the ATS's own records, so one candidate can be in several jobs.
 *
 * Access: Super Workspace always has it and switches it on or off for each HR Workspace (and the company-wide HR team,
 * "central"), with the extra powers each may use. Employee Workspace never gets it. Every rule here is enforced by the
 * API; the lists below are shared so the forms and the server agree.
 */

// ---------------------------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------------------------

/** Extra powers Super Workspace can give an HR Workspace on top of working with candidates. */
export const CRM_CAPS = ['fields', 'import', 'export', 'archive', 'sensitive'] as const;
export type CrmCap = (typeof CRM_CAPS)[number];
export const CRM_CAP_LABEL: Record<CrmCap, string> = {
  fields: 'Create custom fields',
  import: 'Import candidates',
  export: 'Export candidates',
  archive: 'Archive and delete',
  sensitive: 'See restricted remarks and personal details',
};
export const CRM_CAP_HELP: Record<CrmCap, string> = {
  fields: 'Add its own fields to the candidate form. Fields made by one HR Workspace are used only by it.',
  import: 'Bring in candidates from Excel or CSV files.',
  export: 'Download candidate lists as Excel. Every export is logged.',
  archive: 'Archive candidates and delete documents.',
  sensitive: 'Gender, date of birth, nationality and remarks marked restricted.',
};

/** The access key of the company-wide HR team (HR Workspace level not limited to named HR Workspaces). */
export const CRM_CENTRAL = 'central';

export const crmAccessInput = z.object({
  changes: z.array(z.object({
    /** An HR Workspace id, or "central" for the company-wide HR team. */
    key: z.union([z.uuid(), z.literal(CRM_CENTRAL)]),
    enabled: z.boolean(),
    caps: z.array(z.enum(CRM_CAPS)).max(CRM_CAPS.length).transform((a) => [...new Set(a)]),
  }).strict()).min(1).max(200),
}).strict();
export type CrmAccessInput = z.infer<typeof crmAccessInput>;

// ---------------------------------------------------------------------------------------------------------------
// Pipeline and lists
// ---------------------------------------------------------------------------------------------------------------

/** open: still in play; won: joined; lost: rejected, not interested or withdrew; paused: on hold. */
export const CRM_STAGE_KINDS = ['open', 'won', 'lost', 'paused'] as const;
export type CrmStageKind = (typeof CRM_STAGE_KINDS)[number];
export interface CrmStage { key: string; label: string; kind: CrmStageKind; active: boolean; position: number; system: boolean }

const S = (key: string, label: string, kind: CrmStageKind = 'open'): Omit<CrmStage, 'position'> => ({ key, label, kind, active: true, system: true });
export const DEFAULT_CRM_STAGES: CrmStage[] = [
  S('new', 'New Candidate'), S('contact_pending', 'Contact Pending'), S('contacted', 'Contacted'), S('interested', 'Interested'),
  S('screening', 'Screening'), S('shortlisted', 'Shortlisted'), S('interview_scheduled', 'Interview Scheduled'),
  S('interview_in_progress', 'Interview in Progress'), S('interview_completed', 'Interview Completed'), S('selected', 'Selected'),
  S('offer_released', 'Offer Released'), S('offer_accepted', 'Offer Accepted'), S('joined', 'Joined', 'won'), S('on_hold', 'On Hold', 'paused'),
  S('rejected', 'Rejected', 'lost'), S('not_interested', 'Not Interested', 'lost'), S('withdrawn', 'Withdrawn', 'lost'),
].map((s, i) => ({ ...s, position: i }));

/**
 * The CRM stage an ATS event moves a candidate to, when the candidate is still earlier in the pipeline. The ATS keeps
 * its own per-job stages; this keeps the relationship view in step without anyone moving the card twice.
 */
export const ATS_EVENT_CRM_STAGE: Record<string, string> = {
  interview_scheduled: 'interview_scheduled',
  feedback_submitted: 'interview_completed',
  offer_sent: 'offer_released',
  offer_accepted: 'offer_accepted',
  hired: 'joined',
};

export const CRM_SOURCES_DEFAULT = [
  ['job_portal', 'Job Portal'], ['linkedin', 'LinkedIn'], ['company_website', 'Company Website'], ['career_site', 'Career site'],
  ['employee_referral', 'Employee Referral'], ['candidate_referral', 'Existing Candidate Referral'], ['client_reference', 'Client Reference'],
  ['consultant', 'Consultant Reference'], ['agency', 'Recruitment Agency'], ['social_media', 'Social Media'], ['walk_in', 'Walk-in'],
  ['cold_call', 'Cold call / sourced'], ['database', 'Existing database'], ['other', 'Other'],
] as const;
export interface CrmOption { key: string; label: string; active: boolean }

/** The ATS's own five sources, for a CRM source (the ATS keeps its enum for jobs and reports). */
export function atsSourceOf(crmSource: string | null | undefined): 'career_site' | 'referral' | 'agency' | 'sourced' | 'manual' {
  if (!crmSource) return 'manual';
  if (crmSource === 'career_site' || crmSource === 'company_website') return 'career_site';
  if (/referral|reference|consultant/.test(crmSource)) return crmSource === 'consultant' ? 'agency' : 'referral';
  if (crmSource === 'agency') return 'agency';
  if (['job_portal', 'linkedin', 'social_media', 'cold_call', 'database'].includes(crmSource)) return 'sourced';
  return 'manual';
}

export const REFERENCE_TYPES = [
  ['employee_referral', 'Employee Referral'], ['candidate_referral', 'Existing Candidate Referral'], ['client_reference', 'Client Reference'],
  ['consultant', 'Consultant Reference'], ['job_portal', 'Job Portal'], ['linkedin', 'LinkedIn'], ['company_website', 'Company Website'],
  ['social_media', 'Social Media'], ['agency', 'Recruitment Agency'], ['walk_in', 'Walk-in'], ['other', 'Other'],
] as const;
export const REFERENCE_RELATIONSHIPS = [
  ['colleague', 'Current or former colleague'], ['manager', 'Former manager'], ['reportee', 'Former reportee'], ['friend', 'Friend'],
  ['family', 'Family'], ['client', 'Client'], ['classmate', 'Classmate'], ['consultant', 'Consultant'], ['other', 'Other'],
] as const;

export const NOTICE_PERIODS = [
  ['immediate', 'Immediate', 0], ['7_days', '7 Days', 7], ['15_days', '15 Days', 15], ['30_days', '30 Days', 30], ['45_days', '45 Days', 45],
  ['60_days', '60 Days', 60], ['90_days', '90 Days', 90], ['more_than_90', 'More than 90 Days', 120], ['negotiable', 'Negotiable', null],
  ['not_applicable', 'Not Applicable', null], ['custom', 'Custom duration', null],
] as const;
export type NoticePeriod = (typeof NOTICE_PERIODS)[number][0];
export const NOTICE_UNITS = ['days', 'weeks', 'months'] as const;
export const PAY_BASES = ['annual', 'monthly', 'hourly'] as const;

export const GENDER_OPTIONS = [['female', 'Female'], ['male', 'Male'], ['non_binary', 'Non-binary'], ['undisclosed', 'Prefer not to say']] as const;
export const CONTACT_METHODS = [['phone', 'Phone call'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['sms', 'SMS'], ['linkedin', 'LinkedIn']] as const;
export const CONTACT_TIMES = [['morning', 'Morning (9–12)'], ['afternoon', 'Afternoon (12–4)'], ['evening', 'Evening (4–8)'], ['weekend', 'Weekends'], ['anytime', 'Any time']] as const;
export const EMPLOYMENT_STATUSES = [['employed', 'Employed'], ['serving_notice', 'Serving notice'], ['unemployed', 'Not working'], ['freelance', 'Freelance'], ['student', 'Student'], ['fresher', 'Fresher']] as const;
export const CRM_EMPLOYMENT_TYPES = [['full_time', 'Full time'], ['part_time', 'Part time'], ['contract', 'Contract'], ['intern', 'Internship'], ['temporary', 'Temporary'], ['freelance', 'Freelance']] as const;
export const SENIORITY_LEVELS = [['intern', 'Intern / trainee'], ['entry', 'Entry level'], ['associate', 'Associate'], ['mid', 'Mid level'], ['senior', 'Senior'], ['lead', 'Lead'], ['manager', 'Manager'], ['senior_manager', 'Senior manager'], ['director', 'Director'], ['executive', 'Executive']] as const;
export const QUALIFICATIONS = [['high_school', 'High school'], ['diploma', 'Diploma'], ['bachelors', 'Bachelor’s degree'], ['masters', 'Master’s degree'], ['mba', 'MBA'], ['doctorate', 'Doctorate'], ['professional', 'Professional (CA, CS, ...)'], ['other', 'Other']] as const;
export const WORK_MODE_PREFS = [['onsite', 'On-site'], ['hybrid', 'Hybrid'], ['remote', 'Remote'], ['any', 'Any']] as const;
export const SHIFT_PREFS = [['day', 'Day'], ['night', 'Night'], ['rotational', 'Rotational'], ['flexible', 'Flexible'], ['any', 'Any']] as const;
export const CHANGE_REASONS = [['growth', 'Career growth'], ['compensation', 'Better compensation'], ['role', 'Better role'], ['relocation', 'Relocation'], ['stability', 'Job security'], ['culture', 'Work culture'], ['layoff', 'Laid off'], ['contract_end', 'Contract ended'], ['personal', 'Personal reasons'], ['other', 'Other']] as const;
export const INTEREST_LEVELS = [['very_high', 'Very high'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['not_interested', 'Not interested']] as const;
export const ASSESSMENT_LEVELS = [['excellent', 'Excellent'], ['good', 'Good'], ['average', 'Average'], ['poor', 'Poor']] as const;

/** Recruiter remark categories: each dated note belongs to one, so later notes never overwrite earlier ones. */
export const REMARK_CATEGORIES = [
  ['general', 'General remarks'], ['reason_change', 'Reason for looking for a job change'], ['reason_leaving', 'Reason for leaving current organization'],
  ['expectations', 'Career expectations'], ['preferences', 'Job preferences'], ['communication', 'Communication assessment'],
  ['professional', 'Professional assessment'], ['interest', 'Interest level'], ['salary', 'Salary discussion'], ['notice', 'Notice period discussion'],
  ['availability', 'Availability for interview'], ['observations', 'Recruiter’s observations'], ['additional', 'Additional notes'],
] as const;
export type RemarkCategory = (typeof REMARK_CATEGORIES)[number][0];

export const FOLLOW_UP_TYPES = [
  ['initial_call', 'Initial Call'], ['second_call', 'Second Call'], ['salary_discussion', 'Salary Discussion'], ['notice_discussion', 'Notice Period Discussion'],
  ['document_collection', 'Document Collection'], ['interview_confirmation', 'Interview Confirmation'], ['feedback_collection', 'Feedback Collection'],
  ['offer_discussion', 'Offer Discussion'], ['general', 'General Follow-up'],
] as const;
export const FOLLOW_UP_STATUSES = ['pending', 'completed', 'rescheduled', 'missed', 'cancelled'] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];
export const FOLLOW_UP_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
/** Minutes before the follow-up when its reminder goes out (0: at the time). */
export const REMINDER_OPTIONS = [0, 15, 30, 60, 120, 1440] as const;

/** Things a recruiter logs by hand. */
export const ACTIVITY_TYPES = [
  ['call', 'Call'], ['email', 'Email'], ['message', 'Message (SMS / WhatsApp)'], ['meeting', 'Meeting'], ['interview', 'Interview'], ['other', 'Other'],
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number][0];
/** Things SampCrew records itself. Together with ACTIVITY_TYPES they make the activity history and the timeline. */
export const SYSTEM_ACTIVITY_KINDS = [
  'created', 'updated', 'stage_changed', 'assigned', 'note_added', 'reference_added', 'document_uploaded', 'document_replaced', 'document_deleted',
  'follow_up_scheduled', 'follow_up_completed', 'follow_up_changed', 'imported', 'applied', 'ats_event', 'shared', 'archived', 'restored',
] as const;
export const CALL_OUTCOMES = [
  ['connected', 'Connected'], ['no_answer', 'No Answer'], ['busy', 'Busy'], ['switched_off', 'Switched Off'], ['call_back', 'Call Back Requested'],
  ['interested', 'Interested'], ['not_interested', 'Not Interested'], ['wrong_number', 'Number Incorrect'], ['not_reachable', 'Not Reachable'], ['other', 'Other'],
] as const;
export const INTERVIEW_OUTCOMES = [['scheduled', 'Scheduled'], ['completed', 'Completed'], ['no_show', 'No-show'], ['rescheduled', 'Rescheduled'], ['passed', 'Cleared'], ['failed', 'Not cleared']] as const;

export const DOCUMENT_KINDS = [
  ['resume', 'Resume / CV'], ['cover_letter', 'Cover Letter'], ['education', 'Educational Certificate'], ['experience_letter', 'Experience Letter'],
  ['portfolio', 'Portfolio Document'], ['certification', 'Certification'], ['previous_employment', 'Previous Employment Document'], ['other', 'Other Supporting Document'],
] as const;
export type CrmDocumentKind = (typeof DOCUMENT_KINDS)[number][0];
/** PDF, Word (DOCX and DOC), images and text, up to 10 MB, each checked against its real content. */
export const CRM_DOCUMENT_TYPES = [
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
  'image/jpeg', 'image/png', 'image/webp', 'text/plain',
] as const;
export const CRM_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const CRM_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const CRM_PHOTO_MAX_BYTES = 3 * 1024 * 1024;

export const crmLabel = <T extends readonly (readonly [string, string, ...unknown[]])[]>(list: T, key: string | null | undefined) => (key ? list.find((x) => x[0] === key)?.[1] ?? key : '');

// ---------------------------------------------------------------------------------------------------------------
// Candidate input
// ---------------------------------------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max);
/** Optional text where an empty string means "not given". */
const opt = (max: number) => text(max).optional().nullable().transform((v) => (v ? v : null));
const optEmail = z.string().trim().toLowerCase().max(254).optional().nullable().transform((v, ctx) => {
  if (!v) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { ctx.addIssue({ code: 'custom', message: 'Enter a valid email address' }); return z.NEVER; }
  return v;
});
const optPhone = optionalPhone.nullable().transform((v) => v ?? null);
const optDate = z.union([isoDate, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null));
const optBool = z.boolean().optional().nullable().transform((v) => (v === undefined ? null : v));
const list = (max = 40, each = 80) => z.array(z.string().trim().min(1).max(each)).max(max).default([]).transform((a) => [...new Set(a)]);
/** The same list without a default, for changes (a list left out of a change stays as it is). */
const listP = (max = 40, each = 80) => z.array(z.string().trim().min(1).max(each)).max(max).transform((a) => [...new Set(a)]);
/** A web address. Only http and https; nothing is fetched from it. */
export const crmUrl = z.string().trim().max(500).optional().nullable().transform((v, ctx) => {
  if (!v) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) throw new Error('bad');
    return u.toString();
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Enter a full web address, for example https://www.linkedin.com/in/name' });
    return z.NEVER;
  }
});
/** Money as a decimal string with at most 2 decimals. */
const amount = z.union([z.string(), z.number()]).optional().nullable().transform((v, ctx) => {
  if (v === undefined || v === null || v === '') return null;
  const s = typeof v === 'number' ? String(v) : v.trim().replace(/,/g, '');
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(s)) { ctx.addIssue({ code: 'custom', message: 'Enter an amount such as 450000 or 37500.50' }); return z.NEVER; }
  return s;
});
const months = z.number().int().min(0).max(70 * 12).optional().nullable().transform((v) => v ?? null);

export const compensationInput = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  /** Annual CTC, monthly salary or an hourly rate. */
  basis: z.enum(PAY_BASES).default('annual'),
  currentCtc: amount, currentFixed: amount, currentVariable: amount, currentMonthly: amount,
  expectedCtc: amount, expectedFixed: amount, expectedVariable: amount, expectedMonthly: amount,
  negotiable: optBool,
  minimumAcceptable: amount,
}).strict();

export const noticeInput = z.object({
  period: z.enum(NOTICE_PERIODS.map((n) => n[0]) as [NoticePeriod, ...NoticePeriod[]]).optional().nullable().transform((v) => v ?? null),
  /** For a custom duration. */
  value: z.number().int().min(0).max(1000).optional().nullable().transform((v) => v ?? null),
  unit: z.enum(NOTICE_UNITS).optional().nullable().transform((v) => v ?? null),
  servingNotice: optBool,
  lastWorkingDay: optDate,
  immediateJoiner: optBool,
  availableFrom: optDate,
}).strict();

export const preferencesInput = z.object({
  industries: list(20), departments: list(20), roles: list(20), designation: opt(120), locations: list(20), employmentTypes: list(6),
  workMode: opt(20), remote: optBool, relocate: optBool, shift: opt(20), objective: opt(3000), changeReason: opt(40), other: opt(3000),
}).strict();

export const insightsInput = z.object({
  reasonChange: opt(2000), reasonLeaving: opt(2000), expectations: opt(2000), preferences: opt(2000),
  communication: opt(20), professional: opt(20), interest: opt(20), salaryNotes: opt(2000), noticeNotes: opt(2000),
  interviewAvailability: opt(500), observations: opt(4000), general: opt(5000), additional: opt(5000),
}).strict();

export const linksInput = z.object({
  linkedin: crmUrl, portfolio: crmUrl, website: crmUrl, github: crmUrl, behance: crmUrl, dribbble: crmUrl, blog: crmUrl,
  other: z.array(z.object({ label: text(60).min(1), url: crmUrl.refine((v) => v !== null, 'Enter the address') }).strict()).max(10).default([]),
}).strict();

export const referenceInput = z.object({
  type: z.enum(REFERENCE_TYPES.map((r) => r[0]) as [string, ...string[]]),
  name: opt(120),
  phone: optPhone,
  email: optEmail,
  company: opt(120),
  relationship: opt(40),
  details: opt(2000),
}).strict();
export type ReferenceInput = z.infer<typeof referenceInput>;

/** Candidate fields; `d` false drops the defaults, so a change only touches what it names. */
const candidateFields = (d: boolean) => z.object({
  /** The HR Workspace that owns the record (null: Super Workspace / company-wide HR). Defaults to the caller's own. */
  hrWorkspaceId: z.uuid().nullable().optional(),
  firstName: text(80).min(1, 'Enter the first name'),
  middleName: opt(80),
  lastName: d ? text(80).default('') : text(80),
  gender: opt(20),
  dateOfBirth: optDate,
  email: optEmail,
  alternateEmail: optEmail,
  phone: optPhone,
  alternatePhone: optPhone,
  whatsapp: optPhone,
  address: opt(500),
  city: opt(80),
  state: opt(80),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Choose a country').optional().nullable().or(z.literal('')).transform((v) => (v ? v : null)),
  postalCode: opt(20),
  nationality: opt(60),
  contactMethod: opt(20),
  contactTime: opt(40),
  languages: (d ? list : listP)(20, 40),
  currentLocation: opt(120),
  profession: opt(120),
  currentTitle: opt(120),
  industry: opt(80),
  department: opt(80),
  jobRole: opt(120),
  currentCompany: opt(120),
  previousCompany: opt(120),
  totalExperienceMonths: months,
  relevantExperienceMonths: months,
  employmentStatus: opt(30),
  employmentType: opt(30),
  seniority: opt(30),
  teamFunction: opt(120),
  primarySkills: (d ? list : listP)(), secondarySkills: (d ? list : listP)(), technicalSkills: (d ? list : listP)(), softSkills: (d ? list : listP)(), certifications: (d ? list : listP)(30, 160),
  highestQualification: opt(30),
  specialization: opt(120),
  institution: opt(160),
  graduationYear: z.number().int().min(1950).max(2100).optional().nullable().transform((v) => v ?? null),
  summary: opt(5000),
  compensation: compensationInput.optional(),
  notice: noticeInput.optional(),
  preferences: preferencesInput.optional(),
  insights: insightsInput.optional(),
  links: linksInput.optional(),
  source: opt(40),
  sourceDetail: opt(120),
  tags: (d ? list : listP)(20, 30),
  stage: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(),
  assignedRecruiterMembershipId: z.uuid().nullable().optional(),
  /** Custom field values by field key. */
  customFields: d ? z.record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.unknown()).default({}) : z.record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.unknown()),
});
const candidateBase = candidateFields(true);

export const crmCandidateInput = candidateBase.extend({
  references: z.array(referenceInput).max(10).default([]),
  /** The first recruiter remark, saved as a dated note. */
  remark: z.string().trim().max(10000).optional().transform((v) => v || null),
  /** A job to put them forward for straight away (an ATS application). */
  requisitionId: z.uuid().optional(),
  /**
   * The recruiter confirms they may keep this person’s details (the candidate shared them for recruitment). Required
   * by data-protection rules; the career site records the candidate's own consent instead.
   */
  lawfulBasisConfirmed: z.literal(true, { message: 'Confirm the candidate agreed to share their details for recruitment' }),
  /** Add the record even though another candidate has the same phone number (the form asks first). */
  allowPhoneDuplicate: z.boolean().default(false),
}).strict().refine((v) => v.email || v.phone, { message: 'Enter an email address or a phone number', path: ['email'] });
export type CrmCandidateInput = z.infer<typeof crmCandidateInput>;

/** Changes to a candidate: any of the fields above; sections are replaced as a whole. */
export const crmCandidatePatch = candidateFields(false).omit({ stage: true }).partial().strict();
export type CrmCandidatePatch = z.infer<typeof crmCandidatePatch>;

export const crmStageInput = z.object({ stage: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), note: z.string().trim().max(2000).optional() }).strict();
export const crmAssignInput = z.object({ membershipId: z.uuid().nullable() }).strict();
export const crmShareInput = z.object({ hrWorkspaceIds: z.array(z.uuid()).max(50).transform((a) => [...new Set(a)]) }).strict();

export const crmBulkInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stage'), ids: z.array(z.uuid()).min(1).max(200), stage: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/) }).strict(),
  z.object({ action: z.literal('assign'), ids: z.array(z.uuid()).min(1).max(200), membershipId: z.uuid().nullable() }).strict(),
  z.object({ action: z.literal('tag'), ids: z.array(z.uuid()).min(1).max(200), tag: z.string().trim().min(1).max(30) }).strict(),
  z.object({ action: z.literal('archive'), ids: z.array(z.uuid()).min(1).max(200) }).strict(),
]);
export type CrmBulkInput = z.infer<typeof crmBulkInput>;

export const crmNoteInput = z.object({
  body: z.string().trim().min(1, 'Write the remark').max(10000),
  category: z.enum(REMARK_CATEGORIES.map((r) => r[0]) as [RemarkCategory, ...RemarkCategory[]]).default('general'),
  /** Restricted remarks are seen only by Super Workspace and HR Workspaces allowed to see them. */
  restricted: z.boolean().default(false),
  activityId: z.uuid().optional(),
}).strict();

export const crmActivityInput = z.object({
  type: z.enum(ACTIVITY_TYPES.map((a) => a[0]) as [ActivityType, ...ActivityType[]]),
  occurredAt: z.iso.datetime({ offset: true, local: true }).optional(),
  durationMinutes: z.number().int().min(0).max(24 * 60).optional().nullable().transform((v) => v ?? null),
  outcome: opt(40),
  subject: opt(160),
  remarks: opt(5000),
  /** For interviews logged by hand: who interviewed and the mode. */
  interviewer: opt(120),
  mode: opt(20),
  /** Schedules a follow-up at this time in the same step. */
  nextFollowUpAt: z.iso.datetime({ offset: true, local: true }).optional().nullable().transform((v) => v ?? null),
  nextFollowUpType: opt(40),
}).strict();
export type CrmActivityInput = z.infer<typeof crmActivityInput>;

export const followUpInput = z.object({
  type: z.enum(FOLLOW_UP_TYPES.map((f) => f[0]) as [string, ...string[]]).default('general'),
  dueAt: z.iso.datetime({ offset: true, local: true }),
  priority: z.enum(FOLLOW_UP_PRIORITIES).default('medium'),
  reason: opt(300),
  notes: opt(3000),
  /** Minutes before due time for the reminder; null for none. */
  reminderMinutes: z.number().int().min(0).max(10080).nullable().default(15),
  assignedMembershipId: z.uuid().nullable().optional(),
}).strict();
export type FollowUpInput = z.infer<typeof followUpInput>;

export const followUpUpdate = z.object({
  status: z.enum(FOLLOW_UP_STATUSES).optional(),
  dueAt: z.iso.datetime({ offset: true, local: true }).optional(),
  priority: z.enum(FOLLOW_UP_PRIORITIES).optional(),
  notes: opt(3000),
  outcome: opt(2000),
  reminderMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  assignedMembershipId: z.uuid().nullable().optional(),
}).strict();

export const crmActivityQuery = z.object({
  type: z.string().max(40).optional(),
  outcome: z.string().max(40).optional(),
  /** "me", or a membership id: who logged it. */
  by: z.string().max(60).optional(),
  candidateId: z.uuid().optional(),
  from: isoDate.optional(), to: isoDate.optional(),
  /** manual: only what people logged (the default); all: also what SampCrew recorded. */
  include: z.enum(['manual', 'all']).default('manual'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type CrmActivityQuery = z.infer<typeof crmActivityQuery>;

export const crmFollowUpQuery = z.object({
  bucket: z.enum(['overdue', 'today', 'upcoming', 'completed', 'missed', 'open', 'all']).default('open'),
  /** "me" (the default), "all", or a membership id. */
  assigned: z.string().max(60).default('me'),
  type: z.string().max(40).optional(),
  priority: z.enum(FOLLOW_UP_PRIORITIES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type CrmFollowUpQuery = z.infer<typeof crmFollowUpQuery>;

export const referencePatch = referenceInput.partial().strict();

export const crmDocumentMeta = z.object({
  kind: z.enum(DOCUMENT_KINDS.map((d) => d[0]) as [CrmDocumentKind, ...CrmDocumentKind[]]).default('other'),
  name: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

// ---------------------------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------------------------

export const CRM_SORTS = ['recent', 'updated', 'name', 'experience', 'expected_ctc', 'follow_up', 'stage'] as const;
const csv = z.string().max(2000).optional().transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined));
const num = z.coerce.number().min(0).max(10_000_000_000).optional();

export const crmListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  stage: csv,
  source: csv,
  recruiter: z.string().max(60).optional(),
  hrWorkspace: z.string().max(60).optional(),
  industry: z.string().trim().max(80).optional(),
  department: z.string().trim().max(80).optional(),
  jobRole: z.string().trim().max(120).optional(),
  location: z.string().trim().max(80).optional(),
  skills: csv,
  referenceType: z.string().max(40).optional(),
  tag: z.string().trim().max(30).optional(),
  minExp: num, maxExp: num,
  minCtc: num, maxCtc: num,
  minExpected: num, maxExpected: num,
  /** At most this many days of notice. */
  maxNotice: z.coerce.number().int().min(0).max(1000).optional(),
  followUp: z.enum(['due', 'overdue', 'today', 'none', 'any']).optional(),
  createdFrom: isoDate.optional(), createdTo: isoDate.optional(),
  archived: z.enum(['only', 'include']).optional(),
  /** Custom field filters, as cf.<key>=value. */
  cf: z.record(z.string(), z.string().max(200)).optional(),
  ids: csv,
  sort: z.enum(CRM_SORTS).default('recent'),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type CrmListQuery = z.infer<typeof crmListQuery>;


// ---------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------

export const crmSettingsInput = z.object({
  stages: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Lowercase letters, numbers and underscores'),
    label: z.string().trim().min(1).max(60),
    kind: z.enum(CRM_STAGE_KINDS),
    active: z.boolean(),
  }).strict()).min(3).max(40).optional(),
  sources: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), label: z.string().trim().min(1).max(60), active: z.boolean() }).strict()).min(1).max(60).optional(),
  /** Days without activity after which a candidate with nothing in progress is anonymised; null keeps the career site's rule. */
  retentionDays: z.number().int().min(90).max(3650).nullable().optional(),
  /** Fields that mark two records as the same person. */
  matchFields: z.array(z.enum(['email', 'phone', 'candidate_code'])).min(1).max(3).optional(),
}).strict();
export type CrmSettingsInput = z.infer<typeof crmSettingsInput>;

// ---------------------------------------------------------------------------------------------------------------
// Custom fields (Candidate CRM extends the shared custom field model with where each field appears)
// ---------------------------------------------------------------------------------------------------------------

export const CRM_FIELD_TYPES = [
  'short_text', 'long_text', 'number', 'decimal', 'currency', 'date', 'datetime', 'email', 'phone', 'url', 'dropdown', 'searchable_dropdown',
  'multi_select', 'checkbox', 'yes_no', 'radio', 'file',
] as const;
export type CrmFieldType = (typeof CRM_FIELD_TYPES)[number];

export const CRM_FIELD_FLAGS = ['form', 'profile', 'import', 'filter', 'export'] as const;
export type CrmFieldFlag = (typeof CRM_FIELD_FLAGS)[number];
export const CRM_FIELD_FLAG_LABEL: Record<CrmFieldFlag, string> = {
  form: 'Visible in candidate form', profile: 'Visible in candidate profile', import: 'Available in import mapping', filter: 'Available in filters', export: 'Available in export',
};

const fieldOption = z.object({ value: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(120), archived: z.boolean().optional() }).strict();
const fieldBase = z.object({
  label: z.string().trim().min(1).max(120),
  name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Lowercase letters, numbers and underscores').optional(),
  description: z.string().trim().max(300).optional().nullable().transform((v) => v || null),
  type: z.enum(CRM_FIELD_TYPES),
  placeholder: z.string().trim().max(120).optional().nullable().transform((v) => v || null),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  options: z.array(fieldOption).max(300).default([]),
  validation: z.object({
    min: z.number().finite().optional(), max: z.number().finite().optional(),
    minLength: z.number().int().min(0).max(10000).optional(), maxLength: z.number().int().min(1).max(10000).optional(),
    pattern: z.string().max(200).optional().refine((p) => { if (!p) return true; try { new RegExp(p); return true; } catch { return false; } }, 'Not a valid pattern'),
    patternMessage: z.string().max(120).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  }).strict().default({}),
  group: z.string().trim().max(80).optional().nullable().transform((v) => v || null),
  position: z.number().int().min(0).max(10000).optional(),
  active: z.boolean().default(true),
  flags: z.array(z.enum(CRM_FIELD_FLAGS)).default(['form', 'profile', 'import', 'filter', 'export']).transform((a) => [...new Set(a)]),
  /** Super Workspace only: make it a company-wide field (null) or one HR Workspace's own. */
  hrWorkspaceId: z.uuid().nullable().optional(),
});
const OPTIONED: readonly CrmFieldType[] = ['dropdown', 'searchable_dropdown', 'multi_select', 'radio'];
export const crmFieldInput = fieldBase.strict()
  .refine((v) => !OPTIONED.includes(v.type) || v.options.length > 0, { message: 'Add at least one option', path: ['options'] })
  .refine((v) => new Set(v.options.map((o) => o.value)).size === v.options.length, { message: 'Two options have the same value', path: ['options'] });
export type CrmFieldInput = z.infer<typeof crmFieldInput>;
export const crmFieldUpdate = fieldBase.omit({ name: true, hrWorkspaceId: true }).partial().strict();
export const crmFieldsOrder = z.object({ ids: z.array(z.uuid()).min(1).max(500) }).strict();
export const isOptionField = (t: string) => OPTIONED.includes(t as CrmFieldType);

// ---------------------------------------------------------------------------------------------------------------
// Import and export
// ---------------------------------------------------------------------------------------------------------------

export type ImportParser = 'text' | 'name' | 'email' | 'phone' | 'date' | 'experience' | 'money' | 'notice' | 'url' | 'list' | 'year' | 'bool' | 'source' | 'stage' | 'reference_type' | 'country';

/** SampCrew fields an imported column can fill, with the column names that usually mean them. */
export const CRM_IMPORT_FIELDS: { key: string; label: string; parser: ImportParser; aliases: string[] }[] = [
  { key: 'candidateCode', label: 'Candidate ID', parser: 'text', aliases: ['candidate id', 'candidate code', 'id', 'can id'] },
  { key: 'fullName', label: 'Full Name', parser: 'name', aliases: ['candidate name', 'name', 'full name', 'candidate'] },
  { key: 'firstName', label: 'First Name', parser: 'text', aliases: ['first name', 'firstname', 'given name'] },
  { key: 'middleName', label: 'Middle Name', parser: 'text', aliases: ['middle name'] },
  { key: 'lastName', label: 'Last Name', parser: 'text', aliases: ['last name', 'lastname', 'surname', 'family name'] },
  { key: 'email', label: 'Email Address', parser: 'email', aliases: ['email', 'email id', 'e-mail', 'mail', 'email address'] },
  { key: 'alternateEmail', label: 'Alternate Email', parser: 'email', aliases: ['alternate email', 'secondary email', 'other email'] },
  { key: 'phone', label: 'Primary Phone', parser: 'phone', aliases: ['mobile', 'phone', 'mobile number', 'phone number', 'contact', 'contact number', 'cell'] },
  { key: 'alternatePhone', label: 'Alternate Phone', parser: 'phone', aliases: ['alternate phone', 'alternate mobile', 'other phone', 'landline'] },
  { key: 'whatsapp', label: 'WhatsApp Number', parser: 'phone', aliases: ['whatsapp', 'whatsapp number'] },
  { key: 'gender', label: 'Gender', parser: 'text', aliases: ['gender', 'sex'] },
  { key: 'dateOfBirth', label: 'Date of Birth', parser: 'date', aliases: ['dob', 'date of birth', 'birth date'] },
  { key: 'address', label: 'Current Address', parser: 'text', aliases: ['address', 'current address'] },
  { key: 'city', label: 'City', parser: 'text', aliases: ['city', 'town'] },
  { key: 'state', label: 'State', parser: 'text', aliases: ['state', 'province', 'region'] },
  { key: 'country', label: 'Country', parser: 'country', aliases: ['country'] },
  { key: 'postalCode', label: 'ZIP / Postal Code', parser: 'text', aliases: ['zip', 'pin', 'pincode', 'postal code', 'zip code'] },
  { key: 'currentLocation', label: 'Current Location', parser: 'text', aliases: ['location', 'current location'] },
  { key: 'preferredLocations', label: 'Preferred Job Location', parser: 'list', aliases: ['preferred location', 'preferred locations', 'preferred job location'] },
  { key: 'languages', label: 'Languages Known', parser: 'list', aliases: ['languages', 'languages known'] },
  { key: 'profession', label: 'Current Profession', parser: 'text', aliases: ['profession', 'current profession'] },
  { key: 'currentTitle', label: 'Current Job Title', parser: 'text', aliases: ['designation', 'title', 'job title', 'current designation', 'current title'] },
  { key: 'industry', label: 'Current Industry', parser: 'text', aliases: ['industry', 'current industry'] },
  { key: 'department', label: 'Current Department', parser: 'text', aliases: ['department', 'function', 'current department'] },
  { key: 'jobRole', label: 'Current Job Role', parser: 'text', aliases: ['role', 'job role', 'current role'] },
  { key: 'currentCompany', label: 'Current Company', parser: 'text', aliases: ['company', 'current company', 'employer', 'organization', 'organisation'] },
  { key: 'previousCompany', label: 'Previous Company', parser: 'text', aliases: ['previous company', 'last company', 'previous employer'] },
  { key: 'totalExperienceMonths', label: 'Total Experience', parser: 'experience', aliases: ['experience', 'total experience', 'exp', 'total exp', 'years of experience'] },
  { key: 'relevantExperienceMonths', label: 'Relevant Experience', parser: 'experience', aliases: ['relevant experience', 'relevant exp'] },
  { key: 'skills', label: 'Primary Skills', parser: 'list', aliases: ['skills', 'key skills', 'primary skills'] },
  { key: 'highestQualification', label: 'Highest Qualification', parser: 'text', aliases: ['qualification', 'education', 'highest qualification', 'degree'] },
  { key: 'institution', label: 'University / Institution', parser: 'text', aliases: ['university', 'college', 'institution'] },
  { key: 'graduationYear', label: 'Graduation Year', parser: 'year', aliases: ['graduation year', 'passing year', 'year of passing'] },
  { key: 'currentCtc', label: 'Current CTC', parser: 'money', aliases: ['current ctc', 'ctc', 'current salary', 'cctc'] },
  { key: 'expectedCtc', label: 'Expected CTC', parser: 'money', aliases: ['expected ctc', 'expected salary', 'ectc'] },
  { key: 'currency', label: 'Currency', parser: 'text', aliases: ['currency'] },
  { key: 'notice', label: 'Notice Period', parser: 'notice', aliases: ['notice', 'notice period', 'np'] },
  { key: 'linkedin', label: 'LinkedIn URL', parser: 'url', aliases: ['linkedin', 'linkedin url', 'linkedin profile'] },
  { key: 'portfolio', label: 'Portfolio URL', parser: 'url', aliases: ['portfolio', 'portfolio url'] },
  { key: 'github', label: 'GitHub URL', parser: 'url', aliases: ['github'] },
  { key: 'website', label: 'Personal Website', parser: 'url', aliases: ['website', 'personal website'] },
  { key: 'source', label: 'Candidate Source', parser: 'source', aliases: ['source', 'candidate source', 'lead source'] },
  { key: 'referenceType', label: 'Reference Type', parser: 'reference_type', aliases: ['reference type', 'referral type'] },
  { key: 'referenceName', label: 'Reference', parser: 'text', aliases: ['reference', 'referred by', 'reference name', 'referrer'] },
  { key: 'referencePhone', label: 'Reference Contact Number', parser: 'phone', aliases: ['reference phone', 'reference contact', 'referrer phone'] },
  { key: 'stage', label: 'Recruitment Stage', parser: 'stage', aliases: ['status', 'stage', 'recruitment status', 'recruitment stage'] },
  { key: 'tags', label: 'Tags', parser: 'list', aliases: ['tags', 'labels'] },
  { key: 'remark', label: 'Recruiter Remarks', parser: 'text', aliases: ['remarks', 'remark', 'comments', 'notes', 'recruiter remarks'] },
  { key: 'summary', label: 'Professional Summary', parser: 'text', aliases: ['summary', 'profile summary', 'about'] },
];

export const IMPORT_DUPLICATE_ACTIONS = ['skip', 'update', 'create', 'review'] as const;
export type ImportDuplicateAction = (typeof IMPORT_DUPLICATE_ACTIONS)[number];

export const crmImportMapping = z.record(z.string().max(200), z.string().max(60).nullable());
export const crmImportPlanInput = z.object({
  /** Column header -> SampCrew field key, "cf:<key>" for a custom field, or null to leave it out. */
  mapping: crmImportMapping,
  duplicateAction: z.enum(IMPORT_DUPLICATE_ACTIONS).default('review'),
  /** For rows the check flagged as possible duplicates: what to do with each (row number -> action). */
  rowActions: z.record(z.string().regex(/^\d+$/), z.enum(['skip', 'update', 'create'])).default({}),
  defaults: z.object({ source: z.string().max(40).optional(), stage: z.string().max(40).optional(), assignedRecruiterMembershipId: z.uuid().optional(), hrWorkspaceId: z.uuid().nullable().optional(), tag: z.string().trim().max(30).optional() }).strict().default({}),
  lawfulBasisConfirmed: z.boolean().optional(),
  saveTemplate: z.string().trim().min(1).max(60).optional(),
}).strict();
export type CrmImportPlanInput = z.infer<typeof crmImportPlanInput>;

export const crmExportInput = z.object({
  scope: z.enum(['all', 'filtered', 'selected']).default('filtered'),
  filters: z.record(z.string(), z.unknown()).default({}),
  ids: z.array(z.uuid()).max(5000).default([]),
  columns: z.array(z.string().max(60)).min(1).max(150),
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
}).strict();
export type CrmExportInput = z.infer<typeof crmExportInput>;

/** Columns an export can carry (custom fields are added as cf:<key>). */
export const CRM_EXPORT_COLUMNS: { key: string; label: string; sensitive?: boolean }[] = [
  { key: 'candidateCode', label: 'Candidate ID' }, { key: 'name', label: 'Candidate Name' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
  { key: 'alternatePhone', label: 'Alternate Phone' }, { key: 'whatsapp', label: 'WhatsApp' }, { key: 'gender', label: 'Gender', sensitive: true },
  { key: 'dateOfBirth', label: 'Date of Birth', sensitive: true }, { key: 'nationality', label: 'Nationality', sensitive: true },
  { key: 'city', label: 'City' }, { key: 'state', label: 'State' }, { key: 'country', label: 'Country' }, { key: 'currentLocation', label: 'Current Location' },
  { key: 'profession', label: 'Current Profession' }, { key: 'currentTitle', label: 'Current Job Title' }, { key: 'currentCompany', label: 'Current Company' },
  { key: 'industry', label: 'Industry' }, { key: 'department', label: 'Department' }, { key: 'jobRole', label: 'Job Role' },
  { key: 'experience', label: 'Experience' }, { key: 'relevantExperience', label: 'Relevant Experience' }, { key: 'skills', label: 'Skills' },
  { key: 'qualification', label: 'Highest Qualification' }, { key: 'currency', label: 'Currency' }, { key: 'currentCtc', label: 'Current CTC' },
  { key: 'expectedCtc', label: 'Expected CTC' }, { key: 'notice', label: 'Notice Period' }, { key: 'availableFrom', label: 'Available From' },
  { key: 'linkedin', label: 'LinkedIn' }, { key: 'portfolio', label: 'Portfolio' }, { key: 'source', label: 'Source' }, { key: 'reference', label: 'Reference' },
  { key: 'stage', label: 'Status' }, { key: 'recruiter', label: 'Assigned Recruiter' }, { key: 'hrWorkspace', label: 'HR Workspace' },
  { key: 'nextFollowUp', label: 'Next Follow-up' }, { key: 'lastActivity', label: 'Last Activity' }, { key: 'tags', label: 'Tags' },
  { key: 'jobs', label: 'Jobs' }, { key: 'createdAt', label: 'Created' }, { key: 'createdBy', label: 'Created By' }, { key: 'updatedAt', label: 'Last Updated' },
];
export const CRM_DEFAULT_EXPORT = ['candidateCode', 'name', 'email', 'phone', 'experience', 'currentCtc', 'expectedCtc', 'notice', 'stage', 'recruiter'];

/** Columns the candidate list can show, in their default order; the first eight are shown unless the person chooses. */
export const CRM_LIST_COLUMNS = [
  ['candidateCode', 'Candidate ID'], ['profession', 'Current Profession'], ['currentCompany', 'Current Company'], ['experience', 'Experience'],
  ['currentCtc', 'Current CTC'], ['expectedCtc', 'Expected CTC'], ['notice', 'Notice Period'], ['location', 'Location'], ['reference', 'Reference'],
  ['stage', 'Recruitment Status'], ['recruiter', 'Assigned Recruiter'], ['nextFollowUp', 'Next Follow-up'], ['lastActivity', 'Last Activity'],
  ['source', 'Source'], ['industry', 'Industry'], ['department', 'Department'], ['jobRole', 'Job Role'], ['hrWorkspace', 'HR Workspace'],
] as const;
export const CRM_DEFAULT_COLUMNS = ['candidateCode', 'profession', 'currentCompany', 'experience', 'currentCtc', 'expectedCtc', 'notice', 'location', 'reference', 'stage', 'recruiter', 'nextFollowUp', 'lastActivity'];

// ---------------------------------------------------------------------------------------------------------------
// Parsing helpers (shared by import, the forms and tests)
// ---------------------------------------------------------------------------------------------------------------

/** "CAN-000124" from a running number. */
export const formatCandidateCode = (n: number) => `CAN-${String(n).padStart(6, '0')}`;

/** Months of experience as "5 years 4 months" ("" for none). */
export function experienceText(months: number | null | undefined): string {
  if (months === null || months === undefined) return '';
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (!y && !m) return 'Fresher';
  return [y ? `${y} year${y === 1 ? '' : 's'}` : '', m ? `${m} month${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ');
}

/**
 * Experience written the ways spreadsheets carry it: "3 years 6 months", "3y 6m", "3.5", "3.5 yrs", "42 months",
 * "fresher". Returns months, or null when it cannot be read.
 */
export function parseExperience(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw >= 0 && raw < 70 ? Math.round(raw * 12) : null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (/^(fresher|nil|none|0)$/.test(s)) return 0;
  const y = s.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)\b/);
  const m = s.match(/(\d+)\s*(?:months?|mos?|m)\b/);
  if (y || m) {
    const total = (y ? Number(y[1]) * 12 : 0) + (m ? Number(m[1]) : 0);
    return Number.isFinite(total) && total < 70 * 12 ? Math.round(total) : null;
  }
  const n = Number(s.replace(/\+$/, ''));
  return Number.isFinite(n) && n >= 0 && n < 70 ? Math.round(n * 12) : null;
}

/**
 * An amount the way recruiters write it: "4.5 LPA", "₹4,50,000", "6 L", "1.2 Cr", "50k", "$85,000". Returns a
 * decimal string, or null when it cannot be read. Lakh/crore words assume an annual figure in rupees.
 */
export function parseAmount(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw >= 0 && Number.isFinite(raw) ? String(Math.round(raw * 100) / 100) : null;
  const s = String(raw).trim().toLowerCase().replace(/[₹$€£,\s]|inr|usd|rs\.?/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)(lpa|lakhs?|lacs?|l|cr|crores?|k|m|mn|pa)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = ({ lpa: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, cr: 1e7, crore: 1e7, crores: 1e7, k: 1e3, m: 1e6, mn: 1e6, pa: 1 } as Record<string, number>)[m[2] ?? ''] ?? 1;
  const v = Math.round(n * mult * 100) / 100;
  return Number.isFinite(v) && v < 1e13 ? String(v) : null;
}

/** Days of notice for a notice period (null when it has none or cannot be counted). */
export function noticeDays(n: { period?: string | null; value?: number | null; unit?: string | null } | null | undefined): number | null {
  if (!n?.period) return null;
  if (n.period === 'custom') {
    if (n.value === null || n.value === undefined) return null;
    return n.value * (n.unit === 'months' ? 30 : n.unit === 'weeks' ? 7 : 1);
  }
  const p = NOTICE_PERIODS.find((x) => x[0] === n.period);
  return (p?.[2] as number | null | undefined) ?? null;
}

export function noticeText(n: { period?: string | null; value?: number | null; unit?: string | null } | null | undefined): string {
  if (!n?.period) return '';
  if (n.period === 'custom') return n.value === null || n.value === undefined ? 'Custom' : `${n.value} ${n.unit ?? 'days'}`;
  return crmLabel(NOTICE_PERIODS, n.period);
}

/** "30 days", "Immediate", "2 months", "1 week", "45" (days) -> a notice period. */
export function parseNotice(raw: unknown): { period: NoticePeriod; value: number | null; unit: 'days' | 'weeks' | 'months' | null } | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (/^(immediate|immediately|0|0 days|nil|none)$/.test(s)) return { period: 'immediate', value: null, unit: null };
  if (/negotiable/.test(s)) return { period: 'negotiable', value: null, unit: null };
  if (/^(n\/?a|not applicable)$/.test(s)) return { period: 'not_applicable', value: null, unit: null };
  const m = s.match(/^(\d+)\s*(days?|d|weeks?|w|months?|mon|m)?\+?$/);
  if (!m) return null;
  const v = Number(m[1]);
  const unit = !m[2] || m[2].startsWith('d') ? 'days' : m[2].startsWith('w') ? 'weeks' : 'months';
  const days = v * (unit === 'months' ? 30 : unit === 'weeks' ? 7 : 1);
  const exact = NOTICE_PERIODS.find((p) => p[2] === days && p[0] !== 'more_than_90');
  if (exact) return { period: exact[0], value: null, unit: null };
  return { period: 'custom', value: v, unit };
}

/** Dates in the forms spreadsheets use: 2026-04-15, 15/04/2026, 15-04-2026, 15 Apr 2026, or an Excel serial number. */
export function parseDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const iso = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  const s = String(raw).trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]*(\d{4})$/);
  if (m) {
    const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2]!.slice(0, 3).toLowerCase());
    return mi >= 0 ? iso(+m[3]!, mi + 1, +m[1]!) : null;
  }
  return null;
}

/** Digits of a phone number used to spot duplicates: the last 10, so +91 98200 11122 and 09820011122 match. */
export function phoneKey(p: string | null | undefined): string | null {
  if (!p) return null;
  const d = p.replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : null;
}

/** Splits "Kunal Sharma" or "Sharma, Kunal" into first, middle and last names. */
export function splitName(full: string): { firstName: string; middleName: string | null; lastName: string } {
  const s = full.trim().replace(/\s+/g, ' ');
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((x) => x.trim());
    return { ...splitName(first ?? ''), lastName: last ?? '' };
  }
  const parts = s.split(' ');
  if (parts.length === 1) return { firstName: parts[0]!, middleName: null, lastName: '' };
  if (parts.length === 2) return { firstName: parts[0]!, middleName: null, lastName: parts[1]! };
  return { firstName: parts[0]!, middleName: parts.slice(1, -1).join(' '), lastName: parts[parts.length - 1]! };
}

/** The best guess at which SampCrew field a spreadsheet column fills. */
export function guessImportField(header: string, customFields: { key: string; label: string }[] = []): string | null {
  const h = header.trim().toLowerCase().replace(/[_*:]+/g, ' ').replace(/\s+/g, ' ').replace(/\(.*?\)/g, '').trim();
  if (!h) return null;
  for (const f of CRM_IMPORT_FIELDS) if (f.aliases.includes(h) || f.label.toLowerCase() === h) return f.key;
  for (const c of customFields) if (c.label.toLowerCase() === h || c.key === h.replace(/ /g, '_')) return `cf:${c.key}`;
  // Looser: a column that contains an alias ("Candidate Email ID", "Mobile No.").
  for (const f of CRM_IMPORT_FIELDS) if (f.aliases.some((a) => a.length > 3 && h.includes(a))) return f.key;
  return null;
}

/** A phone number as stored, or an error message. */
export function normalisePhone(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  const s = typeof raw === 'number' ? String(Math.round(raw)) : String(raw).trim();
  const r = checkPhone(s);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.message };
}

// ---------------------------------------------------------------------------------------------------------------
// Views (what the API returns), shared with the web pages
// ---------------------------------------------------------------------------------------------------------------

export interface CrmContext {
  level: 'super' | 'hr';
  /** HR Workspaces (and "central") this person works in with the CRM switched on, and their powers in each. */
  workspaces: { key: string; name: string; caps: CrmCap[] }[];
  /** Powers in at least one of them (Super Workspace: all). */
  caps: CrmCap[];
  canManageAccess: boolean;
  canConfigure: boolean;
  stages: CrmStage[];
  sources: CrmOption[];
  recruiters: { membershipId: string; name: string }[];
  hrWorkspaces: { id: string; name: string }[];
}
