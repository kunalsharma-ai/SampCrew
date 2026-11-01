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
}
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
