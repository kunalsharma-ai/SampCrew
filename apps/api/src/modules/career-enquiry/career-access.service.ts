import { Injectable } from '@nestjs/common';
import { CAREER_CAP_LABEL, CAREER_CAPS, CAREER_CENTRAL, type CareerAccessInput, type CareerCap, type CareerScope } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { accessKeyOf, type Doc, namesOf } from './career-common';

/**
 * Who works in Career Enquiry and what they reach, worked out on every request (a switch takes effect at once):
 *  - Super Workspace: every application, every power, the settings and the switches.
 *  - HR Workspace: only applications of the HR Workspaces they run (or the company-wide HR team's) where Super
 *    Workspace switched Career Enquiry on; with scope "assigned", only those assigned to them; with the powers given.
 *  - Employee Workspace: never.
 */
export interface CareerActor {
  level: 'super' | 'hr';
  membershipId: string;
  keys: string[];
  scope: Map<string, CareerScope>;
  caps: Map<string, Set<CareerCap>>;
  canManage: boolean;
}

@Injectable()
export class CareerAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  async actor(tx: TenantTx): Promise<CareerActor> {
    const s = await this.authz.subject(tx);
    const read = hasPermission(s, 'candidates:read');
    if (!read.allowed) {
      if (read.reason === 'mfa_required') throw Errors.mfaRequired();
      throw Errors.forbiddenCode('career_not_available', 'Career Enquiry is for Super Workspace and HR Workspace people with recruitment access.');
    }
    const canManage = hasPermission(s, 'candidates:manage').allowed;
    const membershipId = requestContext.tenantActor().membershipId;
    if (s.grants.some((g) => g.roleKey === 'super_workspace' && g.permission === 'candidates:read')) {
      return { level: 'super', membershipId, keys: [CAREER_CENTRAL], scope: new Map([[CAREER_CENTRAL, 'all']]), caps: new Map([[CAREER_CENTRAL, new Set(CAREER_CAPS)]]), canManage };
    }
    const hrGrants = s.grants.filter((g) => g.roleKey === 'hr_workspace' && g.permission === 'candidates:read');
    if (!hrGrants.length) throw Errors.forbiddenCode('career_not_available', 'Career Enquiry is for Super Workspace and HR Workspace people. Employee Workspace does not have it.');
    const wanted = new Set<string>();
    for (const g of hrGrants) {
      const ids = g.constraints.hrWorkspaceIds ?? [];
      if (!ids.length) wanted.add(CAREER_CENTRAL);
      ids.forEach((id) => wanted.add(id));
    }
    const live = new Set(await tx.collection('hr_workspaces').distinct<string>('id', { id: { $in: [...wanted].filter((k) => k !== CAREER_CENTRAL) }, status: 'active' }));
    const rows = await tx.collection('career_access').find({ key: { $in: [...wanted] }, enabled: true });
    const caps = new Map<string, Set<CareerCap>>();
    const scope = new Map<string, CareerScope>();
    for (const r of rows) {
      if (r.key !== CAREER_CENTRAL && !live.has(r.key)) continue;
      caps.set(r.key as string, new Set((r.caps ?? []) as CareerCap[]));
      scope.set(r.key as string, (r.scope as CareerScope | undefined) ?? 'all');
    }
    if (!caps.size) {
      throw Errors.forbiddenCode('career_not_enabled', 'Career Enquiry is not switched on for your HR Workspace. Your Super Workspace can switch it on in Settings > Career Integration.');
    }
    return { level: 'hr', membershipId, keys: [...caps.keys()], scope, caps, canManage };
  }

  /** A filter on career_applications limiting them to the ones this person may see. */
  filter(a: CareerActor): Doc {
    if (a.level === 'super') return {};
    const mine = { $or: [{ assigned_hr_membership_id: a.membershipId }, { assigned_recruiter_membership_id: a.membershipId }] };
    const or = a.keys.map((k) => {
      const where = { hr_workspace_id: k === CAREER_CENTRAL ? null : k };
      return a.scope.get(k) === 'assigned' ? { $and: [where, mine] } : where;
    });
    return or.length ? { $or: or } : { _id: { $in: [] } };
  }

  has(a: CareerActor, cap: CareerCap, app?: Doc): boolean {
    if (a.level === 'super') return true;
    if (!app) return a.keys.some((k) => a.caps.get(k)?.has(cap));
    return !!a.caps.get(accessKeyOf(app.hr_workspace_id))?.has(cap);
  }

  require(a: CareerActor, cap: CareerCap, app?: Doc) {
    if (cap === 'manage' && !a.canManage) throw Errors.forbidden('You can view applications but not change them');
    if (!this.has(a, cap, app)) throw Errors.forbiddenCode('career_cap_missing', `Your Super Workspace has not given your HR Workspace "${CAREER_CAP_LABEL[cap]}" in Career Enquiry.`);
  }

  requireSuper(a: CareerActor) {
    if (a.level !== 'super') throw Errors.forbiddenCode('career_super_only', 'Only Super Workspace manages the Career Integration settings.');
  }

  /** One application the person may see, or 404 (the same answer whether it does not exist or is out of reach). */
  async application(tx: TenantTx, a: CareerActor, id: string): Promise<Doc> {
    const app = await tx.collection('career_applications').findOne({ $and: [{ id }, this.filter(a)] });
    if (!app) throw Errors.notFound('Application');
    return app;
  }

  /** People an application can be assigned to: Super Workspace and HR Workspace people who can change candidates. */
  async assignees(tx: TenantTx, a: CareerActor): Promise<{ membershipId: string; name: string; level: 'super' | 'hr' }[]> {
    const levels = new Map((await tx.collection('roles').find({ is_system: true, key: { $in: ['super_workspace', 'hr_workspace'] } }, { projection: { key: 1 } })).map((r) => [r.id as string, r.key as string]));
    const held = await tx.collection('role_assignments').find({ role_id: { $in: [...levels.keys()] } }, { projection: { membership_id: 1, role_id: 1, constraints: 1 } });
    const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: held.map((h) => h.membership_id) }, status: 'active' }));
    const ok = new Map<string, 'super' | 'hr'>();
    for (const h of held) {
      if (!active.has(h.membership_id)) continue;
      const lvl = levels.get(h.role_id) === 'super_workspace' ? 'super' : 'hr';
      if (a.level === 'super') { if (ok.get(h.membership_id) !== 'super') ok.set(h.membership_id, lvl); continue; }
      const ids = (h.constraints?.hrWorkspaceIds ?? []) as string[];
      if (h.membership_id === a.membershipId || ids.some((id) => a.keys.includes(id)) || (!ids.length && lvl === 'hr' && a.keys.includes(CAREER_CENTRAL))) ok.set(h.membership_id, lvl);
    }
    const names = await namesOf(tx, [...ok.keys()]);
    return [...ok].map(([m, level]) => ({ membershipId: m, name: names.get(m) ?? 'Someone', level })).sort((x, y) => x.name.localeCompare(y.name));
  }

  /** Who hears about a new application: the assigned people, else everyone who can see it (Super Workspace if asked). */
  async audience(tx: TenantTx, app: Doc, opts: { superWorkspace: boolean }): Promise<string[]> {
    const out = new Set<string>([app.assigned_hr_membership_id, app.assigned_recruiter_membership_id].filter(Boolean));
    const levels = new Map((await tx.collection('roles').find({ is_system: true, key: { $in: ['super_workspace', 'hr_workspace'] } }, { projection: { key: 1 } })).map((r) => [r.id as string, r.key as string]));
    const held = await tx.collection('role_assignments').find({ role_id: { $in: [...levels.keys()] } }, { projection: { membership_id: 1, role_id: 1, constraints: 1 } });
    const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: held.map((h) => h.membership_id) }, status: 'active' }));
    const key = accessKeyOf(app.hr_workspace_id);
    const row = await tx.collection('career_access').findOne({ key, enabled: true });
    for (const h of held) {
      if (!active.has(h.membership_id)) continue;
      if (levels.get(h.role_id) === 'super_workspace') { if (opts.superWorkspace) out.add(h.membership_id); continue; }
      if (out.size && row?.scope === 'assigned') continue;
      const ids = (h.constraints?.hrWorkspaceIds ?? []) as string[];
      const reaches = key === CAREER_CENTRAL ? !ids.length : ids.includes(key);
      if (row && row.scope !== 'assigned' && reaches) out.add(h.membership_id);
    }
    return [...out];
  }

  // Super Workspace's switches ---------------------------------------------------------------------------------

  async accessList() {
    return this.db.tenant(async (tx) => {
      this.requireSuper(await this.actor(tx));
      const rows = new Map((await tx.collection('career_access').find({})).map((r) => [r.key as string, r]));
      const spaces = await tx.collection('hr_workspaces').find({ status: { $ne: 'archived' } }, { projection: { name: 1, status: 1 }, sort: { name: 1 } });
      const counts = new Map((await tx.collection('career_applications').aggregate<{ id: string | null; n: number }>([{ $group: { _id: '$hr_workspace_id', n: { $sum: 1 } } }])).map((x) => [x.id ?? CAREER_CENTRAL, x.n]));
      const names = await namesOf(tx, [...rows.values()].map((r) => r.updated_by_membership_id));
      const view = (key: string, name: string, central: boolean) => {
        const r = rows.get(key);
        return {
          key, name, central, enabled: !!r?.enabled, scope: ((r?.scope as CareerScope | undefined) ?? 'all'), caps: (r?.caps ?? []) as CareerCap[],
          applications: counts.get(key) ?? 0, updatedAt: r?.updated_at ?? null, updatedBy: r ? names.get(r.updated_by_membership_id) ?? null : null,
        };
      };
      return { rows: [view(CAREER_CENTRAL, 'Company-wide HR team', true), ...spaces.map((w) => view(w.id as string, w.name as string, false))] };
    });
  }

  async setAccess(input: CareerAccessInput) {
    return this.db.tenant(async (tx) => {
      const a = await this.actor(tx);
      this.requireSuper(a);
      const ids = input.changes.map((c) => c.key).filter((k) => k !== CAREER_CENTRAL);
      const known = new Set(await tx.collection('hr_workspaces').distinct<string>('id', { id: { $in: ids }, status: { $ne: 'archived' } }));
      const table = tx.collection('career_access');
      for (const c of input.changes) {
        if (c.key !== CAREER_CENTRAL && !known.has(c.key)) throw Errors.badRequest('unknown_hr_workspace', 'One of these HR Workspaces no longer exists');
        const before = await table.findOne({ key: c.key });
        const fields = { enabled: c.enabled, scope: c.scope, caps: c.caps, updated_by_membership_id: a.membershipId };
        await table.upsert({ key: c.key }, { key: c.key, ...fields }, { $set: fields });
        await this.audit.record(tx, {
          action: c.enabled ? 'career_enquiry.access_changed' : 'career_enquiry.access_disabled', resourceType: 'career_access', resourceId: c.key === CAREER_CENTRAL ? null : c.key,
          changes: { key: c.key, enabled: { from: before?.enabled ?? false, to: c.enabled }, scope: { from: before?.scope ?? 'all', to: c.scope }, caps: { from: before?.caps ?? [], to: c.caps } },
        });
      }
      return { saved: input.changes.length };
    });
  }
}
