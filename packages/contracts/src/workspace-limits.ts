/**
 * Plan-based workspace limits: how many HR Workspaces and Employee Workspaces a company (Super Workspace) may have.
 *
 * The numbers are plan limits (`max_hr_workspaces`, `max_employee_workspaces`) that SAMPLEDGE sets per plan in the
 * Console plan builder. A company never enters them: it inherits them from its subscription, plus any add-ons it
 * bought and any per-company figure SAMPLEDGE agreed. They are read on every request, so a plan edit or an upgrade
 * applies at once. The API refuses a creation at the limit, and a database guard refuses the write whatever code
 * makes it (packages/db/src/mongo/workspace-limits.ts).
 *
 * What counts:
 *  - HR Workspace: every HR Workspace that is not archived (suspended ones still count; archiving frees a place).
 *  - Employee Workspace: every SampCrew sign-in account in the company that is not suspended (invited ones count,
 *    as their place is held for them). Each person who signs in has their own Employee Workspace, whatever their level.
 *    Employee records without a login do not count here; they count against "Employees included" (max_employees).
 */

import { UNLIMITED } from './features';

export const WORKSPACE_LIMIT_KINDS = ['hr', 'employee'] as const;
export type WorkspaceLimitKind = (typeof WORKSPACE_LIMIT_KINDS)[number];

export const WORKSPACE_LIMIT_KEY = { hr: 'max_hr_workspaces', employee: 'max_employee_workspaces' } as const satisfies Record<WorkspaceLimitKind, string>;
export type WorkspaceLimitKey = (typeof WORKSPACE_LIMIT_KEY)[WorkspaceLimitKind];

export const WORKSPACE_LIMIT_LABEL: Record<WorkspaceLimitKind, string> = { hr: 'HR Workspaces', employee: 'Employee Workspaces' };
const ONE: Record<WorkspaceLimitKind, string> = { hr: 'HR Workspace', employee: 'Employee Workspace' };

/** What each count means, in the words the screens use. */
export const WORKSPACE_LIMIT_HINT: Record<WorkspaceLimitKind, string> = {
  hr: 'HR Workspaces that are not archived. Archiving one frees its place.',
  employee: 'People who can sign in (invited or active). Locking or suspending a login frees its place.',
};

export function workspaceLimitKindOf(key: string): WorkspaceLimitKind | null {
  return key === WORKSPACE_LIMIT_KEY.hr ? 'hr' : key === WORKSPACE_LIMIT_KEY.employee ? 'employee' : null;
}

export interface WorkspaceLimitUsage {
  kind: WorkspaceLimitKind;
  key: WorkspaceLimitKey;
  label: string;
  used: number;
  /** null: no limit (the plan says unlimited, or has no such limit). */
  limit: number | null;
  /** Places left; null when there is no limit. Never below 0. */
  remaining: number | null;
  /** No place left: creating another is refused. */
  reached: boolean;
  /** More in use than the limit allows (the limit was lowered). Nothing is removed; nothing new can be added. */
  over: boolean;
  /** Used / Maximum, for example "5 / 6", or "5 / Unlimited". */
  text: string;
}

export function workspaceLimitUsage(kind: WorkspaceLimitKind, used: number, limit: number | null | undefined): WorkspaceLimitUsage {
  const max = limit === undefined || limit === null || limit === UNLIMITED ? null : limit;
  return {
    kind, key: WORKSPACE_LIMIT_KEY[kind], label: WORKSPACE_LIMIT_LABEL[kind], used, limit: max,
    remaining: max === null ? null : Math.max(0, max - used),
    reached: max !== null && used >= max,
    over: max !== null && used > max,
    text: `${used} / ${max === null ? 'Unlimited' : max}`,
  };
}

/** Whether `adding` more fit: Current + adding <= Allowed. */
export function workspaceLimitAllows(u: Pick<WorkspaceLimitUsage, 'used' | 'limit'>, adding = 1): boolean {
  return u.limit === null || u.used + adding <= u.limit;
}

/** Why the limit stops a creation and what frees a place (the message without its "limit reached" heading). */
export function workspaceLimitAdvice(kind: WorkspaceLimitKind, used: number, limit: number): string {
  const what = limit === 1 ? ONE[kind] : WORKSPACE_LIMIT_LABEL[kind];
  const inUse = used > limit ? `${used} are in use` : limit === 1 ? 'it is in use' : `all ${limit} are in use`;
  const free = kind === 'hr' ? 'archive one' : 'lock or suspend a login';
  return `Your plan allows ${limit} ${what} and ${inUse}. Upgrade the plan or add more ${WORKSPACE_LIMIT_LABEL[kind]}, or ${free} to free a place.`;
}

/** The message shown when the limit is reached, by the API and the screens alike. */
export function workspaceLimitMessage(kind: WorkspaceLimitKind, used: number, limit: number): string {
  const advice = workspaceLimitAdvice(kind, used, limit);
  return `${WORKSPACE_LIMIT_LABEL[kind]} limit reached: ${advice[0]!.toLowerCase()}${advice.slice(1)}`;
}

/** A plan the company could move to for more room (shown with the upgrade option). */
export interface WorkspaceLimitPlanOption {
  key: string;
  name: string;
  hr: number | null;
  employee: number | null;
  quoteOnly: boolean;
  /** Listed after the company's current plan (a step up), rather than before it. */
  higherTier: boolean;
}

/** An add-on that raises one of the limits (Console > Billing > Add-ons, kind "limit"). */
export interface WorkspaceLimitAddonOption {
  key: string;
  name: string;
  kind: WorkspaceLimitKind;
  /** How many places one unit adds. */
  unitQuantity: number;
}

export interface WorkspaceLimits {
  plan: { key: string; name: string } | null;
  /** The subscription is active, trialing or past due. When cancelled or suspended the company is read-only anyway. */
  active: boolean;
  hr: WorkspaceLimitUsage;
  employee: WorkspaceLimitUsage;
  /** Where the figures come from: the plan, plus add-ons, or a per-company figure SAMPLEDGE set. */
  sources: Record<WorkspaceLimitKind, { plan: number | null; addons: number; override: number | null }>;
  upgrade: {
    /** The viewer may change the plan and buy add-ons (billing:manage). Others are told who can. */
    canManageBilling: boolean;
    plans: WorkspaceLimitPlanOption[];
    addons: WorkspaceLimitAddonOption[];
  };
}
