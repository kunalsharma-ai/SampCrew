import {
  leaveAllocationMatches, leaveApprovalRules, leaveEligible, leaveEligibility, leaveTypePolicy, leaveMath,
  type LeaveAllocationCriteria, type LeaveApprovalRules, type LeaveEligibility, type LeavePerson, type LeaveTypePolicy,
} from '@crew/contracts';
import type { TenantTx } from '../../platform/database/mongo.service';
import { displayName } from '../employees/employee-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

const EMPTY_CRITERIA: LeaveAllocationCriteria = { all: false, employmentTypes: [], departmentIds: [], designationIds: [], locationIds: [], legalEntityIds: [], groupIds: [], employeeIds: [] };

/** A leave type's stored policy, approval rules and eligibility with every default filled in. */
export function configOf(t: Doc): { policy: LeaveTypePolicy; approval: LeaveApprovalRules; eligibility: LeaveEligibility } {
  const policy = leaveTypePolicy.safeParse(t.policy ?? {});
  const approval = leaveApprovalRules.safeParse(t.approval ?? {});
  const eligibility = leaveEligibility.safeParse(t.eligibility ?? {});
  return {
    policy: policy.success ? policy.data : leaveTypePolicy.parse({}),
    approval: approval.success ? approval.data : leaveApprovalRules.parse({}),
    eligibility: eligibility.success ? eligibility.data : leaveEligibility.parse({}),
  };
}

export const criteriaOf = (a: Doc): LeaveAllocationCriteria => ({ ...EMPTY_CRITERIA, ...(a.criteria ?? {}) });

/** An employee as the leave rules read them. */
export interface EmployeeLite {
  id: string;
  membership_id: string | null;
  status: string;
  date_of_joining: string;
  last_working_day: string | null;
  legal_entity_id: string | null;
  department_id: string | null;
  designation_id: string | null;
  location_id: string | null;
  hr_workspace_id: string | null;
  employment_type: string | null;
  gender: string | null;
  name: string;
  code: string;
  groupIds: string[];
}

export function lite(e: Doc, groupIds: string[] = []): EmployeeLite {
  return {
    id: e.id,
    membership_id: e.membership_id ?? null,
    status: e.status,
    date_of_joining: e.date_of_joining,
    last_working_day: e.last_working_day ?? null,
    legal_entity_id: e.current_legal_entity_id ?? null,
    department_id: e.current_department_id ?? null,
    designation_id: e.current_designation_id ?? null,
    location_id: e.current_location_id ?? null,
    hr_workspace_id: e.hr_workspace_id ?? null,
    employment_type: e.employment_type ?? null,
    gender: e.gender ?? null,
    name: displayName(e as never),
    code: e.employee_code ?? '',
    groupIds,
  };
}

export const personOf = (e: EmployeeLite): LeavePerson => ({
  id: e.id, employmentType: e.employment_type, departmentId: e.department_id, designationId: e.designation_id, locationId: e.location_id,
  legalEntityId: e.legal_entity_id, hrWorkspaceId: e.hr_workspace_id, groupIds: e.groupIds,
});

/** Employee groups (Communication > Groups) by membership id, for the people given. */
export async function groupsByMembership(tx: TenantTx, membershipIds: (string | null)[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(membershipIds.filter((x): x is string => !!x))];
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  for (const g of await tx.collection('comm_groups').find({ archived_at: null, membership_ids: { $in: ids } }, { projection: { membership_ids: 1 } })) {
    for (const m of (g.membership_ids as string[]) ?? []) if (ids.includes(m)) out.set(m, [...(out.get(m) ?? []), g.id as string]);
  }
  return out;
}

/** Employees as EmployeeLite with their groups. */
export async function loadPeople(tx: TenantTx, filter: Doc, options: Doc = {}): Promise<EmployeeLite[]> {
  const docs = await tx.collection('employees').find(filter, options);
  const groups = await groupsByMembership(tx, docs.map((d) => d.membership_id ?? null));
  return docs.map((d) => lite(d, d.membership_id ? groups.get(d.membership_id) ?? [] : []));
}

/** A type is open to a person's recorded gender (no recorded or a non-binary gender is never blocked). */
export const genderOk = (t: Doc, e: Pick<EmployeeLite, 'gender'>) => {
  const g = (t.eligible_gender as string | undefined) ?? 'any';
  return g === 'any' || !(e.gender === 'female' || e.gender === 'male') || e.gender === g;
};

/** The level a person acts at for leave: what they see in their own Leave Management. */
export interface LeaveLevel { level: 'super' | 'hr' | 'employee'; company: boolean; hrWorkspaceIds: string[] }

/**
 * Everything the leave rules need, loaded once for a set of decisions. Since 2026-11-23 a leave type reaches people by
 * its visibility (HR Workspace, Employee Workspace or both), not by allocations: `allocations` are history only.
 */
export interface LeaveBook {
  types: Doc[];
  allocations: Doc[];
  /** Levels by membership id (people without a login are Employee Workspace). */
  levels: Map<string, LeaveLevel>;
  /** HR Workspaces that have the Leave module, by id. */
  hrWithLeave: Set<string>;
}

export async function loadBook(tx: TenantTx, opts: { includeInactive?: boolean } = {}): Promise<LeaveBook> {
  const types = await tx.collection('leave_types').find(opts.includeInactive ? {} : { archived_at: null }, { sort: { name: 1 } });
  const allocations = await tx.collection('leave_allocations').find({ revoked_at: null });
  const roles = new Map((await tx.collection('roles').find({ is_system: true, key: { $in: ['super_workspace', 'hr_workspace'] } }, { projection: { key: 1 } })).map((r) => [r.id as string, r.key as string]));
  const levels = new Map<string, LeaveLevel>();
  for (const a of await tx.collection('role_assignments').find({ role_id: { $in: [...roles.keys()] } }, { projection: { membership_id: 1, role_id: 1, constraints: 1 } })) {
    const key = roles.get(a.role_id as string);
    const cur = levels.get(a.membership_id as string) ?? { level: 'employee' as const, company: false, hrWorkspaceIds: [] };
    if (key === 'super_workspace') cur.level = 'super';
    else if (cur.level !== 'super') {
      cur.level = 'hr';
      const ids = ((a.constraints?.hrWorkspaceIds ?? []) as string[]);
      if (ids.length) cur.hrWorkspaceIds = [...new Set([...cur.hrWorkspaceIds, ...ids])];
      else cur.company = true;
    }
    levels.set(a.membership_id as string, cur);
  }
  const hrWithLeave = new Set(await tx.collection('hr_workspaces').distinct<string>('id', { status: 'active', features: 'leave' }));
  return { types, allocations, levels, hrWithLeave };
}

export const levelOfPerson = (book: LeaveBook, e: Pick<EmployeeLite, 'membership_id'>): LeaveLevel =>
  (e.membership_id && book.levels.get(e.membership_id)) || { level: 'employee', company: false, hrWorkspaceIds: [] };

/** The HR Workspace a type belongs to: null for the Super Workspace's (and the company HR team's) types. */
export const ownerHrWorkspace = (t: Doc): string | null => (t.owner_level === 'hr' ? ((t.owner_hr_workspace_id as string | null) ?? null) : null);

/**
 * Whether an HR Workspace (null: the company's HR team) reviews applications of a type: every type of the Super
 * Workspace, and an HR Workspace's own types by that HR Workspace only. An HR Workspace without the Leave module
 * reviews nothing.
 */
export function availableTo(book: LeaveBook, typeId: string, hrWorkspaceId: string | null): boolean {
  const t = book.types.find((x) => x.id === typeId);
  if (!t) return false;
  if (hrWorkspaceId && !book.hrWithLeave.has(hrWorkspaceId)) return false;
  return t.owner_level === 'hr' ? ownerHrWorkspace(t) === hrWorkspaceId : true;
}

/** Kept for the history screens: whether an old allocation reached a person. Gives no leave since 2026-11-23. */
export function allocationReaches(_book: LeaveBook, a: Doc, e: EmployeeLite): boolean {
  if (a.target !== 'employees' || a.revoked_at) return false;
  if (a.hr_workspace_id && a.hr_workspace_id !== e.hr_workspace_id) return false;
  return leaveAllocationMatches(criteriaOf(a), personOf(e));
}

/** Is a type visible to a person, by its visibility, its owner and the person's level? */
export function typeVisibleTo(t: Doc, e: EmployeeLite, lv: LeaveLevel): boolean {
  const v = (t.visibility as string | undefined) ?? 'both';
  const owner = ownerHrWorkspace(t);
  if (lv.level === 'super') return true;
  if (lv.level === 'hr') {
    if (!(v === 'both' || v === 'hr')) return false;
    if (t.owner_level !== 'hr' || !owner) return true;
    return lv.company || lv.hrWorkspaceIds.includes(owner);
  }
  if (!(v === 'both' || v === 'employee')) return false;
  return t.owner_level !== 'hr' || !owner || e.hr_workspace_id === owner;
}

export interface Entitlement {
  type: Doc;
  /** Who made the type (the old allocation field, kept so screens can say who set it up). */
  allocation: Doc;
  /** Always '0': nothing is credited automatically. Quantities are assigned by hand. */
  annualEntitlement: string;
  policy: LeaveTypePolicy;
  approval: LeaveApprovalRules;
}

/**
 * The leave types a person can apply for now: active, visible to their level (HR Workspace people see the types
 * visible to HR Workspace, everyone else the ones visible to Employee Workspace; the Super Workspace every one),
 * inside the type's eligibility and gender. No allocation, no entitlement: quantities are assigned by hand.
 */
export function entitlementsOf(book: LeaveBook, e: EmployeeLite, opts: { includeInactive?: boolean } = {}): Map<string, Entitlement> {
  const out = new Map<string, Entitlement>();
  const p = personOf(e);
  const lv = levelOfPerson(book, e);
  for (const t of book.types) {
    if (t.archived_at && !opts.includeInactive) continue;
    const cfg = configOf(t);
    if (!genderOk(t, e) || !leaveEligible(cfg.eligibility, p) || !typeVisibleTo(t, e, lv)) continue;
    const allocation = { by_level: (t.owner_level as string | undefined) ?? (t.created_by_level as string | undefined) ?? 'super', by_name: (t.created_by_name as string | null) ?? null, created_at: t.created_at, hr_workspace_id: ownerHrWorkspace(t) };
    out.set(t.id, { type: t, allocation, annualEntitlement: '0', policy: cfg.policy, approval: cfg.approval });
  }
  return out;
}

export const { addDays, countLeaveDays, fromH, toH, yearOf, daysBetweenInclusive } = leaveMath;
export const today = () => new Date().toISOString().slice(0, 10);
export const sumBy = <T>(rows: T[], value: (r: T) => unknown) => rows.reduce((t, r) => t + toH(String(value(r) ?? '0')), 0);

export function cmp(a: unknown, b: unknown): number {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}
