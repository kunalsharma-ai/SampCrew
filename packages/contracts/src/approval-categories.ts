import { z } from 'zod';

/**
 * How the Approvals page groups requests into category cards. Each request is put in one category when it starts,
 * from its resource type and the facts its module passes (`meta`): the leave type code and whether it is paid, the
 * expense category. Built-in categories cover the usual HR requests; HR can add their own (Approval settings), which
 * are checked first, so a custom card can pick out, for example, one expense category as "Reimbursement".
 */

export interface ApprovalMeta {
  leaveTypeCode?: string;
  leaveTypeName?: string;
  paid?: boolean;
  halfDay?: boolean;
  expenseCategoryId?: string;
  expenseCategoryName?: string;
  /** Free-form tag a module can set for HR's own categories to match. */
  tag?: string;
}

export interface ApprovalCategoryRule {
  resourceTypes: string[];
  /** Leave type codes (upper case); empty matches any. */
  leaveTypeCodes?: string[];
  /** Only paid (true) or unpaid (false) leave. */
  paid?: boolean;
  halfDay?: boolean;
  expenseCategoryIds?: string[];
  tags?: string[];
}

export interface ApprovalCategoryDef {
  key: string;
  label: string;
  description: string;
  icon: string;
  /** A hex colour for the card. */
  color: string;
  rule: ApprovalCategoryRule;
  builtIn: boolean;
}

const LEAVE = ['leave_request'];

/** Built-in categories, most specific first. `leave` and `other` catch whatever the rest do not. */
export const BUILT_IN_APPROVAL_CATEGORIES: ApprovalCategoryDef[] = [
  { key: 'half_day_leave', label: 'Half-day leave', description: 'Half-day leave requests', icon: 'clock', color: '#0891b2', rule: { resourceTypes: LEAVE, halfDay: true }, builtIn: true },
  { key: 'wfh', label: 'Work from home', description: 'Work-from-home requests', icon: 'home', color: '#7c3aed', rule: { resourceTypes: LEAVE, leaveTypeCodes: ['WFH'] }, builtIn: true },
  { key: 'privilege_leave', label: 'Permanent & earned leave', description: 'Permanent (PL), privilege and earned leave', icon: 'calendar', color: '#059669', rule: { resourceTypes: LEAVE, leaveTypeCodes: ['PL', 'EL'] }, builtIn: true },
  { key: 'sick_leave', label: 'Sick leave', description: 'Sick leave requests', icon: 'heart', color: '#dc2626', rule: { resourceTypes: LEAVE, leaveTypeCodes: ['SL'] }, builtIn: true },
  { key: 'casual_leave', label: 'Casual leave', description: 'Casual leave requests', icon: 'calendar', color: '#2563eb', rule: { resourceTypes: LEAVE, leaveTypeCodes: ['CL'] }, builtIn: true },
  { key: 'unpaid_leave', label: 'Unpaid leave', description: 'Leave without pay (LOP)', icon: 'wallet', color: '#6b7280', rule: { resourceTypes: LEAVE, paid: false }, builtIn: true },
  { key: 'paid_leave', label: 'Paid leave', description: 'Other paid leave, such as maternity, paternity or bereavement leave', icon: 'calendar', color: '#0d9488', rule: { resourceTypes: LEAVE, paid: true }, builtIn: true },
  { key: 'leave', label: 'Leave', description: 'Every other leave request', icon: 'calendar', color: '#4f46e5', rule: { resourceTypes: LEAVE }, builtIn: true },
  { key: 'reimbursement', label: 'Reimbursement', description: 'Reimbursement claims (choose which expense categories count in Approval settings)', icon: 'receipt', color: '#ca8a04', rule: { resourceTypes: ['reimbursement'] }, builtIn: true },
  { key: 'expense', label: 'Expense', description: 'Expense claims', icon: 'receipt', color: '#ea580c', rule: { resourceTypes: ['expense_claim'] }, builtIn: true },
  { key: 'attendance_correction', label: 'Attendance correction', description: 'Missed punch and attendance corrections, overtime and shift swaps', icon: 'clock', color: '#0284c7', rule: { resourceTypes: ['attendance_correction', 'overtime_claim', 'shift_swap'] }, builtIn: true },
  { key: 'profile_update', label: 'Profile update', description: 'Changes employees asked for on their own profile', icon: 'contact', color: '#9333ea', rule: { resourceTypes: ['profile_update'] }, builtIn: true },
  { key: 'document_verification', label: 'Document verification', description: 'Documents waiting to be verified', icon: 'file-text', color: '#be123c', rule: { resourceTypes: ['document_verification'] }, builtIn: true },
  { key: 'recruitment', label: 'Recruitment', description: 'Job requisitions and offers', icon: 'briefcase', color: '#0f766e', rule: { resourceTypes: ['job_requisition', 'offer', 'staffing_bid'] }, builtIn: true },
  { key: 'payroll', label: 'Payroll', description: 'Payroll runs', icon: 'wallet', color: '#15803d', rule: { resourceTypes: ['payroll_run'] }, builtIn: true },
  { key: 'other', label: 'Other HR requests', description: 'Workflow approvals and anything else', icon: 'inbox', color: '#475569', rule: { resourceTypes: [] }, builtIn: true },
];

function matches(rule: ApprovalCategoryRule, resourceType: string, meta: ApprovalMeta): boolean {
  if (rule.resourceTypes.length && !rule.resourceTypes.includes(resourceType)) return false;
  if (rule.leaveTypeCodes?.length && !rule.leaveTypeCodes.includes((meta.leaveTypeCode ?? '').toUpperCase())) return false;
  if (rule.paid !== undefined && meta.paid !== rule.paid) return false;
  if (rule.halfDay !== undefined && Boolean(meta.halfDay) !== rule.halfDay) return false;
  if (rule.expenseCategoryIds?.length && !rule.expenseCategoryIds.includes(meta.expenseCategoryId ?? '')) return false;
  if (rule.tags?.length && !rule.tags.includes(meta.tag ?? '')) return false;
  return true;
}

/** The category a request belongs to: HR's own categories first, then the built-in ones; `other` when nothing fits. */
export function categorizeApproval(resourceType: string, meta: ApprovalMeta | null | undefined, custom: ApprovalCategoryDef[] = []): string {
  const m = meta ?? {};
  for (const c of custom) if (c.rule.resourceTypes.length && matches(c.rule, resourceType, m)) return c.key;
  for (const c of BUILT_IN_APPROVAL_CATEGORIES) if (c.key !== 'other' && matches(c.rule, resourceType, m)) return c.key;
  return 'other';
}

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,12}$/);

export const approvalCategoryInput = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use 2 to 40 lower-case letters, digits or _ (starting with a letter)'),
  label: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).default(''),
  icon: z.string().trim().regex(/^[a-z-]{2,30}$/).default('inbox'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f46e5'),
  resourceTypes: z.array(z.string().regex(/^[a-z_]{1,40}$/)).min(1).max(10),
  leaveTypeCodes: z.array(code).max(20).default([]),
  paid: z.boolean().nullable().default(null),
  halfDay: z.boolean().nullable().default(null),
  expenseCategoryIds: z.array(z.uuid()).max(20).default([]),
  active: z.boolean().default(true),
});
export type ApprovalCategoryInput = z.infer<typeof approvalCategoryInput>;

export const APPROVAL_VIEWS = ['waiting', 'decided', 'mine'] as const;
export type ApprovalView = (typeof APPROVAL_VIEWS)[number];

export const approvalListQuery = z.object({
  view: z.enum(APPROVAL_VIEWS).default('waiting'),
  category: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Status messages shown to the person who asked, worded once here so every screen says the same thing. */
export function approvalStatusMessage(status: string, waitingOn: { stage: 'manager' | 'hr' | 'super' | 'both' | 'other'; who?: string | null } | null): string {
  if (status === 'approved') return 'Your request has been approved.';
  if (status === 'rejected') return 'Your request has been rejected. Please check the remarks.';
  if (status === 'cancelled') return 'Your request was cancelled.';
  if (!waitingOn) return 'Your request has been submitted successfully.';
  if (waitingOn.stage === 'manager') return `Your request is awaiting manager approval${waitingOn.who ? ` (${waitingOn.who})` : ''}.`;
  if (waitingOn.stage === 'hr') return `Your request is pending HR approval${waitingOn.who ? ` (${waitingOn.who})` : ''}.`;
  if (waitingOn.stage === 'super') return `Your request is pending Super Workspace approval${waitingOn.who ? ` (${waitingOn.who})` : ''}.`;
  if (waitingOn.stage === 'both') return `Your request is pending HR Workspace and Super Workspace approval${waitingOn.who ? ` (${waitingOn.who})` : ''}.`;
  return `Your request is awaiting approval${waitingOn.who ? ` from ${waitingOn.who}` : ''}.`;
}
