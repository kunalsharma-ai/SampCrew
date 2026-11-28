import { z } from 'zod';

/**
 * Career Enquiry: job applications and career enquiries that candidates send from the company's own website (for
 * Frequent Research, the careers form of frequentresearch.com and its super admin), received by SampCrew automatically.
 *
 * - The website sends each application to SampCrew's intake address with its API key (Bearer). SampCrew maps the
 *   website's fields to its own, finds or creates the one candidate record (the same `candidates` the ATS and the
 *   Candidate CRM use), stores the CV once, and gives the application its CE- number.
 * - Status changes go back to the website, signed with the shared webhook secret, so the website's super admin sees
 *   where each applicant stands.
 * - People move applicants into the Candidate CRM with one action; the record is the same, so nothing is copied twice.
 *
 * Access: Super Workspace always; an HR Workspace (or the company-wide HR team, "central") only after Super Workspace
 * switches it on, either for all its applications or only those assigned to the person, with the powers given.
 * Employee Workspace never. The Console sees each company's connection health, never the candidates.
 */

// ---------------------------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------------------------

/** open: in progress; won: selected and later; lost: rejected; paused: on hold. */
export const CAREER_STAGE_KINDS = ['open', 'won', 'lost', 'paused'] as const;
export type CareerStageKind = (typeof CAREER_STAGE_KINDS)[number];
export interface CareerStage { key: string; label: string; kind: CareerStageKind; active: boolean; position: number; system: boolean }

const S = (key: string, label: string, kind: CareerStageKind = 'open', system = false): CareerStage => ({ key, label, kind, active: true, position: 0, system });

/** The twelve default stages. New Application, Joined and Rejected are always there (renaming is allowed). */
export const DEFAULT_CAREER_STAGES: CareerStage[] = [
  S('new_application', 'New Application', 'open', true), S('under_review', 'Under Review'), S('shortlisted', 'Shortlisted'), S('contacted', 'Contacted'),
  S('interview_scheduled', 'Interview Scheduled'), S('interview_completed', 'Interview Completed'), S('selected', 'Selected', 'won'),
  S('offer_sent', 'Offer Sent', 'won'), S('offer_accepted', 'Offer Accepted', 'won'), S('joined', 'Joined', 'won', true),
  S('rejected', 'Rejected', 'lost', true), S('on_hold', 'On Hold', 'paused'),
].map((s, i) => ({ ...s, position: i }));

export const CAREER_FIXED_STAGES = ['new_application', 'joined', 'rejected'] as const;

/** A stage list as saved, with fixed stages kept, positions renumbered and keys unique. Throws a message when invalid. */
export function normaliseCareerStages(list: Omit<CareerStage, 'position' | 'system'>[]): CareerStage[] {
  const seen = new Set<string>();
  const out: CareerStage[] = [];
  for (const s of list) {
    if (seen.has(s.key)) throw new Error(`The stage "${s.label}" is listed twice`);
    seen.add(s.key);
    const fixed = (CAREER_FIXED_STAGES as readonly string[]).includes(s.key);
    out.push({ ...s, active: fixed ? true : s.active, system: fixed, position: out.length, kind: fixed ? DEFAULT_CAREER_STAGES.find((d) => d.key === s.key)!.kind : s.kind });
  }
  for (const k of CAREER_FIXED_STAGES) if (!seen.has(k)) throw new Error(`The stage "${DEFAULT_CAREER_STAGES.find((d) => d.key === k)!.label}" cannot be removed`);
  if (out[0]?.key !== 'new_application') throw new Error('New Application must stay the first stage');
  return out;
}

/** A stage key from a label ("Technical Round 2" -> technical_round_2). */
export const careerStageKey = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'stage';

/** The summary cards on the dashboard, in order: which stages each card counts. */
export const CAREER_SUMMARY_CARDS = [
  { key: 'total', label: 'Total Applications Received', stages: null },
  { key: 'new', label: 'New Applications', stages: ['new_application'] },
  { key: 'review', label: 'Applications Under Review', stages: ['under_review', 'contacted'] },
  { key: 'shortlisted', label: 'Shortlisted Candidates', stages: ['shortlisted'] },
  { key: 'interview_scheduled', label: 'Interview Scheduled', stages: ['interview_scheduled'] },
  { key: 'interview_completed', label: 'Interview Completed', stages: ['interview_completed'] },
  { key: 'selected', label: 'Selected Candidates', stages: ['selected', 'offer_sent', 'offer_accepted', 'joined'] },
  { key: 'rejected', label: 'Rejected Applications', stages: ['rejected'] },
  { key: 'on_hold', label: 'Candidates on Hold', stages: ['on_hold'] },
] as const;

/**
 * The word the website's super admin understands for a stage (its SampCrew webhook maps hired, rejected, interview,
 * shortlisted and screening to its own lead statuses). Custom stages go by their kind.
 */
export function websiteStageWord(stage: Pick<CareerStage, 'key' | 'kind'>): string {
  const byKey: Record<string, string> = {
    new_application: 'applied', under_review: 'screening', contacted: 'screening', shortlisted: 'shortlisted', interview_scheduled: 'interview',
    interview_completed: 'interview', selected: 'offer', offer_sent: 'offer', offer_accepted: 'offer', joined: 'hired', rejected: 'rejected', on_hold: 'on_hold',
  };
  return byKey[stage.key] ?? ({ open: 'screening', won: 'offer', lost: 'rejected', paused: 'on_hold' } as const)[stage.kind];
}

// ---------------------------------------------------------------------------------------------------------------
// Calls, interviews, notes
// ---------------------------------------------------------------------------------------------------------------

export const CAREER_CALL_OUTCOMES = [
  ['connected', 'Connected'], ['no_answer', 'No Answer'], ['busy', 'Busy'], ['call_back', 'Call Back Requested'], ['not_interested', 'Not Interested'],
  ['interested', 'Interested'], ['interview_discussion', 'Interview Discussion'], ['wrong_number', 'Wrong Number'],
] as const;
export type CareerCallOutcome = (typeof CAREER_CALL_OUTCOMES)[number][0];

export const CAREER_INTERVIEW_TYPES = [['telephonic', 'Telephonic'], ['video', 'Video Interview'], ['in_person', 'In-Person Interview']] as const;
export type CareerInterviewType = (typeof CAREER_INTERVIEW_TYPES)[number][0];

/** internal: only people with access see it; comment: a recruitment comment, also carried into the CRM as a remark. */
export const CAREER_NOTE_KINDS = [['internal', 'Internal note'], ['comment', 'Recruitment comment']] as const;

export const careerLabel = (list: readonly (readonly [string, string])[], key: string | null | undefined) => list.find((x) => x[0] === key)?.[1] ?? key ?? '';

// ---------------------------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------------------------

/** Powers Super Workspace gives an HR Workspace on its applications. Viewing details is always included once on. */
export const CAREER_CAPS = ['cv', 'contact', 'manage', 'interviews', 'crm', 'reports'] as const;
export type CareerCap = (typeof CAREER_CAPS)[number];
export const CAREER_CAP_LABEL: Record<CareerCap, string> = {
  cv: 'Preview and download CVs',
  contact: 'Call and email candidates',
  manage: 'Change status, notes and assignment',
  interviews: 'Schedule interviews and follow-ups',
  crm: 'Move candidates to Candidate CRM',
  reports: 'Recruitment reports and export',
};
/** all: every application of the HR Workspace; assigned: only those assigned to the person (as HR or recruiter). */
export const CAREER_SCOPES = ['all', 'assigned'] as const;
export type CareerScope = (typeof CAREER_SCOPES)[number];
export const CAREER_CENTRAL = 'central';

export const careerAccessInput = z.object({
  changes: z.array(z.object({
    key: z.union([z.uuid(), z.literal(CAREER_CENTRAL)]),
    enabled: z.boolean(),
    scope: z.enum(CAREER_SCOPES).default('all'),
    caps: z.array(z.enum(CAREER_CAPS)).max(CAREER_CAPS.length).transform((a) => [...new Set(a)]),
  }).strict()).min(1).max(200),
}).strict();
export type CareerAccessInput = z.infer<typeof careerAccessInput>;

// ---------------------------------------------------------------------------------------------------------------
// Website integration and field mapping
// ---------------------------------------------------------------------------------------------------------------

/** SampCrew's application fields that a website field can fill, with the Frequent Research website's own names. */
export const CAREER_TARGET_FIELDS = [
  { key: 'externalId', label: 'Website application ID', default: 'externalId', group: 'application' },
  { key: 'kind', label: 'Application or enquiry', default: 'type', group: 'application' },
  { key: 'fullName', label: 'Candidate Full Name', default: 'name', group: 'personal' },
  { key: 'firstName', label: 'First name', default: 'first', group: 'personal' },
  { key: 'lastName', label: 'Last name', default: 'last', group: 'personal' },
  { key: 'email', label: 'Email Address', default: 'email', group: 'personal' },
  { key: 'phone', label: 'Phone Number', default: 'phone', group: 'personal' },
  { key: 'countryCode', label: 'Phone country code', default: 'countryCode', group: 'personal' },
  { key: 'location', label: 'Current Location', default: 'location', group: 'personal' },
  { key: 'linkedin', label: 'LinkedIn Profile', default: 'linkedin', group: 'personal' },
  { key: 'portfolio', label: 'Portfolio or Personal Website', default: 'extra.portfolio', group: 'personal' },
  { key: 'currentDesignation', label: 'Current Designation', default: 'extra.currentDesignation', group: 'personal' },
  { key: 'totalExperience', label: 'Total Work Experience', default: 'experience', group: 'personal' },
  { key: 'noticePeriod', label: 'Notice period', default: 'extra.notice', group: 'personal' },
  { key: 'position', label: 'Applied Position', default: 'position', group: 'application' },
  { key: 'department', label: 'Department', default: 'department', group: 'application' },
  { key: 'message', label: 'Message / cover note', default: 'message', group: 'application' },
  { key: 'appliedAt', label: 'Application Submission Date', default: 'appliedAt', group: 'application' },
  { key: 'photoUrl', label: 'Profile photo link', default: 'extra.photo', group: 'personal' },
  { key: 'cvUrl', label: 'Candidate CV / Resume (link)', default: 'cv.url', group: 'files' },
  { key: 'cvName', label: 'CV file name', default: 'cv.name', group: 'files' },
  { key: 'cvBase64', label: 'CV file (base64)', default: 'cv.content', group: 'files' },
  { key: 'documents', label: 'Supporting documents (list of {name, url})', default: 'documents', group: 'files' },
] as const;
export type CareerTargetField = (typeof CAREER_TARGET_FIELDS)[number]['key'];
export const DEFAULT_CAREER_MAPPING: Record<CareerTargetField, string> = Object.fromEntries(CAREER_TARGET_FIELDS.map((f) => [f.key, f.default])) as Record<CareerTargetField, string>;

/** A website field path: letters, digits, _ and -, with dots for nested fields (cv.url, extra.portfolio). */
const fieldPath = z.string().trim().max(120).regex(/^$|^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'Use the website field name, with dots for nested fields (cv.url)');

const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const optUrl = z.string().trim().max(500).optional().nullable().transform((v) => (v ? v : null));

export const careerIntegrationInput = z.object({
  websiteName: z.string().trim().min(2).max(120),
  websiteUrl: z.string().trim().url().max(300),
  /** Where SampCrew sends status updates (the website's SampCrew webhook). */
  statusWebhookUrl: optUrl,
  enabled: z.boolean().default(true),
  sendStatusUpdates: z.boolean().default(true),
  defaultHrWorkspaceId: z.uuid().optional().nullable().transform((v) => v ?? null),
  defaultHrMembershipId: z.uuid().optional().nullable().transform((v) => v ?? null),
  defaultRecruiterMembershipId: z.uuid().optional().nullable().transform((v) => v ?? null),
  /** Move every new applicant into the Candidate CRM straight away (off: HR moves them by hand). */
  autoMoveToCrm: z.boolean().default(false),
  /** Send the candidate SampCrew's "we received your application" email (off when the website already does). */
  candidateAcknowledgement: z.boolean().default(false),
  notifyOnNew: z.boolean().default(true),
  notifySuperWorkspace: z.boolean().default(true),
}).strict();
export type CareerIntegrationInput = z.infer<typeof careerIntegrationInput>;

export const careerMappingInput = z.object({
  mapping: z.record(z.enum(CAREER_TARGET_FIELDS.map((f) => f.key) as [CareerTargetField, ...CareerTargetField[]]), fieldPath),
}).strict();

export const careerStagesInput = z.object({
  stages: z.array(z.object({
    key: z.string().trim().regex(/^[a-z0-9_]{1,40}$/),
    label: z.string().trim().min(2).max(60),
    kind: z.enum(CAREER_STAGE_KINDS),
    active: z.boolean(),
  }).strict()).min(3).max(30),
}).strict();

// ---------------------------------------------------------------------------------------------------------------
// Working with applications
// ---------------------------------------------------------------------------------------------------------------

export const careerListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  stage: z.string().trim().max(40).optional(),
  position: z.string().trim().max(160).optional(),
  department: z.string().trim().max(160).optional(),
  kind: z.enum(['application', 'enquiry']).optional(),
  assigned: z.enum(['me', 'none']).optional(),
  crm: z.enum(['in', 'out']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  sort: z.enum(['recent', 'oldest', 'name', 'stage']).default('recent'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();
export type CareerListQuery = z.infer<typeof careerListQuery>;

export const careerStatusInput = z.object({
  stage: z.string().trim().min(1).max(40),
  comment: optText(1000),
}).strict();

export const careerAssignInput = z.object({
  hrMembershipId: z.uuid().optional().nullable(),
  recruiterMembershipId: z.uuid().optional().nullable(),
  /** Super Workspace only: hand the application to an HR Workspace (null: the company-wide HR team). */
  hrWorkspaceId: z.uuid().optional().nullable(),
}).strict();

export const careerNoteInput = z.object({
  kind: z.enum(['internal', 'comment']).default('internal'),
  body: z.string().trim().min(1).max(4000),
}).strict();

const when = z.iso.datetime({ offset: true, local: true });

export const careerCallInput = z.object({
  outcome: z.enum(CAREER_CALL_OUTCOMES.map((o) => o[0]) as [CareerCallOutcome, ...CareerCallOutcome[]]),
  calledAt: when.optional(),
  durationMinutes: z.number().int().min(0).max(600).optional().nullable().transform((v) => v ?? null),
  notes: optText(3000),
  nextFollowUpAt: when.optional().nullable().transform((v) => v ?? null),
  followUpNote: optText(300),
  /** Move the application to this stage after the call. */
  stage: z.string().trim().max(40).optional().nullable().transform((v) => v || null),
}).strict();
export type CareerCallInput = z.infer<typeof careerCallInput>;

export const careerInterviewInput = z.object({
  startsAt: when,
  durationMinutes: z.number().int().min(10).max(480).default(45),
  type: z.enum(CAREER_INTERVIEW_TYPES.map((t) => t[0]) as [CareerInterviewType, ...CareerInterviewType[]]),
  interviewerMembershipId: z.uuid().optional().nullable().transform((v) => v ?? null),
  interviewerName: optText(120),
  meetingLink: z.string().trim().url().max(500).optional().nullable().or(z.literal('')).transform((v) => v || null),
  location: optText(300),
  notes: optText(2000),
  /** Tell the candidate by email. */
  notifyCandidate: z.boolean().default(false),
}).strict();
export type CareerInterviewInput = z.infer<typeof careerInterviewInput>;

export const careerInterviewUpdate = z.object({
  action: z.enum(['reschedule', 'cancel', 'complete']),
  startsAt: when.optional(),
  durationMinutes: z.number().int().min(10).max(480).optional(),
  reason: optText(500),
  feedback: optText(3000),
  notifyCandidate: z.boolean().default(false),
}).strict();

export const careerEmailInput = z.object({
  subject: z.string().trim().min(2).max(200),
  body: z.string().trim().min(2).max(8000),
}).strict();

export const careerFollowUpInput = z.object({
  dueAt: when,
  note: optText(300),
  assignedMembershipId: z.uuid().optional().nullable().transform((v) => v ?? null),
}).strict();

export const careerNotificationKinds = [
  'career.application_received', 'career.enquiry_received', 'career.assigned_hr', 'career.assigned_recruiter', 'career.status_changed',
  'career.interview_scheduled', 'career.interview_rescheduled', 'career.interview_cancelled', 'career.interview_reminder', 'career.follow_up_due',
  'career.moved_to_crm', 'career.sync_failed',
] as const;

/** CE-000123. */
export const formatCareerCode = (n: number) => `CE-${String(n).padStart(6, '0')}`;

/** A readable length of service from what the website sent ("5", "5 years", "3-5", "Fresher"): kept as the text sent. */
export const experienceShown = (v: string | null | undefined) => {
  if (!v) return null;
  return /^\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()} years` : v.trim();
};
