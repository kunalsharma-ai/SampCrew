/** Response shapes of the API endpoints the app uses. */
export interface Punch {
  id: string;
  at: string;
  direction: 'in' | 'out';
  source: string;
  geofence: string | null;
  flags?: string[];
}
export interface Today {
  employeeId: string;
  date: string;
  timeZone: string;
  shift: { code: string; name: string; start: string; end: string } | null;
  dayType: string;
  holidayName: string | null;
  nextDirection: 'in' | 'out';
  punches: Punch[];
  day: { status: string; workedMinutes: number; explanation: string[]; flags: string[] } | null;
  policy?: { requireLocation?: boolean; geofence?: string };
}
export interface Balance {
  leaveTypeId: string;
  code: string;
  name: string;
  color: string;
  allowHalfDay: boolean;
  tracked: boolean;
  balance: string;
  pending: string;
  available: string;
}
export interface LeaveRequest {
  id: string;
  leaveTypeName: string;
  color: string;
  startDate: string;
  endDate: string;
  days: string;
  reason: string | null;
  status: string;
  leaveTypeCode?: string;
  /** Who a pending request is waiting for. */
  waitingOn?: string | null;
}
export interface LeaveCalendar { from: string; to: string; weeklyOffs: number[]; holidays: { date: string; name: string; optional: boolean }[]; requests: LeaveRequest[] }
export interface InboxItem {
  id: string;
  resourceType: string;
  summary: string;
  createdAt: string;
  stepSeq: number;
  stepCount: number;
  requestedBy: string;
  label: string;
}
export interface PayslipRow {
  id: string;
  month: string;
  payDate: string;
  currency: string;
  gross: string;
  deductions: string;
  net: string;
}
export interface Payslip extends PayslipRow {
  name: string;
  code: string;
  legalEntityName: string;
  isDemo: boolean;
  designation: string | null;
  department: string | null;
  paidDays: string;
  lopDays: string;
  daysInPeriod: number;
  reimbursements: string;
  lines: { code: string; name: string; kind: string; amount: string; explanation: string }[];
}
export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}
export interface Announcement {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  requiresAck: boolean;
  publishedAt: string;
  publishedByName: string | null;
  readAt: string | null;
  acknowledgedAt: string | null;
}
export interface Category {
  id: string;
  name: string;
  description: string;
  confidential: boolean;
  firstResponseHours: number | null;
  resolutionHours: number | null;
}
export interface CaseRow {
  id: string;
  ref: string;
  subject: string;
  status: string;
  priority: string;
  categoryName: string;
  confidential: boolean;
  employeeName: string;
  assigneeName: string | null;
  createdAt: string;
  updatedAt: string;
  firstResponse: string;
  resolution: string;
}
export interface CaseDetail extends CaseRow {
  description: string;
  role: 'handler' | 'requester';
  satisfaction: number | null;
  messages: { id: string; body: string; internal: boolean; createdAt: string; authorName: string; mine: boolean; fromHr: boolean }[];
  moves: string[];
  can: { reply: boolean; internalNote: boolean; assign: boolean; rate: boolean };
}
export interface Article {
  id: string;
  title: string;
  excerpt: string;
  categoryName: string;
}

// Employee workspace: tasks, appraisal, profile, rewards
export interface MyTask {
  id: string; category: 'hr' | 'manager'; kind: 'general' | 'document' | 'acknowledgement'; title: string; description: string | null;
  priority: string; status: string; displayStatus: string; overdue: boolean; isNew: boolean; dueOn: string | null; assignedAt: string; assignedBy: string | null;
  employeeRemarks: string | null; reviewerRemarks: string | null; submittedAt: string | null; completedAt: string | null; acknowledgedAt: string | null;
  document: { spec: { category: string; formats: string[]; maxMb: number }; id: string | null; fileName?: string | null; status?: string | null; remarks?: string | null } | null;
  isMine: boolean; history: { at: string; by: string | null; action: string; status: string; remarks: string | null }[];
}
export interface TaskCounts { hr: { open: number; new: number; overdue: number; review: number }; manager: { open: number; new: number; overdue: number; review: number }; toReview: number; documentsToVerify: number }

export interface AppraisalBrief {
  id: string; cycleName: string; periodStart: string; periodEnd: string; selfDue: string | null; stage: string; formTitle: string;
  selfCompletion: number; finalPercent: number | null; band: string | null; overdue: boolean; publishedAt: string | null;
}
/** An appraisal I review, as a manager or HR. */
export interface AppraisalReviewRow extends AppraisalBrief { employeeName: string | null; departmentName: string | null; managerName: string | null; managerDue: string | null; selfPercent: number | null; managerPercent: number | null }
export interface AppraisalQuestion { id: string; text: string; kind: string; weight: number; required: boolean; active: boolean }
export interface AppraisalSectionDef { id: string; title: string; description: string; kind: 'rated' | 'self' | 'manager' | 'hr'; audience: string; active: boolean; questions: AppraisalQuestion[] }
export type AppraisalAnswers = Record<string, { score?: number | null; comment?: string | null; text?: string | null }>;
export interface AppraisalDetail {
  id: string; stage: string; role: 'employee' | 'manager' | 'hr'; canEdit: boolean;
  cycle: { name: string; periodStart: string; periodEnd: string; selfDue: string | null };
  employee: { name: string; designation: string | null; department: string | null; managerName: string | null };
  definition: { title: string; intro: string; declaration?: string; scale: { min: number; max: number; levels: { from: number; to: number; label: string; description: string }[] }; sections: AppraisalSectionDef[]; scoring?: { hrScores: boolean }; bands?: { label: string; min: number }[] };
  answers: { employee?: AppraisalAnswers; manager?: AppraisalAnswers; hr?: AppraisalAnswers; finalScores?: Record<string, number | null> };
  result: { selfPercent: number | null; managerPercent: number | null; hrPercent?: number | null; calculatedPercent?: number | null; finalPercent: number | null; band: string | null; finals: Record<string, number | null> } | null;
  overrideReason?: string | null; finalPercentOverride?: number | null;
  completion: { employee: number; manager: number; hr: number }; publishedAt: string | null;
}

export interface ProfileUpdateBrief { id: string; status: string; createdAt: string; decidedAt: string | null; remarks: string | null; changes: { field: string; label: string }[] }
export interface MyProfile {
  employee: { id: string; name: string; code: string }; self: boolean; completeness: number;
  professional: { employeeCode: string; designation: string | null; department: string | null; manager: string | null; dateOfJoining: string; workEmail: string | null; location: { name: string } | null; shift: { name: string; start: string; end: string } | null; workingDays: string[] };
  sections: {
    personal: { firstName: string; lastName: string; preferredName: string | null; dateOfBirth: string | null; gender: string | null; personalEmail: string | null; phone: string | null; nationality: string | null; maritalStatus: string | null; bloodGroup: string | null };
    address: { current: Record<string, string> | null; permanentSameAsCurrent: boolean; permanent: Record<string, string> | null } | null;
    emergency: { contacts: { name: string; relationship: string; phone: string; email: string | null }[] } | null;
    education: { records: { level: string; degree: string | null; institution: string; yearCompleted: number | null }[] } | null;
    employment: { records: { company: string; designation: string | null; from: string; to: string | null }[] } | null;
    skills: { skills: string[]; languages: string[]; certifications: string[] } | null;
    bank: { hidden?: boolean; bankName?: string | null; accountNumber?: string | null; ifsc?: string | null; accountHolderName?: string | null; branchName?: string | null; accountType?: string | null } | null;
    identity: { hidden?: boolean; aadhaar?: string | null; pan?: string | null; otherIdType?: string | null; otherIdNumber?: string | null } | null;
  };
  updates: Partial<Record<string, ProfileUpdateBrief>>;
  can: { submit: boolean };
}
export interface RewardResult { id: string; name: string; kind: string; description: string | null; icon: string; status: 'earned' | 'on_track' | 'missed' | 'not_eligible'; done: number; total: number; reason: string | null }
export interface MyRewards { month: string; complete: boolean; rewards: RewardResult[] }
