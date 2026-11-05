import type { MeResponse } from '@crew/contracts';

export type Me = MeResponse;

export interface Member {
  id: string;
  status: string;
  title: string | null;
  userId: string;
  fullName: string;
  email: string;
  mfaEnabled: boolean;
  legalEntityId: string | null;
  legalEntityName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  managerMembershipId: string | null;
  managerName: string | null;
  joinedAt: string | null;
  lastLoginAt: string | null;
  roles: { key: string; name: string; constraints: Record<string, string[]> }[];
}

export interface LegalEntity { id: string; name: string; legalName: string | null; countryCode: string; currency: string; timezone: string; registrationNumber: string | null; taxId: string | null; fiscalYearStartMonth: number; address: string | null }
export interface BusinessUnit { id: string; name: string; code: string | null; description: string | null }
export interface Location { id: string; name: string; code: string | null; kind: string; legalEntityId: string; timezone: string; city: string | null; region: string | null; countryCode: string; latitude: number | null; longitude: number | null; geofenceRadiusM: number | null; addressLine: string | null; postalCode: string | null }
export interface Department { id: string; name: string; code: string | null; parentId: string | null; legalEntityId: string | null; businessUnitId: string | null; headMembershipId: string | null; memberCount: number; children?: Department[] }
export interface Role { id: string; key: string; name: string; description: string | null; isSystem: boolean; memberCount: number; grants: Record<string, string> }
export interface Page<T> { items: T[]; nextCursor: string | null }

export interface Employee {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  displayName: string;
  workEmail: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  dateOfJoining: string;
  probationEndDate: string | null;
  confirmationDate: string | null;
  employmentType: string;
  status: 'pre_boarding' | 'probation' | 'active' | 'notice' | 'exited';
  resignationDate: string | null;
  lastWorkingDay: string | null;
  exitType: string | null;
  legalEntityId: string | null;
  legalEntityName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  designationId: string | null;
  designationName: string | null;
  managerEmployeeId: string | null;
  managerName: string | null;
  grade: string | null;
  membershipId: string | null;
  loginStatus: string | null;
}
export interface EmployeeProfile extends Employee {
  isSelf: boolean;
  can: { update: boolean; updateOwn: boolean; viewSensitive: boolean; lifecycle: boolean; readDocuments: boolean; manageDocuments: boolean; readLeave: boolean };
}
export interface Designation { id: string; name: string; code: string | null; level: number | null; employeeCount: number }
export interface JobRecord { id: string; effectiveFrom: string; effectiveTo: string | null; reason: string; note: string | null; legalEntityName: string | null; departmentName: string | null; locationName: string | null; designationName: string | null; managerName: string | null; grade: string | null; employmentType: string; scheduled: boolean }
export interface LifecycleEvent { id: string; kind: string; effectiveOn: string; details: Record<string, unknown>; createdAt: string; by: string | null }
export interface LeaveType { id: string; code: string; name: string; description: string | null; paid: boolean; allowHalfDay: boolean; color: string }
export interface LeavePolicy { id: string; leaveTypeId: string; leaveTypeName: string; leaveTypeCode: string; legalEntityId: string | null; legalEntityName: string | null; accrualMethod: string; annualEntitlement: string; carryForwardMax: string; allowNegativeBalance: boolean; minNoticeDays: number; maxConsecutiveDays: string | null; availableDuringProbation: boolean; rounding: string }
export interface LeaveBalance { leaveTypeId: string; code: string; name: string; color: string; paid: boolean; allowHalfDay: boolean; tracked: boolean; annualEntitlement: string; accrualMethod: string; accrued: string; carriedForward: string; adjusted: string; taken: string; lapsed: string; balance: string; pending: string; available: string | null }
export interface LeaveRequest { id: string; employeeId: string; employeeName: string; employeeCode: string; leaveTypeId: string; leaveTypeName: string; leaveTypeCode: string; color: string; startDate: string; endDate: string; startHalf: string; endHalf: string; days: string; reason: string | null; status: string; approvalId: string | null; createdAt: string; decidedAt: string | null; cancelReason: string | null; requestedBy: string | null; approvalTrail?: ApprovalStep[] }
export interface ApprovalStep { seq: number; kind: string; status: string; role: string | null; approver: string | null; decidedBy: string | null; decidedAt: string | null; comment: string | null }
export interface HolidayCalendar { id: string; name: string; legalEntityId: string | null; legalEntityName: string | null; locationId: string | null; locationName: string | null; isDefault: boolean; weeklyOffs: number[]; holidays: { id: string; date: string; name: string; isOptional: boolean }[] }
export interface InboxItem { id: string; resourceType: string; resourceId: string; summary: string; createdAt: string; stepSeq: number; stepCount: number; requestedBy: string | null; subjectName: string | null; viaRole: string | null; link: string; label: string }
export interface OnboardingTask { id: string; employeeId: string; title: string; description: string | null; owner: string; assigneeMembershipId: string | null; assigneeName: string | null; dueOn: string | null; status: string; completedAt: string | null; completedBy: string | null; employeeName: string; employeeCode: string; overdue: boolean }
export interface OnboardingTemplate { id: string; name: string; description: string | null; isDefault: boolean; tasks: { title: string; description?: string; owner: string; dueOffsetDays: number }[] }
export interface EmployeeDocument { id: string; employeeId: string; category: string; title: string; fileName: string; contentType: string; sizeBytes: number; sha256: string; visibility: string; uploadedBy: string | null; createdAt: string }
export interface Notification { id: string; kind: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }
