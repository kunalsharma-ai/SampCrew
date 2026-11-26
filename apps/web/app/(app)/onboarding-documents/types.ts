import type { OnboardingDocStatus, OnboardingRequirement, RequestFileFormat } from '@crew/contracts';

export interface LibraryItem {
  id: string; key: string; categoryId: string; name: string; requirement: OnboardingRequirement; requirementLabel: string;
  description: string | null; instructions: string | null; formats: RequestFileFormat[]; maxMb: number; multiple: boolean; maxFiles: number;
  verification: string | null; sensitive: boolean; active: boolean; builtIn: boolean;
}

export interface LibraryTemplate {
  id: string; key: string; name: string; description: string | null; isDefault: boolean; active: boolean; builtIn: boolean;
  items: { itemId: string; required: boolean }[]; employmentTypes: string[]; departments: { id: string; name: string | null }[];
}

export interface Library {
  level: 'super' | 'hr';
  canManage: boolean;
  categories: { id: string; key: string; name: string; description: string | null; builtIn: boolean; items: number }[];
  items: LibraryItem[];
  templates: LibraryTemplate[];
  requests: { id: string; kind: 'document' | 'permission'; name: string | null; reason: string; status: string; requirement: string | null; hrWorkspace: string | null; decisionNote: string | null; createdAt: string; decidedAt: string | null }[];
}

export interface AssignOptions {
  suggestedTemplateId: string | null;
  categories: { id: string; name: string }[];
  items: LibraryItem[];
  templates: { id: string; name: string; description: string | null; isDefault: boolean; departmentIds: string[]; employmentTypes: string[]; items: { itemId: string; required: boolean }[] }[];
}

export interface Progress {
  total: number; mandatory: number; submitted: number; pendingApproval: number; approved: number; mandatoryApproved: number;
  notSubmitted: number; rejected: number; percent: number; complete: boolean;
}

export interface ChecklistItem {
  requestId: string; taskId: string | null; reference: string; title: string; description: string | null; instructions: string | null; verification: string | null;
  requirement: OnboardingRequirement; mandatory: boolean; formats: RequestFileFormat[]; maxMb: number; maxFiles: number; expiryRequired: boolean; category: string | null; categoryName: string | null;
  status: OnboardingDocStatus; statusLabel: string; approved: boolean; hrComment: string | null; submissions: number;
  lastSubmittedAt: string | null; decidedAt: string | null; dueOn: string | null;
  files: { id: string; fileName: string; sizeBytes: number; contentType: string; version: number }[];
}

export interface Checklist {
  id: string; status: 'active' | 'completed' | 'cancelled'; templateName: string | null;
  employee: { id: string; name: string; code: string | null; status: string; dateOfJoining: string } | null;
  hrWorkspace: string | null; dueOn: string | null; note: string | null; assignedAt: string; completedAt: string | null; allSubmittedAt: string | null;
  progress: Progress; items: ChecklistItem[]; mine: boolean; canReview: boolean;
}

export interface ChecklistRow {
  id: string; status: string;
  employee: { id: string; name: string; code: string | null; department: string | null; dateOfJoining: string };
  hrWorkspace: string | null; templateName: string | null; total: number; approved: number; pendingApproval: number; percent: number; mandatory: number;
  dueOn: string | null; assignedAt: string; completedAt: string | null;
}
