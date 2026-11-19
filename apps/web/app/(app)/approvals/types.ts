export interface ApprovalCard {
  key: string; label: string; description: string; icon: string; color: string; builtIn: boolean;
  total: number; pending: number; approved: number; rejected: number; cancelled: number;
  recent: { id: string; summary: string; status: string; createdAt: string }[];
}
export interface ApprovalOverview { view: 'waiting' | 'decided' | 'mine'; total: number; pending: number; categories: ApprovalCard[] }
export interface ApprovalRow {
  id: string; ref: string; resourceType: string; resourceId: string; label: string; category: string; categoryLabel: string; summary: string; status: string;
  autoApproved: boolean; statusMessage: string; waitingOn: string | null; stepSeq: number | null; stepCount: number; requestedBy: string | null; subjectName: string | null;
  createdAt: string; decidedAt: string | null; link: string | null;
}
export interface ApprovalStep { seq: number; kind: string; status: string; role: string | null; approver: string | null; decidedBy: string | null; decidedAt: string | null; comment: string | null }
export interface ApprovalDetail extends ApprovalRow {
  details: Record<string, unknown> | null;
  documents: { name: string; href: string }[];
  trail: ApprovalStep[];
  finalDecision: { status: string; at: string | null; by: string | null; remarks: string | null } | null;
  canDecide: boolean;
  mine: boolean;
}
