import type { AnnouncementCategory, AnnouncementPriority, AnnouncementStatus, AudienceInput } from '@crew/contracts';
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
  messages: { id: string; body: string; internal: boolean; createdAt: string; authorName: string; mine: boolean; fromHr: boolean; aiDrafted?: boolean }[];
  history: { action: string; from: string | null; to: string | null; createdAt: string; byName: string; toName: string | null }[];
  moves: string[];
  can: { reply: boolean; internalNote: boolean; assign: boolean; rate: boolean };
}

export interface Summary { mine: { open: number; waiting: number; resolved: number }; assignedToMe: number | null; queue: { awaitingHr: number; unassigned: number } | null }

export interface AnnouncementFile { id: string; name: string; type: string; size: number; href: string }

export interface Announcement {
  id: string;
  title: string;
  body: string;
  /** Rich text, cleaned on the server (older announcements have only plain text). */
  html: string | null;
  audience: AudienceInput | null;
  audienceLabel: string;
  legalEntityId: string | null;
  legalEntityName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  category: AnnouncementCategory;
  categoryLabel: string;
  priority: AnnouncementPriority;
  files: AnnouncementFile[];
  requiresAck: boolean;
  pinned: boolean;
  status: AnnouncementStatus;
  publishedAt: string | null;
  publishAt: string | null;
  expiresOn: string | null;
  createdAt: string;
  publishedByName: string | null;
  scheduledByName: string | null;
  version: number;
  editedAt: string | null;
  editedByName: string | null;
  deletedAt: string | null;
  readAt?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedEarlierAt?: string | null;
  needsAck?: boolean;
  readCount?: number;
  ackCount?: number;
  audienceSize?: number;
}
