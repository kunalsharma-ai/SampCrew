export type TargetState = 'none' | 'on_time' | 'due_soon' | 'overdue' | 'met' | 'missed';

export interface Category {
  id: string;
  name: string;
  description: string;
  confidential: boolean;
  firstResponseHours: number | null;
  resolutionHours: number | null;
  archivedAt: string | null;
  articleCount: number;
  handlers?: { membershipId: string; name: string }[];
}

export interface Handler { membershipId: string; name: string; scope: string }

export interface Article { id: string; categoryId: string | null; categoryName: string | null; title: string; excerpt?: string; body?: string; published: boolean; updatedAt: string }

export interface CaseRow {
  id: string;
  ref: string;
  employeeId: string;
  employeeName: string;
  categoryId: string;
  categoryName: string;
  confidential: boolean;
  subject: string;
  priority: string;
  status: string;
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  reopenedCount: number;
  satisfaction: number | null;
  satisfactionComment: string | null;
  createdAt: string;
  updatedAt: string;
  firstResponse: TargetState;
  resolution: TargetState;
}

export interface CaseDetail extends CaseRow {
  description: string;
  role: 'handler' | 'requester';
  messages: { id: string; body: string; internal: boolean; createdAt: string; authorName: string; mine: boolean; fromHr: boolean }[];
  history: { action: string; from: string | null; to: string | null; createdAt: string; byName: string; toName: string | null }[];
  moves: string[];
  can: { reply: boolean; internalNote: boolean; assign: boolean; rate: boolean };
}

export interface Summary { mine: { open: number; waiting: number; resolved: number }; assignedToMe: number | null }

export interface Announcement {
  id: string;
  title: string;
  body: string;
  legalEntityId: string | null;
  legalEntityName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  requiresAck: boolean;
  pinned: boolean;
  status: 'draft' | 'published' | 'archived';
  publishedAt: string | null;
  expiresOn: string | null;
  createdAt: string;
  publishedByName: string | null;
  readAt?: string | null;
  acknowledgedAt?: string | null;
  readCount?: number;
  ackCount?: number;
  audienceSize?: number;
}
