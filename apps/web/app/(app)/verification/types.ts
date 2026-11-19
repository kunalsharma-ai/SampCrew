export interface CaseRow {
  id: string;
  reference: string;
  employeeId: string;
  employeeName: string | null;
  employeeCode: string | null;
  department: string | null;
  method: 'internal' | 'external';
  agencyName: string | null;
  status: string;
  checks: { total: number; done: number; failed: number; types: string[] };
  dueDate: string | null;
  overdue: boolean;
  completedOn: string | null;
  assignee: string | null;
  createdAt: string;
}

export interface Agency {
  id: string;
  name: string;
  contactName: string | null;
  email: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  services: string[];
  turnaroundDays: number | null;
  notes: string | null;
  active: boolean;
}

export interface CaseDetail {
  id: string;
  reference: string;
  method: 'internal' | 'external';
  status: string;
  employee: { id: string; name: string; code: string | null; department: string | null; designation: string | null; dateOfJoining: string | null };
  agency: Agency | null;
  agencyReference: string | null;
  sentToAgencyAt: string | null;
  dueDate: string | null;
  completedOn: string | null;
  notes: string | null;
  assignee: { membershipId: string; name: string | null } | null;
  decision: { remarks: string | null; by: string | null; at: string } | null;
  cancelledReason: string | null;
  createdBy: string | null;
  createdAt: string;
  checks: {
    id: string;
    type: string;
    label: string;
    status: string;
    details: Record<string, string>;
    documents: { id: string; title: string; archived: boolean }[];
    remarks: string | null;
    agencyFeedback: string | null;
    verifiedBy: string | null;
    verifiedAt: string | null;
  }[];
  files: { id: string; title: string; kind: string; checkId: string | null; fileName: string; sizeBytes: number; sharedWithAgency: boolean; uploadedBy: string | null; createdAt: string }[];
  history: { id: string; action: string; checkId: string | null; from: string | null; to: string | null; note: string | null; by: string | null; at: string }[];
  agencyLinks: { id: string; expiresAt: string; active: boolean; revokedAt: string | null; lastUsedAt: string | null; submittedAt: string | null }[];
  can: { edit: boolean; approve: boolean; delete: boolean };
}

export interface Verifier { membershipId: string; name: string }
