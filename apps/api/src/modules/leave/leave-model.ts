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

/** Everything allocation needs, loaded once for a set of decisions. */
export interface LeaveBook {
  types: Doc[];
  allocations: Doc[];
  /** typeId|hrWorkspaceId ('' for the company's HR team) of types made available to HR. */
  available: Set<string>;
}

export async function loadBook(tx: TenantTx, opts: { includeInactive?: boolean } = {}): Promise<LeaveBook> {
  const types = await tx.collection('leave_types').find(opts.includeInactive ? {} : { archived_at: null }, { sort: { name: 1 } });
  const allocations = await tx.collection('leave_allocations').find({ revoked_at: null });
  const available = new Set(allocations.filter((a) => a.target === 'hr_workspace').map((a) => `${a.leave_type_id}|${a.hr_workspace_id ?? ''}`));
  return { types, allocations, available };
}

export const availableTo = (book: LeaveBook, typeId: string, hrWorkspaceId: string | null) => book.available.has(`${typeId}|${hrWorkspaceId ?? ''}`);

/** How specific an allocation is for a person: a named person beats a group, which beats a designation, and so on. */
function rankOf(a: Doc, p: LeavePerson): number {
  const c = criteriaOf(a);
  if (c.employeeIds.includes(p.id)) return 100;
  if (c.all) return a.hr_workspace_id ? 0.5 : 0;
  return (c.locationIds.length ? 8 : 0) + (c.designationIds.length ? 4 : 0) + (c.groupIds.length ? 3 : 0) + (c.departmentIds.length ? 2 : 0)
    + (c.legalEntityIds.length ? 1 : 0) + (c.employmentTypes.length ? 1 : 0) + (a.hr_workspace_id ? 0.5 : 0);
}

/** An allocation counts while it reaches the person, and (for an HR Workspace's own) while the type is still available to it. */
export function allocationReaches(book: LeaveBook, a: Doc, e: EmployeeLite): boolean {
  if (a.target !== 'employees' || a.revoked_at) return false;
  if (a.hr_workspace_id && a.hr_workspace_id !== e.hr_workspace_id) return false;
  if (a.by_level === 'hr' && !availableTo(book, a.leave_type_id, a.hr_workspace_id ?? null)) return false;
  return leaveAllocationMatches(criteriaOf(a), personOf(e));
}

export interface Entitlement {
  type: Doc;
  allocation: Doc;
  /** Days a year for this person (the allocation's own number, else the type's). */
  annualEntitlement: string;
  policy: LeaveTypePolicy;
  approval: LeaveApprovalRules;
}

/**
 * The leave types a person holds now: active, inside the type's eligibility and gender, and reached by at least one
 * allocation. The most specific allocation decides the entitlement.
 */
export function entitlementsOf(book: LeaveBook, e: EmployeeLite, opts: { includeInactive?: boolean } = {}): Map<string, Entitlement> {
  const out = new Map<string, Entitlement>();
  const p = personOf(e);
  for (const t of book.types) {
    if (t.archived_at && !opts.includeInactive) continue;
    const cfg = configOf(t);
    if (!genderOk(t, e) || !leaveEligible(cfg.eligibility, p)) continue;
    let best: Doc | undefined;
    let bestRank = -1;
    for (const a of book.allocations) {
      if (a.leave_type_id !== t.id || !allocationReaches(book, a, e)) continue;
      const r = rankOf(a, p);
      if (r > bestRank || (r === bestRank && a.created_at > best!.created_at)) { best = a; bestRank = r; }
    }
    if (!best) continue;
    const own = best.entitlement_days !== null && best.entitlement_days !== undefined ? String(best.entitlement_days) : null;
    out.set(t.id, { type: t, allocation: best, annualEntitlement: own ?? cfg.policy.annualEntitlement, policy: cfg.policy, approval: cfg.approval });
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
