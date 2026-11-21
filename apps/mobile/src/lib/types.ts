/** Response shapes of the API endpoints the app uses. */
export interface Punch {
  id: string;
  at: string;
  direction: 'in' | 'out';
  source: string;
  geofence: string | null;
  flags?: string[];
  purpose?: 'work' | 'break' | null;
}
export interface Today {
  employeeId: string;
  date: string;
  timeZone: string;
  shift: { code: string; name: string; start: string; end: string } | null;
  dayType: string;
  holidayName: string | null;
  nextDirection: 'in' | 'out';
  /** Working, on a break, checked out, or not started today. */
  state?: 'working' | 'on_break' | 'checked_out' | 'not_started';
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

export interface AttendanceDay {
  workDate: string;
  status: string;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  shiftName: string | null;
}
export interface AttendanceRange {
  from: string;
  to: string;
  summary: { present: number; halfDay: number; absent: number; missingPunch: number; onLeave: number; late: number; workedMinutes: number; overtimeMinutes: number };
  days: AttendanceDay[];
}
export interface TeamAttendance {
  date: string;
  summary: Record<string, number>;
  rows: (AttendanceDay & { employeeId: string; employeeName: string; employeeCode: string; department: string | null; location: string | null })[];
}

export interface CommFile { id: string; name: string; type: string; size: number; href: string }
export interface Conversation {
  id: string;
  kind: 'direct' | 'group' | 'department' | 'hr';
  title: string;
  subtitle: string | null;
  memberCount: number;
  lastMessage: { body: string; senderName: string | null; at: string } | null;
  unread: number;
  muted: boolean;
  updatedAt: string;
}
export interface ChatMessage {
  id: string;
  senderMembershipId: string | null;
  senderName: string | null;
  body: string;
  files: CommFile[];
  createdAt: string;
  deleted: boolean;
  delivery: 'sent' | 'delivered' | 'read' | null;
  system: boolean;
}
export interface ConversationDetail { conversation: Conversation & { asHr: boolean }; messages: ChatMessage[]; hasOlder: boolean }
export interface Person { membershipId: string; name: string; department: string | null; designation: string | null }

export interface InboxEmail { id: string; subject: string; html: string; sentAt: string | null; sentByName: string | null; files: CommFile[] }
export interface SentEmail {
  id: string;
  subject: string;
  status: 'draft' | 'sending' | 'sent' | 'partly_failed' | 'failed';
  preview: string;
  audienceLabel: string;
  recipientCount: number | null;
  sentCount: number | null;
  failedCount: number | null;
  updatedAt: string | null;
  sentAt: string | null;
}

export interface EmployeeDocument {
  id: string;
  category: string;
  title: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: string | null;
  verificationStatus: string | null;
}

export interface LearningAssignment {
  id: string;
  courseId: string;
  courseTitle: string;
  format: string | null;
  contentUrl: string | null;
  durationMinutes: number | null;
  pathTitle: string | null;
  dueOn: string | null;
  status: string;
  startedAt: string | null;
  completedOn: string | null;
  overdue: boolean;
  expired: boolean;
}
export interface Course {
  id: string;
  title: string;
  description?: string | null;
  format?: string | null;
  durationMinutes?: number | null;
  selfEnrol?: boolean;
  myStatus: string | null;
}

export interface SignIn { id: string; client: string; ip: string | null; userAgent: string | null; at: string; current: boolean; status: 'active' | 'signed_out' | 'expired'; endedAt: string | null }
export interface SignIns { current: SignIn | null; previous: SignIn | null; signIns: SignIn[] }
