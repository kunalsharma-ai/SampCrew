import type { CrmContext, CrmFieldFlag, CustomFieldDefinition } from '@crew/contracts';

export type { CrmContext };

/** A row of the candidate list and a pipeline card (API: GET /recruitment/crm/candidates). */
export interface CrmRow {
  id: string; candidateCode: string | null; name: string; email: string | null; phone: string | null;
  profession: string | null; currentTitle: string | null; currentCompany: string | null;
  experienceMonths: number | null; experience: string; currency: string; basis: string;
  currentCtc: string | null; expectedCtc: string | null; currentCtcText: string; expectedCtcText: string;
  notice: string; noticeDays: number | null; location: string | null; reference: string | null; referenceTypes: string[];
  stage: string; stageLabel: string; stageKind: string; stageEnteredAt: string | null;
  recruiterId: string | null; recruiter: string | null; nextFollowUpAt: string | null; lastActivityAt: string | null;
  source: string | null; sourceLabel: string; industry: string | null; department: string | null; jobRole: string | null;
  hrWorkspaceId: string | null; hrWorkspace: string; tags: string[]; hasPhoto: boolean; archivedAt: string | null;
  createdAt: string; updatedAt: string; activeApplications: number; custom: Record<string, string>;
}

export interface CrmList { total: number; offset: number; limit: number; rows: CrmRow[] }

export interface CrmField extends CustomFieldDefinition {
  name: string; description: string | null; placeholder: string | null; flags: CrmFieldFlag[];
  hrWorkspaceId: string | null; hrWorkspaceName: string | null; valueCount?: number; canEdit: boolean;
}

export interface FollowUp {
  id: string; candidateId: string; type: string; typeLabel: string; dueAt: string; status: string; priority: string;
  reason: string | null; notes: string | null; outcome: string | null; reminderMinutes: number | null;
  assignedMembershipId: string | null; assignedTo: string | null; createdBy: string | null; createdAt: string;
  completedAt: string | null; completedBy: string | null; overdue: boolean;
  candidateName?: string; candidateCode?: string | null; candidatePhone?: string | null; candidateStage?: string | null; candidateTitle?: string | null;
}

export interface Activity {
  id: string; kind: string; automatic: boolean; subject: string | null; outcome: string | null; outcomeLabel?: string | null; remarks: string | null;
  durationMinutes: number | null; detail: Record<string, unknown>; text: string; occurredAt: string; by: string | null;
  candidateId?: string; candidateName?: string; candidateCode?: string | null;
}

export interface CrmDocument {
  id: string; kind: string; kindLabel?: string; name: string; fileName: string; contentType: string; sizeBytes: number; version: number;
  notes: string | null; uploadedAt: string; uploadedBy: string | null; previewable: boolean; versions?: CrmDocument[];
}

/** The 360° profile (API: GET /recruitment/crm/candidates/:id). */
export interface CrmProfile {
  candidate: Record<string, unknown> & {
    id: string; candidateCode: string | null; name: string; firstName: string; lastName: string; email: string | null; phone: string | null;
    stage: string; stageLabel: string; stageEnteredAt: string | null; hrWorkspaceId: string | null; hrWorkspaceName: string;
    sharedWith: { id: string; name: string }[]; recruiterName: string | null; assignedRecruiterMembershipId: string | null;
    compensation: Record<string, unknown>; notice: Record<string, unknown>; preferences: Record<string, unknown>; insights: Record<string, unknown>;
    links: Record<string, unknown> & { other?: { label: string; url: string }[] }; tags: string[]; source: string | null; hasPhoto: boolean; archivedAt: string | null;
    anonymizedAt: string | null; createdAt: string; updatedAt: string; createdByName: string | null; updatedByName: string | null; nextFollowUpAt: string | null;
    lastActivityAt: string | null; experienceText: string; relevantExperienceText: string; noticeText: string; sensitiveHidden: boolean;
  };
  references: { id: string; type: string; typeLabel: string; name: string | null; phone: string | null; email: string | null; company: string | null; relationship: string | null; details: string | null; createdAt: string; createdBy: string | null }[];
  remarks: { id: string; body: string; category: string; categoryLabel: string; restricted: boolean; createdAt: string; author: string | null; authorLevel: string | null; authorHrWorkspace: string | null }[];
  documents: CrmDocument[];
  followUps: FollowUp[];
  activities: Activity[];
  applications: { id: string; requisitionId: string; requisitionCode: string | null; requisitionTitle: string | null; stage: string | null; status: string; appliedAt: string; offerStatus: string | null; interviews: { id: string; title: string; startsAt: string; status: string; mode: string }[] }[];
  customFields: { key: string; label: string; type: string; group: string | null; value: unknown; text: string }[];
  can: { edit: boolean; archive: boolean; share: boolean; sensitive: boolean; export: boolean; openAts: boolean };
}

export interface Overview {
  totals: { candidates: number; addedThisMonth: number; addedToday: number; inProgress: number; joined: number; closed: number; onHold: number; archived: number; unassigned: number };
  conversion: { interviewRate: number; joinRate: number };
  followUps: { overdue: number; today: number; upcoming: number; completedThisWeek: number; missedThisWeek: number };
  myDay: { id: string; candidateId: string; candidateName: string; candidateCode: string | null; dueAt: string; type: string; priority: string; overdue: boolean }[];
  stages: { key: string; label: string; kind: string; count: number }[];
  sources: { key: string; label: string; count: number }[];
  weeks: { week: string; added: number; joined: number }[];
  recruiters: { membershipId: string; name: string; assigned: number; open: number; joined: number; pendingFollowUps: number; overdueFollowUps: number; activities30: number; calls30: number }[];
  recent: { id: string; candidateId: string; candidateName: string; candidateCode: string | null; kind: string; automatic: boolean; outcome: string | null; subject: string | null; detail: string; occurredAt: string; by: string | null }[];
}
