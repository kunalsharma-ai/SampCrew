import { atsSourceOf, type CrmCandidatePatch, experienceText, noticeDays, noticeText } from '@crew/contracts';
import { candidateName } from '../recruitment/recruitment-common';
import type { Doc } from './crm-common';

/**
 * How the candidate form maps onto the candidate document. Fields people search, filter and sort on are columns;
 * each form section's other answers are kept together (personal, professional ...), so adding a question to a
 * section never needs a migration.
 */

/** Personal answers. The first three are sensitive: only Super Workspace and HR Workspaces given the power see them. */
export const SENSITIVE_PERSONAL = ['gender', 'dateOfBirth', 'nationality'] as const;
const PERSONAL = [...SENSITIVE_PERSONAL, 'alternateEmail', 'alternatePhone', 'whatsapp', 'address', 'postalCode', 'contactMethod', 'contactTime', 'languages'] as const;
const PROFESSIONAL = [
  'previousCompany', 'employmentStatus', 'employmentType', 'seniority', 'teamFunction', 'primarySkills', 'secondarySkills', 'technicalSkills', 'softSkills',
  'certifications', 'highestQualification', 'specialization', 'institution', 'graduationYear', 'summary',
] as const;
const COLUMNS: Record<string, string> = {
  firstName: 'first_name', middleName: 'middle_name', lastName: 'last_name', email: 'email', phone: 'phone', city: 'city', state: 'state', country: 'country_code',
  currentLocation: 'location_text', profession: 'profession', currentTitle: 'current_title', industry: 'industry', department: 'department_name', jobRole: 'job_role',
  currentCompany: 'current_company', totalExperienceMonths: 'total_experience_months', relevantExperienceMonths: 'relevant_experience_months', sourceDetail: 'source_detail',
  tags: 'tags', assignedRecruiterMembershipId: 'assigned_recruiter_membership_id',
};

/** True when the change sets a sensitive personal answer. */
export const touchesSensitive = (p: Doc) => SENSITIVE_PERSONAL.some((k) => p[k] !== undefined && p[k] !== null && p[k] !== '');

/**
 * The document fields for a new candidate or a change. `existing` is the stored candidate when changing it: section
 * answers not in the change are kept, and the search columns (skills, notice days) are recomputed from the result.
 */
export function docFields(p: Partial<CrmCandidatePatch> & Doc, existing?: Doc): Doc {
  const set: Doc = {};
  for (const [k, col] of Object.entries(COLUMNS)) if (p[k] !== undefined) set[col] = p[k];
  if (p.lastName !== undefined) set.last_name = p.lastName ?? '';

  const personal = { ...(existing?.personal ?? {}) };
  let personalChanged = false;
  for (const k of PERSONAL) if (p[k] !== undefined) { personal[k] = p[k]; personalChanged = true; }
  if (personalChanged || !existing) set.personal = personal;

  const professional = { ...(existing?.professional ?? {}) };
  let profChanged = false;
  for (const k of PROFESSIONAL) if (p[k] !== undefined) { professional[k] = p[k]; profChanged = true; }
  if (profChanged || !existing) {
    set.professional = professional;
    const all = ['primarySkills', 'secondarySkills', 'technicalSkills', 'softSkills'].flatMap((k) => (professional[k] ?? []) as string[]);
    set.skills = [...new Set(all.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  }

  if (p.compensation !== undefined) {
    const { currency, basis, currentCtc, expectedCtc, ...rest } = p.compensation ?? ({} as Doc);
    set.comp_currency = currency ?? 'INR';
    set.comp_basis = basis ?? 'annual';
    set.current_ctc = currentCtc ?? null;
    set.expected_ctc = expectedCtc ?? null;
    set.compensation = rest;
  } else if (!existing) set.compensation = {};
  if (p.notice !== undefined) {
    set.notice = p.notice ?? {};
    set.notice_days = noticeDays(p.notice);
  } else if (!existing) set.notice = {};
  for (const k of ['preferences', 'insights', 'links'] as const) {
    if (p[k] !== undefined) set[k] = p[k] ?? {};
    else if (!existing) set[k] = {};
  }
  if (p.links !== undefined) set.profile_url = p.links?.linkedin ?? p.links?.portfolio ?? p.links?.website ?? null;
  if (p.source !== undefined) {
    set.crm_source = p.source;
    set.source = existing?.source === 'career_site' ? 'career_site' : atsSourceOf(p.source);
  }
  return set;
}

/** Text written in the list (and exports) for compensation. */
export function moneyCell(v: unknown, currency?: string | null) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if ((currency ?? 'INR') === 'INR' && n >= 100000) return `₹${(n / 100000).toFixed(2).replace(/\.0+$|(\.\d)0$/, '$1')} L`;
  return `${currency ?? ''} ${n.toLocaleString('en-IN')}`.trim();
}

/** The full candidate as the profile and the edit form read it. Sensitive answers are left out without the power. */
export function profileView(c: Doc, sensitive: boolean) {
  const personal = { ...(c.personal ?? {}) } as Doc;
  if (!sensitive) for (const k of SENSITIVE_PERSONAL) delete personal[k];
  const professional = (c.professional ?? {}) as Doc;
  return {
    id: c.id as string,
    candidateCode: (c.candidate_code as string | null) ?? null,
    name: candidateName(c),
    firstName: c.first_name as string, middleName: c.middle_name ?? null, lastName: c.last_name as string,
    email: c.email ?? null, phone: c.phone ?? null,
    ...emptyPersonal(), ...personal,
    city: c.city ?? null, state: c.state ?? null, country: c.country_code ?? null, currentLocation: c.location_text ?? null,
    profession: c.profession ?? null, currentTitle: c.current_title ?? null, industry: c.industry ?? null, department: c.department_name ?? null,
    jobRole: c.job_role ?? null, currentCompany: c.current_company ?? null,
    totalExperienceMonths: c.total_experience_months ?? null, relevantExperienceMonths: c.relevant_experience_months ?? null,
    experienceText: experienceText(c.total_experience_months), relevantExperienceText: experienceText(c.relevant_experience_months),
    ...emptyProfessional(), ...professional,
    compensation: { currency: c.comp_currency ?? 'INR', basis: c.comp_basis ?? 'annual', currentCtc: c.current_ctc ?? null, expectedCtc: c.expected_ctc ?? null, ...(c.compensation ?? {}) },
    notice: c.notice ?? {}, noticeDays: c.notice_days ?? null, noticeText: noticeText(c.notice),
    preferences: c.preferences ?? {}, insights: c.insights ?? {}, links: c.links ?? {},
    source: c.crm_source ?? c.source ?? null, atsSource: c.source, sourceDetail: c.source_detail ?? null, tags: (c.tags ?? []) as string[],
    referenceTypes: (c.reference_types ?? []) as string[],
    stage: (c.crm_stage as string | null) ?? 'new', stageEnteredAt: c.crm_stage_entered_at ?? null,
    assignedRecruiterMembershipId: c.assigned_recruiter_membership_id ?? null,
    hrWorkspaceId: c.crm_hr_workspace_id ?? null, sharedHrWorkspaceIds: (c.crm_shared_hr_workspace_ids ?? []) as string[],
    nextFollowUpAt: c.next_follow_up_at ?? null, lastActivityAt: c.last_activity_at ?? null,
    hasPhoto: !!c.photo_storage_key, archivedAt: c.crm_archived_at ?? null, anonymizedAt: c.anonymized_at ?? null,
    consentBasis: c.consent_basis, consentAt: c.consent_at,
    createdAt: c.created_at, updatedAt: c.updated_at, createdByMembershipId: c.created_by_membership_id ?? null, updatedByMembershipId: c.updated_by_membership_id ?? null,
    sensitiveHidden: !sensitive,
  };
}

const emptyPersonal = () => ({ alternateEmail: null, alternatePhone: null, whatsapp: null, address: null, postalCode: null, contactMethod: null, contactTime: null, languages: [] as string[] });
const emptyProfessional = () => ({
  previousCompany: null, employmentStatus: null, employmentType: null, seniority: null, teamFunction: null, primarySkills: [] as string[], secondarySkills: [] as string[],
  technicalSkills: [] as string[], softSkills: [] as string[], certifications: [] as string[], highestQualification: null, specialization: null, institution: null,
  graduationYear: null, summary: null,
});

export type CrmProfile = ReturnType<typeof profileView>;
