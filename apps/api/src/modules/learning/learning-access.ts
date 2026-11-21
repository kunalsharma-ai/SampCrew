import { DEFAULT_HR_LEARNING_CAPS, LEARNING_CAPS, type LearningCap } from '@crew/contracts';
import { grantCovers, scopeFilter, type Grant, type Subject } from '../../platform/authz/policy';
import type { TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** 'central' for company-wide HR admins, otherwise an HR Workspace id. */
export type ScopeKey = string;
export const CENTRAL = 'central';

export interface LearningScope { key: ScopeKey; name: string; caps: Set<LearningCap> }

/**
 * What the signed-in person may do in Learning management. The Super Workspace can do everything for everyone.
 * An HR Workspace admin can do only what the Super Workspace switched on for that HR Workspace (company-wide HR
 * admins: the "company-wide HR" row), and only for the people that HR Workspace looks after. Everyone else is a
 * learner. Every service call checks this; the screens only mirror it.
 */
export class LearningAccess {
  constructor(
    readonly subject: Subject,
    readonly isSuper: boolean,
    readonly scopes: LearningScope[],
    /** Company-wide HR grants of learning:manage (their reach decides who "central" covers). */
    private readonly centralGrants: Grant[],
  ) {}

  get manager() { return this.isSuper || this.scopes.length > 0; }

  has(cap: LearningCap): boolean {
    return this.isSuper || this.scopes.some((s) => s.caps.has(cap));
  }

  require(cap: LearningCap, message?: string): void {
    if (!this.has(cap)) throw Errors.forbiddenCode('learning_permission', message ?? `Your Super Workspace has not given you "${CAP_PHRASE[cap]}" in Learning.`);
  }

  scopesWith(cap: LearningCap): LearningScope[] {
    return this.scopes.filter((s) => s.caps.has(cap));
  }

  /** Whether `cap` is on for a module's owner (the Super Workspace's modules: only the Super Workspace). */
  canOnModule(cap: LearningCap, m: Doc): boolean {
    if (this.isSuper) return true;
    if (m.creator_level !== 'hr') return false;
    const key = m.owner_hr_workspace_id ?? CENTRAL;
    return this.scopes.some((s) => s.key === key && s.caps.has(cap));
  }

  /** Employees `cap` reaches, as a query filter on employees (matches nothing without it). */
  peopleFilter(cap: LearningCap): Doc {
    if (this.isSuper) return {};
    const parts: Doc[] = [];
    for (const s of this.scopesWith(cap)) {
      if (s.key === CENTRAL) {
        const f = scopeFilter({ ...this.subject, grants: this.centralGrants }, 'learning:manage', EMPLOYEE_FIELDS);
        if (f) parts.push(f);
      } else parts.push({ hr_workspace_id: s.key });
    }
    if (!parts.length) return { _id: { $in: [] } };
    return parts.length === 1 ? parts[0]! : { $or: parts };
  }

  /** Whether `cap` reaches this employee. */
  covers(cap: LearningCap, e: Doc): boolean {
    if (this.isSuper) return true;
    const attrs = employeeAttrs({ id: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null });
    return this.scopesWith(cap).some((s) => (s.key === CENTRAL ? this.centralGrants.some((g) => grantCovers(this.subject, g, attrs)) : e.hr_workspace_id === s.key));
  }

  /** The scope keys `cap` is on for (for remembering an assigner's reach). */
  scopeKeys(cap: LearningCap): string[] {
    return this.isSuper ? ['super'] : this.scopesWith(cap).map((s) => s.key);
  }
}

const CAP_PHRASE: Record<LearningCap, string> = {
  view: 'View learning', create: 'Create learning module', edit: 'Edit learning module', publish: 'Publish learning module', assign: 'Assign learning',
  quiz: 'Create quiz', assignment: 'Create assignment', grade: 'Grade assignment', reports: 'View learning reports', export: 'Export learning reports',
};

/** The caps saved for each HR Workspace (null key: company-wide HR); missing rows have the defaults. */
export async function hrCapsMap(tx: TenantTx): Promise<Map<string, LearningCap[]>> {
  const rows = await tx.collection('learning_hr_permissions').find({});
  return new Map(rows.map((r) => [(r.hr_workspace_id as string | null) ?? CENTRAL, (r.caps as string[]).filter((c): c is LearningCap => (LEARNING_CAPS as readonly string[]).includes(c))]));
}

export async function learningAccess(tx: TenantTx, s: Subject): Promise<LearningAccess> {
  const isSuper = s.grants.some((g) => g.roleKey === 'super_workspace' && g.permission === 'learning:configure');
  if (isSuper) return new LearningAccess(s, true, [], []);
  // HR Workspace level only, and only while the person still holds learning:manage through it.
  const hrGrants = s.grants.filter((g) => g.roleKey === 'hr_workspace' && g.permission === 'learning:manage');
  if (!hrGrants.length) return new LearningAccess(s, false, [], []);
  const caps = await hrCapsMap(tx);
  const scopes: LearningScope[] = [];
  const centralGrants = hrGrants.filter((g) => !g.constraints.hrWorkspaceIds?.length);
  if (centralGrants.length) scopes.push({ key: CENTRAL, name: 'Company-wide HR', caps: new Set(caps.get(CENTRAL) ?? DEFAULT_HR_LEARNING_CAPS) });
  const ids = [...new Set(hrGrants.flatMap((g) => g.constraints.hrWorkspaceIds ?? []))];
  if (ids.length) {
    for (const w of await tx.collection('hr_workspaces').find({ id: { $in: ids }, status: 'active' }, { projection: { name: 1 } })) {
      scopes.push({ key: w.id as string, name: w.name as string, caps: new Set(caps.get(w.id as string) ?? DEFAULT_HR_LEARNING_CAPS) });
    }
  }
  // A scope with nothing switched on gives nothing.
  return new LearningAccess(s, false, scopes.filter((x) => x.caps.size > 0), centralGrants);
}
