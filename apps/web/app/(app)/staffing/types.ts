import type { BidPricing, BidStatus } from '@crew/contracts';

export interface Client {
  id: string; name: string; legalName: string | null; industry: string | null; contactName: string | null; contactEmail: string | null;
  contactPhone: string | null; address: string | null; currency: string; notes: string | null; archivedAt: string | null; bidCount: number; wonCount: number;
}
export interface BidTemplate {
  id: string; name: string; coverNote: string; terms: string; validityDays: number; onCostPct: string; overheadPct: string; targetMarginPct: string; isDefault: boolean;
}
export interface BidSummary {
  id: string; code: string; title: string; status: BidStatus; mode: string; currency: string; headcount: number; monthlyRevenue: string; contractRevenue: string;
  marginPct: string; targetMarginPct: string; durationMonths: number; startDate: string; version: number; sentAt: string | null; updatedAt: string;
  clientId: string; clientName: string; ownerName: string;
}
export interface BidLine { roleTitle: string; designationId: string | null; headcount: number; location: string | null; payMonthly: string; billMonthly: string | null; notes: string | null }
export interface Bid {
  id: string; code: string; title: string; status: BidStatus; mode: 'quick' | 'advanced'; currency: string; clientId: string; legalEntityId: string;
  startDate: string; durationMonths: number; onCostPct: string; overheadPct: string; targetMarginPct: string; templateId: string | null; coverNote: string; terms: string;
  validUntil: string | null; version: number; clientName: string; clientContact: string | null; clientEmail: string | null; legalEntityName: string; ownerName: string;
  submittedAt: string | null; approvedAt: string | null; sentAt: string | null; decidedAt: string | null; outcomeReason: string | null; createdAt: string; updatedAt: string;
  lines: BidLine[]; pricing: BidPricing;
  versions: { id: string; version: number; event: 'submitted' | 'sent'; createdAt: string; createdBy: string | null; hasPdf: boolean; pricing: BidPricing }[];
  emails: { id: string; versionId: string; to: string; cc: string[]; subject: string; sendAt: string; cancelledAt: string | null; createdAt: string; delivery: { status: string; sentAt: string | null; error: string | null }[] }[];
  approval: { id: string; status: string; steps: { seq: number; status: string; role: string | null; approver: string | null; decidedBy: string | null; decidedAt: string | null; comment: string | null }[] } | null;
  can: { edit: boolean; submit: boolean; send: boolean; decide: boolean; withdraw: boolean; delete: boolean };
}

export const BID_STATUS_LABEL: Record<BidStatus, string> = {
  draft: 'Draft', pending_approval: 'Waiting for approval', approved: 'Approved', rejected: 'Changes needed', sent: 'Sent', won: 'Won', lost: 'Lost', withdrawn: 'Withdrawn',
};
export const BID_STATUS_TONE: Record<BidStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral', pending_approval: 'warning', approved: 'info', rejected: 'danger', sent: 'info', won: 'success', lost: 'neutral', withdrawn: 'neutral',
};
