export interface PrivacyRequestRow {
  id: string;
  kind: 'access' | 'erasure';
  status: 'open' | 'completed' | 'rejected';
  source: string;
  dueOn: string;
  createdAt: string;
  completedAt: string | null;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  employeeStatus: string;
  overdue?: boolean;
}
export interface PrivacyRequest extends PrivacyRequestRow {
  decisionNote: string | null;
  result: { records?: Record<string, number>; bytes?: number; skipped?: string[]; removed?: Record<string, number> } | null;
  exportSha256: string | null;
  hasExport: boolean;
  lastWorkingDay: string | null;
  erasedAt: string | null;
  requestedBy: string;
  decidedBy: string | null;
  erasureRules: { area: string; action: 'erased' | 'kept'; detail: string }[];
}
export const KIND = { access: 'Copy of their data', erasure: 'Erase their data' } as const;
export const STATUS = { open: 'Open', completed: 'Completed', rejected: 'Rejected' } as const;
