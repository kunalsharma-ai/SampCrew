import { z } from 'zod';
import { DOCUMENT_CATEGORIES, DOCUMENT_MAX_BYTES } from './schemas/people';

/**
 * Employee tasks: HR Tasks (assigned by HR, often a document to upload that HR then verifies) and Manager Tasks
 * (assigned by the reporting manager). Separate from onboarding checklists, which stay as they are.
 */
export const TASK_CATEGORIES = ['hr', 'manager'] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** general: done when the employee completes it; document: an upload HR verifies; acknowledgement: the employee confirms they read something. */
export const TASK_KINDS = ['general', 'document', 'acknowledgement'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** Stored statuses. "Overdue" is not stored: it is shown when an open task is past its due date. */
export const TASK_STATUSES = ['new', 'not_started', 'in_progress', 'pending_review', 'completed', 'reopened', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['new', 'not_started', 'in_progress', 'reopened'];
export const TASK_STATUS_LABELS: Record<TaskStatus | 'overdue', string> = {
  new: 'New', not_started: 'Not started', in_progress: 'In progress', pending_review: 'Pending review', completed: 'Completed', reopened: 'Reopened', cancelled: 'Cancelled', overdue: 'Overdue',
};

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** File types an HR document task can ask for, as shown to people, and the MIME types each allows. */
export const TASK_FILE_FORMATS = {
  pdf: ['application/pdf'],
  image: ['image/png', 'image/jpeg', 'image/webp'],
  word: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  text: ['text/plain'],
} as const;
export type TaskFileFormat = keyof typeof TASK_FILE_FORMATS;
export const TASK_FILE_FORMAT_KEYS = Object.keys(TASK_FILE_FORMATS) as TaskFileFormat[];

export const DOCUMENT_VERIFICATION_STATUSES = ['pending', 'verified', 'rejected'] as const;
export type DocumentVerificationStatus = (typeof DOCUMENT_VERIFICATION_STATUSES)[number];

const text = (max: number) => z.string().trim().max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31');

export const taskDocumentSpec = z.object({
  category: z.enum(DOCUMENT_CATEGORIES).default('other'),
  formats: z.array(z.enum(TASK_FILE_FORMAT_KEYS as [TaskFileFormat, ...TaskFileFormat[]])).min(1).max(4).default(['pdf', 'image']),
  maxMb: z.number().int().min(1).max(DOCUMENT_MAX_BYTES / (1024 * 1024)).default(5),
});
export type TaskDocumentSpec = z.infer<typeof taskDocumentSpec>;

export const taskInput = z
  .object({
    category: z.enum(TASK_CATEGORIES),
    kind: z.enum(TASK_KINDS).default('general'),
    title: text(200).min(1),
    description: text(4000).optional().nullable(),
    priority: z.enum(TASK_PRIORITIES).default('normal'),
    dueOn: date.optional().nullable(),
    /** Assign the same task to several people at once (each gets their own copy). */
    employeeIds: z.array(z.uuid()).min(1).max(500),
    document: taskDocumentSpec.optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'document' && !v.document) ctx.addIssue({ code: 'custom', path: ['document'], message: 'Say which document to upload' });
    if (v.kind === 'document' && v.category !== 'hr') ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Document uploads are HR tasks' });
  });
export type TaskInput = z.infer<typeof taskInput>;

export const taskUpdateInput = z.object({
  title: text(200).min(1).optional(),
  description: text(4000).optional().nullable(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueOn: date.optional().nullable(),
});

/** What the employee can do: move it along, add remarks, or mark it done (general and acknowledgement tasks). */
export const taskProgressInput = z.object({
  status: z.enum(['not_started', 'in_progress', 'pending_review', 'completed']),
  remarks: text(2000).optional().nullable(),
});

/** What the assigner (or HR) can do: accept, reopen with a reason, or cancel. */
export const taskReviewInput = z
  .object({
    action: z.enum(['complete', 'reopen', 'cancel']),
    remarks: text(2000).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.action !== 'complete' && !v.remarks?.trim()) ctx.addIssue({ code: 'custom', path: ['remarks'], message: 'Say why' });
  });

export const documentVerifyInput = z
  .object({ decision: z.enum(['verify', 'reject']), remarks: text(1000).optional().nullable() })
  .superRefine((v, ctx) => {
    if (v.decision === 'reject' && !v.remarks?.trim()) ctx.addIssue({ code: 'custom', path: ['remarks'], message: 'Tell the employee what to fix' });
  });

export const taskListQuery = z.object({
  category: z.enum(TASK_CATEGORIES).optional(),
  scope: z.enum(['mine', 'assigned']).default('mine'),
  status: z.enum(['open', 'review', 'done', 'all']).default('all'),
});

/** "Overdue" is shown for any open or in-review task past its due date. */
export function displayStatus(status: TaskStatus, dueOn: string | null, today: string): TaskStatus | 'overdue' {
  if (dueOn && dueOn < today && (OPEN_TASK_STATUSES as readonly string[]).includes(status)) return 'overdue';
  return status;
}

/** Whether an uploaded file fits the task's format and size rules. */
export function fileAllowed(spec: TaskDocumentSpec, mime: string, bytes: number): string | null {
  const allowed = spec.formats.flatMap((f) => TASK_FILE_FORMATS[f] as readonly string[]);
  if (!allowed.includes(mime)) return `Upload ${spec.formats.map((f) => f.toUpperCase()).join(', ')}`;
  if (bytes > spec.maxMb * 1024 * 1024) return `Files for this task can be up to ${spec.maxMb} MB`;
  return null;
}

/** Ready-made HR task suggestions shown in the assign form (HR can type anything else). */
export const HR_TASK_SUGGESTIONS: { title: string; kind: TaskKind; category?: (typeof DOCUMENT_CATEGORIES)[number] }[] = [
  { title: 'Upload joining documents', kind: 'document', category: 'other' },
  { title: 'Submit identity proof', kind: 'document', category: 'id_proof' },
  { title: 'Submit address proof', kind: 'document', category: 'address_proof' },
  { title: 'Upload educational certificates', kind: 'document', category: 'certificate' },
  { title: 'Upload previous employment documents', kind: 'document', category: 'other' },
  { title: 'Submit bank details', kind: 'general' },
  { title: 'Complete your employee profile', kind: 'general' },
  { title: 'Sign employment documents', kind: 'document', category: 'contract' },
  { title: 'Submit emergency contact information', kind: 'general' },
  { title: 'Complete onboarding forms', kind: 'general' },
  { title: 'Acknowledge company policies', kind: 'acknowledgement' },
  { title: 'Complete HR compliance requirements', kind: 'general' },
];
