import { Injectable } from '@nestjs/common';
import { CRM_CAPS, CRM_CENTRAL, type CrmAccessInput, type CrmCap, type CrmContext } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { crmSettings, type Doc, sourcesOf, stagesOf } from './crm-common';

/**
 * Who is working in the Candidate CRM and what they may reach. Worked out on every request from the person's access
 * level and Super Workspace's switches, so a switch takes effect at once.
 *  - Super Workspace: every candidate of the company, every power, and the switches themselves.
 *  - HR Workspace: only candidates owned by (or shared with) the HR Workspaces they run that have the CRM switched on;
 *    the company-wide HR team works on the company's own (unowned) candidates when "central" is switched on.
 *  - Employee Workspace: never.
 */
export interface CrmActor {
  level: 'super' | 'hr';
  membershipId: string;
  /** Access keys the person works in with the CRM on: HR Workspace ids, and "central". */
  keys: string[];
  caps: Map<string, Set<CrmCap>>;
  canManage: boolean;
}

@Injectable()
export class CrmAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** The person's CRM access, or a refusal that says why. `manage`: they must be allowed to change candidates. */
  async actor(tx: TenantTx, need: 'read' | 'manage' = 'read'): Promise<CrmActor> {
    const s = await this.authz.subject(tx);
    const read = hasPermission(s, 'candidates:read');
    if (!read.allowed) {
      if (read.reason === 'mfa_required') throw Errors.mfaRequired();
      throw Errors.forbiddenCode('crm_not_available', 'Candidate CRM is for Super Workspace and HR Workspace people with recruitment access.');
    }
    const canManage = hasPermission(s, 'candidates:manage').allowed;
    if (need === 'manage' && !canManage) throw Errors.forbidden('You can view candidates but not change them');
    const membershipId = requestContext.tenantActor().membershipId;
    if (s.grants.some((g) => g.roleKey === 'super_workspace' && g.permission === 'candidates:read')) {
      return { level: 'super', membershipId, keys: [CRM_CENTRAL], caps: new Map([[CRM_CENTRAL, new Set(CRM_CAPS)]]), canManage };
    }
    const hrGrants = s.grants.filter((g) => g.roleKey === 'hr_workspace' && g.permission === 'candidates:read');
    if (!hrGrants.length) throw Errors.forbiddenCode('crm_not_available', 'Candidate CRM is for Super Workspace and HR Workspace people. Employee Workspace does not have it.');
    const wanted = new Set<string>();
    for (const g of hrGrants) {
      const ids = g.constraints.hrWorkspaceIds ?? [];
      if (!ids.length) wanted.add(CRM_CENTRAL);
      ids.forEach((id) => wanted.add(id));
    }
    const live = new Set(await tx.collection('hr_workspaces').distinct<string>('id', { id: { $in: [...wanted].filter((k) => k !== CRM_CENTRAL) }, status: 'active' }));
    const rows = await tx.collection('candidate_crm_access').find({ key: { $in: [...wanted] }, enabled: true });
    const caps = new Map<string, Set<CrmCap>>();
    for (const r of rows) if (r.key === CRM_CENTRAL || live.has(r.key)) caps.set(r.key as string, new Set((r.caps ?? []) as CrmCap[]));
    if (!caps.size) {
      throw Errors.forbiddenCode('crm_not_enabled', 'Candidate CRM is not switched on for your HR Workspace. Your Super Workspace can switch it on in Candidate CRM settings.');
    }
    return { level: 'hr', membershipId, keys: [...caps.keys()], caps, canManage };
  }

  /** A filter on candidates limiting them to the ones this person may see in the CRM. */
  filter(a: CrmActor): Doc {
    if (a.level === 'super') return {};
    const ids = a.keys.filter((k) => k !== CRM_CENTRAL);
    const or: Doc[] = [];
    if (ids.length) or.push({ crm_hr_workspace_id: { $in: ids } }, { crm_shared_hr_workspace_ids: { $in: ids } });
    if (a.keys.includes(CRM_CENTRAL)) or.push({ crm_hr_workspace_id: null });
    return or.length ? { $or: or } : { _id: { $in: [] } };
  }

  /** The access keys through which this person sees a candidate (empty: they cannot). */
  keysFor(a: CrmActor, c: Doc): string[] {
    if (a.level === 'super') return [CRM_CENTRAL];
    const owner = (c.crm_hr_workspace_id as string | null) ?? CRM_CENTRAL;
    const shared = (c.crm_shared_hr_workspace_ids as string[] | undefined) ?? [];
    return a.keys.filter((k) => k === owner || shared.includes(k));
  }

  /** Can this person use a power on this candidate (or, with no candidate, anywhere)? */
  has(a: CrmActor, cap: CrmCap, c?: Doc): boolean {
    if (a.level === 'super') return true;
    const keys = c ? this.keysFor(a, c) : a.keys;
    return keys.some((k) => a.caps.get(k)?.has(cap));
  }

  require(a: CrmActor, cap: CrmCap, c?: Doc) {
    if (!this.has(a, cap, c)) throw Errors.forbiddenCode('crm_cap_missing', `Your Super Workspace has not given your HR Workspace "${capName(cap)}" in Candidate CRM.`);
  }

  /** Loads a candidate the person may see, or 404 (the same answer whether it does not exist or is another HR Workspace's). */
  async candidate(tx: TenantTx, a: CrmActor, id: string): Promise<Doc> {
    const c = await tx.collection('candidates').findOne({ $and: [{ id }, this.filter(a)] });
    if (!c) throw Errors.notFound('Candidate');
    return c;
  }

  /** The owner a new record gets: the one asked for if the person works there, else their first. */
  ownerFor(a: CrmActor, asked: string | null | undefined): string | null {
    if (a.level === 'super') return asked ?? null;
    if (asked === undefined) return a.keys.find((k) => k !== CRM_CENTRAL) ?? null;
    const key = asked ?? CRM_CENTRAL;
    if (!a.keys.includes(key)) throw Errors.forbiddenCode('crm_wrong_workspace', 'You can add candidates only to HR Workspaces where you work with Candidate CRM.');
    return asked;
  }

  /** What the CRM pages need to know about the person and the company's CRM settings. */
  async context(): Promise<CrmContext> {
    return this.db.tenant(async (tx) => {
      const a = await this.actor(tx);
      const settings = await crmSettings(tx);
      const spaces = await tx.collection('hr_workspaces').find({ status: 'active' }, { projection: { name: 1 }, sort: { name: 1 } });
      const names = new Map(spaces.map((w) => [w.id as string, w.name as string]));
      const workspaces = a.keys.map((k) => ({ key: k, name: k === CRM_CENTRAL ? (a.level === 'super' ? 'Super Workspace' : 'Company-wide HR') : names.get(k) ?? 'HR Workspace', caps: [...(a.caps.get(k) ?? [])] }));
      return {
        level: a.level,
        workspaces,
        caps: CRM_CAPS.filter((c) => this.has(a, c)),
        canManageAccess: a.level === 'super',
        canConfigure: a.level === 'super',
        stages: stagesOf(settings),
        sources: sourcesOf(settings),
        recruiters: await this.recruiters(tx, a),
        hrWorkspaces: a.level === 'super' ? spaces.map((w) => ({ id: w.id as string, name: w.name as string })) : workspaces.filter((w) => w.key !== CRM_CENTRAL).map((w) => ({ id: w.key, name: w.name })),
      };
    });
  }

  /**
   * People a candidate can be assigned to: Super Workspace and HR Workspace people who can change candidates. An HR
   * Workspace person sees only people of their own HR Workspaces (and themselves).
   */
  async recruiters(tx: TenantTx, a: CrmActor): Promise<{ membershipId: string; name: string }[]> {
    const levels = new Map((await tx.collection('roles').find({ is_system: true, key: { $in: ['super_workspace', 'hr_workspace'] } }, { projection: { key: 1 } })).map((r) => [r.id as string, r.key as string]));
    const held = await tx.collection('role_assignments').find({ role_id: { $in: [...levels.keys()] } }, { projection: { membership_id: 1, role_id: 1, constraints: 1 } });
    const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: held.map((h) => h.membership_id) }, status: 'active' }));
    const ok = new Set<string>();
    for (const h of held) {
      if (!active.has(h.membership_id)) continue;
      if (a.level === 'super') { ok.add(h.membership_id); continue; }
      const ids = (h.constraints?.hrWorkspaceIds ?? []) as string[];
      if (h.membership_id === a.membershipId || ids.some((id) => a.keys.includes(id)) || (!ids.length && levels.get(h.role_id) === 'hr_workspace' && a.keys.includes(CRM_CENTRAL))) ok.add(h.membership_id);
    }
    const names = await membershipUserNames(tx, [...ok]);
    return [...ok].map((m) => ({ membershipId: m, name: names.get(m) ?? 'Someone' })).sort((x, y) => x.name.localeCompare(y.name));
  }

  // ------------------------------------------------------------------------------------------------------------
  // Super Workspace's switches
  // ------------------------------------------------------------------------------------------------------------

  async accessList() {
    return this.db.tenant(async (tx) => {
      const a = await this.actor(tx);
      if (a.level !== 'super') throw Errors.forbidden('Only Super Workspace manages Candidate CRM access');
      const rows = new Map((await tx.collection('candidate_crm_access').find({})).map((r) => [r.key as string, r]));
      const spaces = await tx.collection('hr_workspaces').find({ status: { $ne: 'archived' } }, { projection: { name: 1, status: 1, features: 1 }, sort: { name: 1 } });
      const owned = new Map((await tx.collection('candidates').aggregate<{ id: string | null; n: number }>([{ $match: { anonymized_at: null } }, { $group: { _id: '$crm_hr_workspace_id', n: { $sum: 1 } } }])).map((x) => [x.id ?? CRM_CENTRAL, x.n]));
      const names = await membershipUserNames(tx, [...rows.values()].map((r) => r.updated_by_membership_id));
      const view = (key: string, name: string, extra: Doc = {}) => {
        const r = rows.get(key);
        return {
          key, name, enabled: !!r?.enabled, caps: (r?.caps ?? []) as CrmCap[], candidates: owned.get(key) ?? 0,
          updatedAt: r?.updated_at ?? null, updatedBy: r ? names.get(r.updated_by_membership_id) ?? null : null, ...extra,
        };
      };
      return {
        rows: [
          view(CRM_CENTRAL, 'Company-wide HR team', { central: true, status: 'active', recruitment: true }),
          ...spaces.map((w) => view(w.id as string, w.name as string, { central: false, status: w.status, recruitment: ((w.features ?? []) as string[]).includes('recruitment') })),
        ],
      };
    });
  }

  async setAccess(input: CrmAccessInput) {
    return this.db.tenant(async (tx) => {
      const a = await this.actor(tx);
      if (a.level !== 'super') throw Errors.forbidden('Only Super Workspace manages Candidate CRM access');
      const ids = input.changes.map((c) => c.key).filter((k) => k !== CRM_CENTRAL);
      const known = new Set(await tx.collection('hr_workspaces').distinct<string>('id', { id: { $in: ids }, status: { $ne: 'archived' } }));
      const table = tx.collection('candidate_crm_access');
      for (const c of input.changes) {
        if (c.key !== CRM_CENTRAL && !known.has(c.key)) throw Errors.badRequest('unknown_hr_workspace', 'One of these HR Workspaces no longer exists');
        const before = await table.findOne({ key: c.key });
        const fields = { enabled: c.enabled, caps: c.caps, updated_by_membership_id: a.membershipId };
        await table.upsert({ key: c.key }, { key: c.key, ...fields }, { $set: fields });
        if (!before || before.enabled !== c.enabled || [...(before.caps ?? [])].sort().join() !== [...c.caps].sort().join()) {
          await this.audit.record(tx, {
            action: c.enabled ? (before?.enabled ? 'candidate_crm.access_changed' : 'candidate_crm.access_enabled') : 'candidate_crm.access_disabled',
            resourceType: 'candidate_crm_access', resourceId: c.key === CRM_CENTRAL ? null : c.key,
            changes: { key: c.key, enabled: { from: before?.enabled ?? false, to: c.enabled }, caps: { from: before?.caps ?? [], to: c.caps } },
          });
        }
      }
      return { saved: input.changes.length };
    });
  }
}

const capName = (c: CrmCap) => ({ fields: 'Create custom fields', import: 'Import candidates', export: 'Export candidates', archive: 'Archive and delete', sensitive: 'See restricted remarks and personal details' })[c];
