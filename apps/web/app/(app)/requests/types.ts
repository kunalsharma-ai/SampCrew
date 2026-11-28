import type { RequestKindDef, RequestPerson, RequestView } from '@crew/contracts';

export interface RequestOptions {
  kinds: RequestKindDef[];
  me: RequestPerson;
  hasEmployeeRecord: boolean;
  suggested: RequestPerson[];
  leaveTypes: { id: string; name: string; code: string; color: string; available: string | null; notAssigned: boolean; allowHalfDay: boolean; kind: string }[];
}
export interface RequestList { counts: { all: number; pending: number; approved: number; rejected: number; cancelled: number }; items: RequestView[] }
export interface LeaveForm {
  request: RequestView;
  company: string;
  applicant: { name: string; employeeCode: string | null; designation: string | null; department: string | null; levelLabel: string; workspace: string | null; dateOfJoining: string | null; email: string | null };
  reportingManager: { name: string; designation: string | null; levelLabel: string } | null;
  hrManager: { name: string; designation: string | null; levelLabel: string } | null;
  sendTo: { membershipId: string; name: string; levelLabel: string; designation: string | null }[];
  leaveTypes: { id: string; name: string; code: string; color: string; available: string | null; notAssigned: boolean; allowHalfDay: boolean }[];
  prefill: { leaveTypeId: string | null; startDate: string; endDate: string; startHalf: 'full' | 'second_half'; endHalf: 'full' | 'first_half'; reason: string };
  hasEmployeeRecord: boolean;
}
