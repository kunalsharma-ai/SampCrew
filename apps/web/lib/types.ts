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
  /** Set when the employee has a photo; also used to refresh cached copies. */
  photoUpdatedAt?: string | null;
  defaultShiftId?: string | null;
}
export interface EmployeeProfile extends Employee {
  isSelf: boolean;
  can: { update: boolean; updateOwn: boolean; viewSensitive: boolean; lifecycle: boolean; readDocuments: boolean; manageDocuments: boolean; readLeave: boolean; onboarding?: boolean };
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

// Phase 3: attendance and workforce
export interface AttendanceDay {
  employeeId: string;
  workDate: string;
  status: string;
  dayType: string;
  leavePart: string | null;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  approvedOvertimeMinutes: number;
  flags: string[];
  explanation: string[];
  punchCount: number;
  shiftCode: string | null;
  shiftName: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  employeeName?: string;
  employeeCode?: string;
  department?: string | null;
  location?: string | null;
}
export interface Punch { id: string; at: string; direction: 'in' | 'out' | 'unknown'; source: string; geofence: string | null; device: string | null; viaCorrection: boolean; verifyMethod?: string | null; note?: string | null; flags?: string[] }
export interface AttendanceToday {
  employeeId: string;
  date: string;
  timeZone: string;
  shift: { code: string; name: string; start: string; end: string } | null;
  dayType: string;
  holidayName: string | null;
  nextDirection: 'in' | 'out';
  punches: Punch[];
  day: AttendanceDay | null;
  allowed: { web: boolean; mobile: boolean; qr: boolean };
  geofence: { mode: 'off' | 'warn' | 'enforce'; configured: boolean; radiusM: number | null };
  locked: boolean;
}
export interface AttendanceCorrection { id: string; employeeId: string; workDate: string; punches: { time: string; direction: string; nextDay?: boolean }[]; reason: string; status: string; createdAt: string; employeeName?: string }
export interface OvertimeClaim { id: string; workDate: string; status: string; minutes: number; reason: string | null }
export interface AttendanceMonth {
  employee: { id: string; name: string; code: string; timeZone: string };
  from: string;
  to: string;
  summary: { present: number; halfDay: number; absent: number; missingPunch: number; onLeave: number; late: number; workedMinutes: number; overtimeMinutes: number; approvedOvertimeMinutes: number };
  days: AttendanceDay[];
  corrections: AttendanceCorrection[];
  overtimeClaims: OvertimeClaim[];
}
export interface ShiftTemplate {
  id: string; code: string; name: string; startTime: string; endTime: string; breakMinutes: number; graceLateMinutes: number; graceEarlyMinutes: number;
  halfDayMinutes: number; fullDayMinutes: number; overtimeEnabled: boolean; overtimeMinMinutes: number; color: string; archivedAt: string | null;
}
export interface AttendancePolicy {
  id: string; locationId: string | null; locationName: string | null; webPunch: boolean; mobilePunch: boolean; qrPunch: boolean; geofenceMode: 'off' | 'warn' | 'enforce';
  defaultShiftId: string | null; defaultShiftName: string | null; overtimeRequiresApproval: boolean; earlyWindowMinutes: number; correctionWindowDays: number;
}
export interface PeriodLock { id: string; legalEntityId: string | null; legalEntityName: string | null; periodStart: string; periodEnd: string; note: string | null; lockedAt: string; lockedBy: string | null; unlockedAt: string | null; unlockedBy: string | null; unlockReason: string | null }
export interface Kiosk { id: string; name: string; locationId: string; locationName: string; lastSeenAt: string | null; revokedAt: string | null; createdAt: string }
export interface Roster { id: string; name: string; startDate: string; endDate: string; status: string; publishedAt: string | null; departmentId: string | null; departmentName: string | null; locationId: string | null; locationName: string | null; assignments: number }
export interface RosterGrid {
  id: string; name: string; startDate: string; endDate: string; status: string; publishedAt: string | null; canEdit: boolean;
  rows: { employeeId: string; name: string; code: string; cells: { date: string; shiftId: string | null; inRoster: boolean; dayType: string; holidayName: string | null }[] }[];
}
export interface ScheduleDay { date: string; dayType: string; holidayName: string | null; source: string; shift: { id: string; code: string; name: string; start: string; end: string; color: string } | null }
export interface SwapRequest { id: string; workDate: string; status: string; reason: string | null; createdAt: string; requesterId: string; requesterName: string; counterpartId: string; counterpartName: string; requesterShift: string | null; counterpartShift: string | null }
export interface Device {
  id: string; name: string; vendor: string; model: string | null; serialNumber: string; protocol: string; locationId: string; locationName: string; timeZone: string;
  directionFromDevice: boolean; allowedIps: string[]; simulated: boolean; expectedIntervalSeconds: number; firmware: string | null; reportedUserCount: number | null;
  reportedPunchCount: number | null; lastSeenAt: string | null; lastPunchAt: string | null; lastError: string | null; lastErrorAt: string | null;
  recordsAccepted: number; recordsDuplicate: number; recordsRejected: number; status: string; unmappedUsers?: number;
  /** Set when SAMPLEDGE paused this machine, or switched its integration off for the workspace. */
  pausedAt: string | null; pausedReason: string | null; integrationOff: boolean; tokenHint: string | null;
}
export interface DeviceIntegration { key: string; name: string; protocols: string[]; note: string; enabled: boolean }
export interface DeviceDetail extends Device {
  users: { deviceUserId: string; punches: number; lastPunchAt: string; employeeId: string | null; employeeName: string | null }[];
  coverage: { seen: number; mapped: number };
  log: { id: number; kind: string; records: number; accepted: number; duplicates: number; rejected: number; detail: string | null; remoteIp: string | null; createdAt: string }[];
  setup:
    | { protocol: 'push_http'; serverAddress: string; serverPort: number; https: boolean; path: string; serialNumber: string }
    | { protocol: 'device_api'; punchesUrl: string; heartbeatUrl: string; tokenHint: string | null; serialNumber: string };
}
export interface DeviceMapping { id: string; deviceId: string | null; deviceName: string | null; deviceUserId: string; employeeId: string; employeeName: string; employeeCode: string; createdAt: string }

// Recruitment (Phase 4) --------------------------------------------------------------------------------------

export interface Requisition {
  id: string; code: string; title: string; status: string; statusReason: string | null; legalEntityId: string; legalEntityName: string;
  departmentId: string; departmentName: string; locationId: string | null; locationName: string | null; designationId: string | null; designationName: string | null;
  hiringManagerMembershipId: string; hiringManagerName: string; employmentType: string; workMode: string; headcount: number; hiredCount: number;
  reason: string; replacingEmployeeId: string | null; salaryMin: string | null; salaryMax: string | null; currency: string; targetStartDate: string | null;
  justification: string; description: string; scorecard: string[]; approvalRequestId: string | null; createdByMembershipId: string | null; createdByName: string | null;
  approvedAt: string | null; openedAt: string | null; closedAt: string | null; createdAt: string; postingId: string | null; postingSlug: string | null; published: boolean;
  activeApplications: number; totalApplications: number;
}
export interface Posting { id: string; requisitionId: string; publicTitle: string; slug: string; summary: string; description: string; locationText: string; showSalary: boolean; publishedAt: string | null; unpublishedAt: string | null; published: boolean }
export interface RequisitionDetail extends Requisition {
  posting: Posting | null;
  careerSite: { slug: string; enabled: boolean } | null;
  can: { edit: boolean; manageCandidates: boolean; readCandidates: boolean; manageOffers: boolean };
}
export interface RecruitPerson { membershipId: string; name: string; title: string | null; departmentName: string | null }
export interface Stage { id: string; name: string; kind: string; position: number; activeApplications?: number }
export interface Application {
  id: string; candidateId: string; candidateName: string; candidateEmail: string | null; currentTitle: string | null; currentCompany: string | null;
  requisitionId: string; requisitionCode: string; requisitionTitle: string; stageId: string; stageName: string; stageKind: string; status: string; source: string;
  rejectionReason: string | null; rejectionNote: string | null; coverNote: string | null; employeeId: string | null; appliedAt: string; stageEnteredAt: string;
  decidedAt: string | null; hiredAt: string | null; interviews: number; averageScore: string | null; scorecards: number; offerStatus: string | null;
  can?: { manage: boolean; offers: boolean };
}
export interface Pipeline { stages: Stage[]; applications: Application[]; counts: { active: number; rejected: number; withdrawn: number; hired: number } }
export interface Candidate {
  id: string; firstName: string; lastName: string; email: string | null; phone: string | null; locationText: string | null; currentTitle: string | null; currentCompany: string | null;
  profileUrl: string | null; source: string; sourceDetail: string | null; referredByMembershipId: string | null; referredByName?: string | null; tags: string[]; consentBasis: string;
  consentAt: string | null; lastActivityAt: string; anonymizedAt: string | null; createdAt: string; activeApplications?: number;
  applications?: { requisitionCode: string; requisitionTitle: string; stage: string; status: string }[] | null;
}
export interface PanelMember { membershipId: string; name: string; submitted: boolean }
export interface InterviewSummary { id: string; applicationId: string; title: string; startsAt: string; durationMinutes: number; mode: string; meetingUrl: string | null; locationText: string | null; status: string; panel: PanelMember[] | null }
export interface Offer {
  id: string; applicationId: string; jobTitle: string; designationId: string | null; baseSalary: string; currency: string; payPeriod: string; variablePay: string | null;
  joiningDate: string; expiresOn: string; notes: string | null; status: string; aboveRange: boolean; approvalRequestId: string | null; sentAt: string | null;
  respondedAt: string | null; responseNote: string | null; createdAt: string;
}
export interface CandidateDetail {
  candidate: Candidate;
  applications: (Application & { can: { manage: boolean; offers: boolean } })[];
  files: { id: string; kind: string; fileName: string; contentType: string; sizeBytes: number; createdAt: string }[];
  notes: { id: string; body: string; applicationId: string | null; createdAt: string; authorName: string | null }[];
  timeline: { id: string; applicationId: string; kind: string; fromStage: string | null; toStage: string | null; detail: Record<string, unknown>; createdAt: string; actorName: string | null }[];
  interviews: InterviewSummary[];
  offers: Offer[];
  can: { edit: boolean; erase: boolean; hire: boolean };
}
export interface Feedback { id: string; membershipId: string; interviewerName: string; ratings: { criterion: string; score: number; note?: string }[]; recommendation: string; summary: string; submittedAt: string }
export interface InterviewDetail {
  interview: InterviewSummary & { cancelReason: string | null; candidateId: string; candidateName: string; currentTitle: string | null; currentCompany: string | null; profileUrl: string | null; requisitionId: string; requisitionCode: string; requisitionTitle: string; scorecard: string[]; jobDescription: string };
  panel: PanelMember[];
  myFeedback: Feedback | null;
  otherFeedback: Feedback[];
  othersHidden: boolean;
  files: { id: string; fileName: string }[];
  can: { feedback: boolean; manage: boolean };
}
export interface MyInterview { id: string; title: string; startsAt: string; durationMinutes: number; mode: string; meetingUrl: string | null; locationText: string | null; status: string; candidateName: string; requisitionTitle: string; submitted: boolean }
export interface CareerSiteSettings { configured?: boolean; enabled: boolean; slug: string; headline: string; intro: string; privacyNotice: string; privacyNoticeVersion: number; retentionDays: number }
export interface PublicJob { slug: string; title: string; summary: string; locationText: string; workMode: string; employmentType: string; department: string; postedAt: string; salaryMin: string | null; salaryMax: string | null; currency: string | null; description?: string }

export interface AttendanceRegistration {
  defaultShift: { id: string; name: string; code: string; startTime: string; endTime: string } | null;
  enrolments: { id: string; deviceUserId: string; deviceId: string | null; deviceName: string | null }[];
  registered: boolean;
}
export interface LoginDetails { membershipId: string; membershipStatus: string; loginId: string; accountStatus: string; mfaEnabled: boolean; lastLoginAt: string | null; mustChangePassword: boolean; hasPassword: boolean; lockedUntil: string | null; otherWorkspaces: number; openSessions: number; temporaryPassword?: string }
