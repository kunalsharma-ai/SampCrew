import type { DocumentAccess, RequestFileFormat } from '@crew/contracts';

export interface DocRow {
  id: string;
  reference: string;
  title: string;
  typeKey: string | null;
  typeName: string | null;
  /** The original profile category (id_proof, contract ...). */
  category: string;
  /** The document group (identity, employment ...). */
  group: string;
  categoryName: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sensitive: boolean;
  visibility: string;
  ownerType: 'employee' | 'hr_workspace';
  employee: { id: string; name: string; code: string | null } | null;
  hrWorkspace: { id: string; name: string | null } | null;
  submittedBy: string | null;
  requestedBy: { level: string; label: string; name: string | null; designation: string | null } | null;
  requestId: string | null;
  requestReference: string | null;
  status: string;
  statusLabel: string;
  verificationStatus: string | null;
  verificationRemarks: string | null;
  verifiedBy: { name: string | null; designation: string | null; level: string | null } | null;
  verifiedAt: string | null;
  expiresOn: string | null;
  expired: boolean;
  version: number;
  previousDocumentId: string | null;
  supersededAt: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
  can: { preview: boolean; download: boolean };
}

export interface HistoryRow {
  id: string; action: string; at: string; by: string | null; byDesignation: string | null; level: string; comment: string | null;
  documentId: string | null; requestId: string | null; metadata: Record<string, unknown>;
}

export interface TrailStep { seq: number; status: string; approver: string | null; decidedBy: string | null; decidedAt: string | null; comment: string | null }

export interface RequestRow {
  id: string;
  reference: string;
  targetType: 'employee' | 'hr_workspace';
  employee: { id: string; name: string; code: string | null } | null;
  hrWorkspace: { id: string; name: string | null } | null;
  assignee: { membershipId: string; name: string | null } | null;
  typeKey: string;
  typeName: string;
  category: string;
  categoryName: string;
  title: string;
  instructions: string | null;
  reason: string;
  dueOn: string | null;
  priority: string;
  formats: RequestFileFormat[];
  maxMb: number;
  expiryRequired: boolean;
  replacesDocumentId: string | null;
  requestedBy: { level: string; label: string; name: string | null; designation: string | null; accessLevel: string | null; membershipId: string };
  status: string;
  displayStatus: string;
  statusLabel: string;
  overdue: boolean;
  document: { id: string; reference: string; fileName: string; version: number; status: string; sizeBytes: number; contentType: string; expiresOn: string | null } | null;
  submittedAt: string | null;
  submittedBy: string | null;
  submissions: number;
  reviewer: { name: string | null; designation: string | null } | null;
  reviewerComment: string | null;
  decidedAt: string | null;
  completedAt: string | null;
  cancelledReason: string | null;
  taskId: string | null;
  approvalRequestId: string | null;
  createdAt: string;
  isMine: boolean;
  raisedByMe: boolean;
  canReview: boolean;
}

export interface RequestDetail extends RequestRow {
  versions: DocRow[];
  history: HistoryRow[];
  approvalTrail: TrailStep[];
  canCancel: boolean;
}

export interface DocDetail extends DocRow {
  submitterRemarks: string | null;
  versions: DocRow[];
  request: RequestRow | null;
  history: HistoryRow[];
  approvalTrail: TrailStep[];
  canRequestReplacement: boolean;
}

export interface Overview {
  level: string; total: number; approved: number; pending: number; rejected: number; correction: number; expired: number;
  hrWorkspaceDocuments: number; employeeDocuments: number; pendingRequests: number; overdueRequests: number; awaitingMyVerification: number;
}

export interface MyDocAccess {
  level: 'super_workspace' | 'hr_workspace' | 'employee_workspace';
  access: DocumentAccess | null;
  hrWorkspaces: { id: string; name: string | null; access: DocumentAccess }[];
  companyWide: boolean;
  employeeId: string | null;
}

export interface Catalogue {
  groups: { key: string; name: string; description: string | null; builtIn: boolean }[];
  types: { key: string; name: string; category: string; sensitive: boolean; owners: ('employee' | 'hr_workspace')[]; builtIn: boolean }[];
  canManage: boolean;
}

export interface Targets {
  employees: { id: string; name: string; code: string | null; departmentName: string | null; hrWorkspaceName: string | null; hasLogin: boolean }[];
  hrWorkspaces: { id: string; name: string; admins: { membershipId: string; name: string | null }[] }[];
}
