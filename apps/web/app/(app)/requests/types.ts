import type { RequestCategory, RequestKindDef, RequestPerson, RequestSettings, RequestView, RequestWorkflow } from '@crew/contracts';

export interface RequestOptions {
  categories: RequestCategory[];
  kinds: RequestKindDef[];
  me: RequestPerson & { dateOfJoining: string | null };
  reportingManager: RequestPerson | null;
  hrManager: RequestPerson | null;
  hasEmployeeRecord: boolean;
  suggested: RequestPerson[];
  defaults: { primaryApproverId: string | null; additionalApproverIds: string[] };
  leaveTypes: { id: string; name: string; code: string; color: string; available: string | null; notAssigned: boolean; allowHalfDay: boolean; kind: string }[];
  approvedLeaveCancellation: 'approval' | 'before_start';
}
export type RequestCounts = { all: number; pending: number; changes_requested: number; approved: number; rejected: number; cancelled: number };
export interface RequestList { counts: RequestCounts; items: RequestView[] }
export interface ApprovalsList { counts: RequestCounts; oversees: boolean; items: RequestView[] }
export interface RequestSummary { pending: number; changesRequested: number; toDecide: number }
export interface RequestSettingsView { settings: RequestSettings; canManage: boolean; workflows: Record<RequestWorkflow, string> }
export interface MyDayRequests {
  counts: { pending: number; changesRequested: number; approved: number };
  recent: RequestView[];
  decisions: { id: string; requestId: string; ref: string; title: string; requester: string; action: string; comment: string | null; at: string }[];
}
export interface UploadedDoc { id: string; name: string; size: number }
