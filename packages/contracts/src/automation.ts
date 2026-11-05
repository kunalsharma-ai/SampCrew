import { z } from 'zod';

/**
 * Automation Studio: workflow definitions and the pure parts of running them (validation, conditions,
 * templates). A workflow is a trigger and an ordered list of steps. A condition step stops the run when it is
 * not met; an approval step stops it when the approver rejects. The API runner adds durability, retries and
 * permission checks.
 */

export type FieldType = 'text' | 'number' | 'date' | 'boolean';
export interface TriggerField { key: string; label: string; type: FieldType }

const EMPLOYEE_FIELDS: TriggerField[] = [
  { key: 'employee.name', label: 'Employee name', type: 'text' },
  { key: 'employee.title', label: 'Job title', type: 'text' },
  { key: 'employee.department', label: 'Department', type: 'text' },
  { key: 'employee.location', label: 'Location', type: 'text' },
  { key: 'employee.legalEntity', label: 'Legal entity', type: 'text' },
  { key: 'employee.employmentType', label: 'Employment type', type: 'text' },
  { key: 'employee.dateOfJoining', label: 'Date of joining', type: 'date' },
  { key: 'employee.status', label: 'Employee status', type: 'text' },
];

export const TRIGGERS = {
  'employee.created': { label: 'An employee record is created', fields: EMPLOYEE_FIELDS },
  'employee.job_changed': {
    label: 'An employee changes job (transfer, promotion or new manager)',
    fields: [...EMPLOYEE_FIELDS, { key: 'change.kind', label: 'Kind of change', type: 'text' }, { key: 'change.effectiveDate', label: 'Effective date', type: 'date' }],
  },
  'leave.requested': {
    label: 'Someone applies for leave',
    fields: [...EMPLOYEE_FIELDS, { key: 'leave.type', label: 'Leave type', type: 'text' }, { key: 'leave.days', label: 'Days requested', type: 'number' }, { key: 'leave.from', label: 'First day', type: 'date' }, { key: 'leave.to', label: 'Last day', type: 'date' }],
  },
  'leave.approved': {
    label: 'A leave request is approved',
    fields: [...EMPLOYEE_FIELDS, { key: 'leave.type', label: 'Leave type', type: 'text' }, { key: 'leave.days', label: 'Days approved', type: 'number' }, { key: 'leave.from', label: 'First day', type: 'date' }, { key: 'leave.to', label: 'Last day', type: 'date' }],
  },
  // Confidential cases never start a workflow, and the case text is never available to one.
  'helpdesk.case_created': {
    label: 'A helpdesk case is raised (not confidential ones)',
    fields: [...EMPLOYEE_FIELDS, { key: 'case.ref', label: 'Case reference', type: 'text' }, { key: 'case.category', label: 'Case category', type: 'text' }, { key: 'case.priority', label: 'Case priority', type: 'text' }],
  },
} as const satisfies Record<string, { label: string; fields: TriggerField[] }>;

export type TriggerEvent = keyof typeof TRIGGERS;
export const TRIGGER_EVENTS = Object.keys(TRIGGERS) as TriggerEvent[];

export const fieldsFor = (event: TriggerEvent): TriggerField[] => TRIGGERS[event].fields as TriggerField[];

export const CONDITION_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const OP_LABEL: Record<ConditionOp, string> = {
  eq: 'is', neq: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', contains: 'contains', in: 'is one of',
};

const stepId = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, 'Step ids are lower case letters, digits and _');
const template = (max: number) => z.string().trim().min(1).max(max);

const conditionStep = z.object({
  id: stepId, type: z.literal('condition'),
  field: z.string().min(1).max(60),
  op: z.enum(CONDITION_OPS),
  value: z.union([z.string().max(200), z.number(), z.array(z.string().max(100)).min(1).max(30)]),
});
const notifyStep = z.object({
  id: stepId, type: z.literal('notify'),
  to: z.enum(['employee', 'manager', 'role', 'member']),
  role: z.string().max(60).optional(),
  membershipId: z.uuid().optional(),
  title: template(200),
  body: z.string().trim().max(2000).default(''),
  email: z.boolean().default(false),
});
const delayStep = z.object({
  id: stepId, type: z.literal('delay'),
  amount: z.number().int().min(1).max(365),
  unit: z.enum(['minutes', 'hours', 'days']),
});
const approvalStep = z.object({
  id: stepId, type: z.literal('approval'),
  approver: z.enum(['manager', 'role']),
  role: z.string().max(60).optional(),
  summary: template(300),
});
const assignCourseStep = z.object({
  id: stepId, type: z.literal('assign_course'),
  courseId: z.uuid(),
  dueInDays: z.number().int().min(1).max(365).nullable().default(30),
});

const slackStep = z.object({
  id: stepId, type: z.literal('slack'),
  connectionId: z.uuid(),
  text: template(2000),
});
const webhookStep = z.object({
  id: stepId, type: z.literal('webhook'),
  endpointId: z.uuid(),
  message: template(500),
});

export const workflowStep = z.discriminatedUnion('type', [conditionStep, notifyStep, delayStep, approvalStep, assignCourseStep, slackStep, webhookStep]);
export type WorkflowStep = z.infer<typeof workflowStep>;
export type StepType = WorkflowStep['type'];
export const STEP_TYPES: StepType[] = ['condition', 'notify', 'delay', 'approval', 'assign_course', 'slack', 'webhook'];
export const STEP_LABEL: Record<StepType, string> = {
  condition: 'Continue only if', notify: 'Send a notification', delay: 'Wait', approval: 'Ask for approval', assign_course: 'Assign a course',
  slack: 'Post to Slack', webhook: 'Send to a webhook',
};
/** Steps whose effects reach people, records or outside systems; a test run only describes them. */
export const SIDE_EFFECT_STEPS: StepType[] = ['notify', 'approval', 'assign_course', 'slack', 'webhook'];

export const workflowDefinition = z.object({
  trigger: z.object({ event: z.enum(TRIGGER_EVENTS as [TriggerEvent, ...TriggerEvent[]]) }),
  steps: z.array(workflowStep).min(1).max(20),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinition>;

export const workflowInput = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).default(''),
  definition: workflowDefinition,
  /** Set when the definition started from an AI draft. */
  aiInteractionId: z.uuid().optional(),
});
export type WorkflowInput = z.infer<typeof workflowInput>;

export const workflowTestInput = z.object({
  /** Sample values for the trigger's fields, e.g. { "employee.department": "Assembly Line" }. */
  sample: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).default({}),
  /** What a test run assumes approvers decide. */
  approvals: z.enum(['approve', 'reject']).default('approve'),
});
export type WorkflowTestInput = z.infer<typeof workflowTestInput>;

export const workflowDraftInput = z.object({ description: z.string().trim().min(10).max(1500) });

export interface DefinitionIssue { path: string; message: string }

const PLACEHOLDER = /\{\{\s*([a-zA-Z.]+)\s*\}\}/g;

export function placeholders(tpl: string): string[] {
  return [...tpl.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/**
 * Checks what the schema cannot: fields and placeholders exist for the trigger, operators suit the field type,
 * ids are unique and required options are present. `knownRoles` (role keys in the workspace) is checked when given.
 */
export function validateDefinition(input: unknown, knownRoles?: readonly string[]): { ok: true; definition: WorkflowDefinition } | { ok: false; issues: DefinitionIssue[] } {
  const parsed = workflowDefinition.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  const def = parsed.data;
  const fields = new Map(fieldsFor(def.trigger.event).map((f) => [f.key, f]));
  const issues: DefinitionIssue[] = [];
  const seen = new Set<string>();
  def.steps.forEach((s, i) => {
    const at = `steps.${i}`;
    if (seen.has(s.id)) issues.push({ path: `${at}.id`, message: `Step id "${s.id}" is used twice` });
    seen.add(s.id);
    const checkTemplate = (tpl: string, path: string) => {
      for (const p of placeholders(tpl)) if (!fields.has(p)) issues.push({ path: `${at}.${path}`, message: `{{${p}}} is not available for this trigger` });
    };
    switch (s.type) {
      case 'condition': {
        const f = fields.get(s.field);
        if (!f) { issues.push({ path: `${at}.field`, message: `"${s.field}" is not available for this trigger` }); break; }
        if (['gt', 'gte', 'lt', 'lte'].includes(s.op) && f.type !== 'number' && f.type !== 'date') issues.push({ path: `${at}.op`, message: `"${OP_LABEL[s.op]}" needs a number or date field` });
        if (s.op === 'in' && !Array.isArray(s.value)) issues.push({ path: `${at}.value`, message: 'List the values to match' });
        if (s.op !== 'in' && Array.isArray(s.value)) issues.push({ path: `${at}.value`, message: 'Give one value' });
        if (f.type === 'number' && !Array.isArray(s.value) && Number.isNaN(Number(s.value))) issues.push({ path: `${at}.value`, message: 'Give a number' });
        if (f.type === 'date' && ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(s.op) && !/^\d{4}-\d{2}-\d{2}$/.test(String(s.value))) issues.push({ path: `${at}.value`, message: 'Give a date as YYYY-MM-DD' });
        break;
      }
      case 'notify':
        if (s.to === 'role' && !s.role) issues.push({ path: `${at}.role`, message: 'Choose a role' });
        if (s.to === 'member' && !s.membershipId) issues.push({ path: `${at}.membershipId`, message: 'Choose a person' });
        if (s.to === 'role' && s.role && knownRoles && !knownRoles.includes(s.role)) issues.push({ path: `${at}.role`, message: `Role "${s.role}" does not exist` });
        checkTemplate(s.title, 'title');
        checkTemplate(s.body, 'body');
        break;
      case 'approval':
        if (s.approver === 'role' && !s.role) issues.push({ path: `${at}.role`, message: 'Choose a role' });
        if (s.approver === 'role' && s.role && knownRoles && !knownRoles.includes(s.role)) issues.push({ path: `${at}.role`, message: `Role "${s.role}" does not exist` });
        checkTemplate(s.summary, 'summary');
        break;
      case 'slack':
        checkTemplate(s.text, 'text');
        break;
      case 'webhook':
        checkTemplate(s.message, 'message');
        break;
      default:
        break;
    }
  });
  if (def.steps.every((s) => s.type === 'condition' || s.type === 'delay')) issues.push({ path: 'steps', message: 'Add at least one step that does something' });
  return issues.length ? { ok: false, issues } : { ok: true, definition: def };
}

export type Context = Record<string, string | number | boolean | null | undefined>;

/** Fills {{field}} placeholders. Missing values render as an empty string. */
export function render(tpl: string, ctx: Context): string {
  return tpl.replace(PLACEHOLDER, (_, key: string) => {
    const v = ctx[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** Evaluates a condition step against the run's context. Text comparisons ignore case. */
export function evaluateCondition(step: Extract<WorkflowStep, { type: 'condition' }>, ctx: Context): { met: boolean; actual: unknown } {
  const actual = ctx[step.field];
  const missing = actual === null || actual === undefined || actual === '';
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));
  const cmp = (a: unknown, b: unknown) => {
    // Dates as YYYY-MM-DD compare correctly as strings; numbers compare as numbers.
    if (typeof a === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a)) return a.slice(0, 10) < String(b) ? -1 : a.slice(0, 10) > String(b) ? 1 : 0;
    return num(a) - num(b);
  };
  let met: boolean;
  switch (step.op) {
    case 'eq': met = !missing && (typeof actual === 'number' ? actual === num(step.value) : norm(actual) === norm(step.value)); break;
    case 'neq': met = missing || (typeof actual === 'number' ? actual !== num(step.value) : norm(actual) !== norm(step.value)); break;
    case 'gt': met = !missing && cmp(actual, step.value) > 0; break;
    case 'gte': met = !missing && cmp(actual, step.value) >= 0; break;
    case 'lt': met = !missing && cmp(actual, step.value) < 0; break;
    case 'lte': met = !missing && cmp(actual, step.value) <= 0; break;
    case 'contains': met = !missing && norm(actual).includes(norm(step.value)); break;
    case 'in': met = !missing && (step.value as string[]).map(norm).includes(norm(actual)); break;
  }
  return { met, actual: actual ?? null };
}

/** Milliseconds a delay step waits. */
export function delayMs(step: Extract<WorkflowStep, { type: 'delay' }>): number {
  return step.amount * { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[step.unit];
}

/** Retry back-off for a failed step: 30 s, 2 min, 8 min. After the last attempt the run fails. */
export const MAX_STEP_ATTEMPTS = 3;
export const retryDelayMs = (attempt: number) => 30_000 * 4 ** Math.max(0, attempt - 1);

/** A short, readable description of a step for lists and traces. */
export function describeStep(s: WorkflowStep): string {
  switch (s.type) {
    case 'condition': return `Continue only if ${s.field} ${OP_LABEL[s.op]} ${Array.isArray(s.value) ? s.value.join(', ') : s.value}`;
    case 'notify': return `Notify ${s.to === 'role' ? `everyone with the ${s.role} role` : s.to === 'member' ? 'a chosen person' : `the ${s.to}`}: "${s.title}"${s.email ? ' (and email)' : ''}`;
    case 'delay': return `Wait ${s.amount} ${s.amount === 1 ? s.unit.replace(/s$/, '') : s.unit}`;
    case 'approval': return `Ask ${s.approver === 'manager' ? "the employee's manager" : `the ${s.role} role`} to approve: "${s.summary}"`;
    case 'assign_course': return `Assign a course${s.dueInDays ? `, due in ${s.dueInDays} days` : ''}`;
    case 'slack': return `Post to Slack: "${s.text.length > 80 ? `${s.text.slice(0, 77)}...` : s.text}"`;
    case 'webhook': return `Send to a webhook endpoint: "${s.message}"`;
  }
}
