import { Injectable } from '@nestjs/common';
import {
  BOOLEAN_FEATURES,
  isCoreFeature,
  isFeaturePart,
  UNLIMITED,
  type ConfigVersionRow,
  type DelegatedModule,
  type HierarchyMemberRow,
  type HierarchyOverview,
  type HrWorkspaceDetail,
  type HrWorkspaceInput,
  type HrWorkspaceStatus,
  type HrWorkspaceSummary,
  type HrWorkspaceUpdate,
  type PlatformLevel,
  type TransferRow,
} from '@crew/contracts';
import { AuditService, type AuditInput } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can, hasPermission, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { employeeAttrs } from '../employees/employee-attrs';
import { fieldById, memberNames } from '../employees/employee-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '');
const CORE = new Set(BOOLEAN_FEATURES.filter((f) => isCoreFeature(f.key)).map((f) => f.key as string));
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
/** An HR Workspace's admins hold the HR Workspace level limited to it (constraints.hrWorkspaceIds). */
export const HR_WORKSPACE_ADMIN_ROLE = 'hr_workspace';

const attrsOfEmployee = (e: Doc) => employeeAttrs({ id: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null });

/**
 * The Super Workspace > HR Workspace > Employee part of the delegation chain. Every rule is checked here, on the
 * server, whatever a screen shows:
 *  - only the Super Workspace (hierarchy:manage) creates and changes HR Workspaces, within the max_hr_workspaces
 *    limit of the company's plan;
 *  - an HR Workspace gets a subset of what the company holds and the Console lets it pass down (never more);
 *  - an employee gets a subset of what their HR Workspace (or, in the central group, the company) holds;
 *  - a change made on an older version is refused, so two admins never silently overwrite each other;
 *  - every change is versioned (config_versions), audited with its level and old and new values, and pushed to the
 *    open screens of the people it affects. Entitlements are worked out on every request, so a module taken away
 *    upstream is gone at once everywhere below, also in sessions already open.
 */
@Injectable()
export class HierarchyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly outbox: OutboxService,
  ) {}

  // Levels -----------------------------------------------------------------------------------------------------------

  /** The level a change is made from: the Super Workspace (company-wide admins) or an HR Workspace. */
  private levelOf(s: Subject): PlatformLevel {
    return hasPermission(s, 'hierarchy:manage').allowed ? 'super' : 'hr';
  }

  /** HR Workspaces the subject administers through a limited grant (empty for company-wide admins). */
  private administered(s: Subject, permission: string): string[] | null {
    const grants = s.grants.filter((g) => g.permission === permission);
    if (!grants.length) return [];
    if (grants.some((g) => !g.constraints.hrWorkspaceIds?.length)) return null; // company-wide
    return [...new Set(grants.flatMap((g) => g.constraints.hrWorkspaceIds ?? []))];
  }

  private async mayRead(tx: TenantTx, s: Subject, hrWorkspaceId: string) {
    const ids = this.administered(s, 'hierarchy:read');
    if (ids === null) return;
    if (!ids.includes(hrWorkspaceId)) throw Errors.notFound('HR Workspace');
    void tx;
  }

  // The parent's modules -------------------------------------------------------------------------------------------------

  /** What the company holds now (plan, add-ons, deals, Console and its own switches), and what it may delegate. */
  private async company(tx: TenantTx) {
    const e = await loadEntitlements(tx);
    const controls = await tx.collection('tenant_access_controls').findOne({});
    const nonDelegable = ((controls?.non_delegable_features ?? []) as string[]).filter((k) => !CORE.has(k));
    // Modules only: pages and sub-areas (FEATURE_PARTS) follow their module and are switched in Feature management.
    const features = [...e.features].filter((k) => !isFeaturePart(k)).sort();
    return {
      features,
      delegable: features.filter((k) => !nonDelegable.includes(k)),
      nonDelegable,
      superMayCreateEmployees: (controls?.super_may_create_employees as boolean | undefined) ?? true,
      limits: e.limits,
    };
  }

  private moduleStates(given: string[], parent: string[], delegable: string[], nonDelegable: string[]): DelegatedModule[] {
    return BOOLEAN_FEATURES.map((f) => {
      const key = f.key as string;
      const core = CORE.has(key);
      const inParent = parent.includes(key);
      const allowed = core || (inParent && delegable.includes(key));
      const isGiven = core || given.includes(key);
      return {
        key, name: f.name, module: f.module, core,
        state: !allowed ? 'locked' : isGiven ? 'granted' : 'available',
        lockedBy: allowed ? null : nonDelegable.includes(key) && inParent ? 'console' : inParent ? 'super' : 'console',
        ...(given.includes(key) && !allowed ? { stale: true } : {}),
      } satisfies DelegatedModule;
    });
  }

  // Versions, audit and live updates ---------------------------------------------------------------------------------------

  private async version(tx: TenantTx, s: Subject, input: { level: PlatformLevel; targetType: 'company' | 'hr_workspace' | 'member'; targetId: string; version: number; action: string; changes: Record<string, { from: unknown; to: unknown }> }) {
    const actor = requestContext.get()?.actor;
    await tx.collection('config_versions').insert({
      level: input.level, target_type: input.targetType, target_id: input.targetId, version: input.version, action: input.action,
      changes: input.changes, actor_membership_id: s.membershipId, actor_label: actor?.label ?? null,
    });
  }

  /** People whose access follows from an HR Workspace: its admins and its employees. */
  private async affected(tx: TenantTx, hrWorkspaceId: string): Promise<string[]> {
    const employees = await tx.collection('employees').distinct<string>('membership_id', { hr_workspace_id: hrWorkspaceId, membership_id: { $ne: null } });
    const admins = await this.adminsOf(tx, [hrWorkspaceId]);
    return [...new Set([...employees, ...(admins.get(hrWorkspaceId) ?? [])])];
  }

  private async adminsOf(tx: TenantTx, ids: string[]): Promise<Map<string, string[]>> {
    const role = await tx.collection('roles').findOne({ key: HR_WORKSPACE_ADMIN_ROLE, is_system: true });
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (!role) return out;
    const rows = await tx.collection('role_assignments').find({ role_id: role.id, 'constraints.hrWorkspaceIds': { $in: ids } });
    const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: rows.map((r) => r.membership_id) }, status: { $in: ['active', 'invited'] } }));
    for (const r of rows) {
      if (!active.has(r.membership_id)) continue;
      for (const id of (r.constraints?.hrWorkspaceIds ?? []) as string[]) if (out.has(id)) out.get(id)!.push(r.membership_id as string);
    }
    return out;
  }

  // Views ----------------------------------------------------------------------------------------------------------------

  private async summaries(tx: TenantTx, rows: Doc[]): Promise<HrWorkspaceSummary[]> {
    const ids = rows.map((r) => r.id as string);
    const counts = new Map<string, number>();
    for (const e of await tx.collection('employees').find({ hr_workspace_id: { $in: ids }, status: { $ne: 'exited' } }, { projection: { hr_workspace_id: 1 } })) {
      counts.set(e.hr_workspace_id as string, (counts.get(e.hr_workspace_id as string) ?? 0) + 1);
    }
    const admins = await this.adminsOf(tx, ids);
    const allAdmins = [...admins.values()].flat();
    const names = await memberNames(tx, allAdmins);
    const memberships = await tx.collection('memberships').find({ id: { $in: allAdmins } }, { projection: { user_id: 1 } });
    const users = new Map((await (await tx.users()).find({ id: { $in: memberships.map((m) => m.user_id) } }, { projection: { email: 1 } })).map((u) => [u.id as string, u.email as string]));
    const emails = new Map(memberships.map((m) => [m.id as string, users.get(m.user_id as string) ?? null]));
    return rows.map((w) => ({
      id: w.id, name: w.name, code: w.code ?? null, kind: w.kind, description: w.description ?? '', status: w.status,
      features: (w.features ?? []) as string[], maxEmployees: w.max_employees ?? UNLIMITED,
      employees: counts.get(w.id) ?? 0,
      admins: (admins.get(w.id) ?? []).map((m) => ({ membershipId: m, name: names.get(m) ?? null, email: emails.get(m) ?? null })),
      version: w.version ?? 1, updatedAt: iso(w.updated_at), createdAt: iso(w.created_at),
    }));
  }

  overview(): Promise<HierarchyOverview> {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const mine = this.administered(s, 'hierarchy:read');
      const filter: Doc = { status: { $ne: 'archived' }, ...(mine === null ? {} : { id: { $in: mine } }) };
      const rows = await tx.collection('hr_workspaces').find(filter, { sort: { name: 1 } });
      const c = await this.company(tx);
      const tenant = await tx.collection('tenants').findOne({});
      const employees = await tx.collection('employees').count({ status: { $ne: 'exited' } });
      const central = await tx.collection('employees').count({ status: { $ne: 'exited' }, hr_workspace_id: null });
      const lim = (k: string) => (c.limits[k] === undefined || c.limits[k] === UNLIMITED ? null : c.limits[k]!);
      return {
        company: { id: tenant!.id, name: tenant!.name, features: c.features, nonDelegable: c.nonDelegable, superMayCreateEmployees: c.superMayCreateEmployees, employees, employeeLimit: lim('max_employees'), hrWorkspaceLimit: lim('max_hr_workspaces') },
        central: { employees: mine === null ? central : 0 },
        hrWorkspaces: await this.summaries(tx, rows),
        levels: { super: this.levelOf(s) === 'super', hrWorkspaceIds: mine ?? [] },
      };
    });
  }

  list(q: { status: 'active' | 'suspended' | 'archived' | 'all'; q?: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const mine = this.administered(s, 'hierarchy:read');
      const filter: Doc = { ...(q.status === 'all' ? {} : { status: q.status }), ...(mine === null ? {} : { id: { $in: mine } }) };
      let rows = await tx.collection('hr_workspaces').find(filter, { sort: { name: 1 } });
      if (q.q) {
        const needle = q.q.toLowerCase();
        rows = rows.filter((r) => `${r.name} ${r.code ?? ''}`.toLowerCase().includes(needle));
      }
      return { items: await this.summaries(tx, rows) };
    });
  }

  get(id: string): Promise<HrWorkspaceDetail> {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      await this.mayRead(tx, s, id);
      const w = await tx.collection('hr_workspaces').findOne({ id });
      if (!w) throw Errors.notFound('HR Workspace');
      const [summary] = await this.summaries(tx, [w]);
      const c = await this.company(tx);
      const companyEmployees = await tx.collection('employees').count({ status: { $ne: 'exited' } });
      const level = this.levelOf(s);
      return {
        ...summary!,
        departmentIds: (w.department_ids ?? []) as string[], locationIds: (w.location_ids ?? []) as string[],
        modules: this.moduleStates((w.features ?? []) as string[], c.features, c.delegable, c.nonDelegable),
        parentFeatures: c.features,
        usage: { employees: summary!.employees, limit: summary!.maxEmployees, companyEmployees, companyLimit: c.limits.max_employees === undefined || c.limits.max_employees === UNLIMITED ? null : c.limits.max_employees },
        can: {
          manage: level === 'super' && w.status !== 'archived',
          assignModules: w.status === 'active' && hasPermission(s, 'modules:assign').allowed,
          transfer: hasPermission(s, 'employees:transfer').allowed && w.status !== 'archived',
        },
      };
    });
  }

  // Super Workspace: HR Workspaces ---------------------------------------------------------------------------------------

  /**
   * A refused attempt is recorded in a transaction of its own: the request's own transaction is rolled back by the
   * refusal, and the record of the attempt must survive it.
   */
  private async recordRefusal(input: AuditInput) {
    await this.db.tenant((t) => this.audit.record(t, input)).catch(() => undefined);
  }

  /** Refuses (and records) a delegation that would give more than the parent holds. */
  private async refuseBeyondParent(tx: TenantTx, s: Subject, extra: string[], target: { type: string; id: string | null; name: string }) {
    if (!extra.length) return;
    const names = extra.map((k) => BOOLEAN_FEATURES.find((f) => f.key === k)?.name ?? k);
    await this.recordRefusal({
      action: 'delegation.denied', resourceType: target.type, resourceId: target.id,
      metadata: { level: this.levelOf(s), target: target.name, modules: extra, reason: 'exceeds_parent' },
    });
    throw Errors.forbiddenCode('exceeds_parent', `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not available to give here: the level above does not hold ${names.length === 1 ? 'it' : 'them'} or keeps ${names.length === 1 ? 'it' : 'them'} at company level.`, { modules: extra });
  }

  create(input: HrWorkspaceInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const c = await this.company(tx);
      const features = input.features.filter((k) => !CORE.has(k));
      await this.refuseBeyondParent(tx, s, features.filter((k) => !c.delegable.includes(k)), { type: 'hr_workspace', id: null, name: input.name });
      const limit = c.limits.max_hr_workspaces;
      const count = await tx.collection('hr_workspaces').count({ archived_at: null });
      if (limit !== undefined && limit !== UNLIMITED && count + 1 > limit) {
        await this.recordRefusal({ action: 'hr_workspace.limit_reached', resourceType: 'hr_workspace', metadata: { limit, count } });
        throw Errors.limitReached('HR Workspaces', limit);
      }
      await this.checkEmployeeLimit(c.limits.max_employees, input.maxEmployees);
      await this.checkUnique(tx, input.name, input.code ?? null, null);
      const admins = await this.activeMembers(tx, input.adminMembershipIds);
      const w = await tx.collection('hr_workspaces').insert({
        name: input.name, code: input.code ?? null, kind: input.kind, description: input.description, features,
        max_employees: input.maxEmployees, department_ids: input.departmentIds, location_ids: input.locationIds,
        status: 'active', version: 1, created_by_membership_id: s.membershipId,
      });
      for (const m of admins) await this.addAdmin(tx, m, w.id as string);
      await this.version(tx, s, { level: 'super', targetType: 'hr_workspace', targetId: w.id as string, version: 1, action: 'created', changes: { features: { from: [], to: features }, maxEmployees: { from: null, to: input.maxEmployees }, admins: { from: [], to: admins } } });
      await this.audit.record(tx, { action: 'hr_workspace.created', resourceType: 'hr_workspace', resourceId: w.id as string, changes: { name: input.name, kind: input.kind, features, maxEmployees: input.maxEmployees, admins: admins.length }, metadata: { level: 'super' } });
      await this.outbox.publish(tx, tx.tenantId, 'hr_workspace.created', { hrWorkspaceId: w.id, name: input.name });
      if (admins.length) {
        await this.notifications.notify(tx, { membershipIds: admins.filter((m) => m !== s.membershipId), kind: 'hr_workspace.admin_added', title: `You now run the HR Workspace ${input.name}`, link: `/hr-workspaces/${w.id}`, email: true });
        await this.notifications.signal(tx, admins, 'access.changed', { hrWorkspaceId: w.id });
      }
      return { id: w.id as string };
    });
  }

  private async checkEmployeeLimit(companyLimit: number | undefined, wanted: number) {
    if (wanted === UNLIMITED || companyLimit === undefined || companyLimit === UNLIMITED) return;
    if (wanted > companyLimit) throw Errors.badRequest('exceeds_parent', `The company may have at most ${companyLimit} employees, so an HR Workspace cannot be given more.`);
  }

  private async checkUnique(tx: TenantTx, name: string, code: string | null, id: string | null) {
    const others = await tx.collection('hr_workspaces').find({ archived_at: null, ...(id ? { id: { $ne: id } } : {}) }, { projection: { name: 1, code: 1 } });
    if (others.some((o) => (o.name as string).toLowerCase() === name.toLowerCase())) throw Errors.conflict('duplicate_name', 'There is already an HR Workspace with this name');
    if (code && others.some((o) => o.code === code)) throw Errors.conflict('duplicate_code', 'There is already an HR Workspace with this code');
  }

  private async activeMembers(tx: TenantTx, ids: string[]) {
    if (!ids.length) return [];
    const ok = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: ids }, status: { $in: ['active', 'invited'] } }));
    const missing = ids.filter((m) => !ok.has(m));
    if (missing.length) throw Errors.badRequest('unknown_member', 'Choose people who are active in the workspace');
    return ids;
  }

  /** Gives a person HR Workspace access for one more HR Workspace (one assignment holds all of theirs). */
  private async addAdmin(tx: TenantTx, membershipId: string, hrWorkspaceId: string) {
    const role = await tx.collection('roles').findOne({ key: HR_WORKSPACE_ADMIN_ROLE, is_system: true });
    if (!role) throw Errors.conflict('role_missing', 'The HR Workspace access level is missing. Run the database migration.');
    const a = await tx.collection('role_assignments').findOne({ membership_id: membershipId, role_id: role.id });
    const superRole = await tx.collection('roles').findOne({ key: 'super_workspace', is_system: true });
    if (superRole && (await tx.collection('role_assignments').exists({ membership_id: membershipId, role_id: superRole.id }))) {
      throw Errors.badRequest('already_super', 'This person has Super Workspace access, which already covers every HR Workspace.');
    }
    if (a && !((a.constraints?.hrWorkspaceIds ?? []) as string[]).length) {
      throw Errors.badRequest('already_company_hr', 'This person has HR Workspace access for the whole company, which already covers every HR Workspace. Limit it to HR Workspaces on People first.');
    }
    if (!a) {
      const s = await this.authz.subject(tx);
      await tx.collection('role_assignments').insert({ membership_id: membershipId, role_id: role.id, constraints: { hrWorkspaceIds: [hrWorkspaceId] }, source: 'hr_workspace', granted_by: s.membershipId });
    } else {
      const ids = [...new Set([...((a.constraints?.hrWorkspaceIds ?? []) as string[]), hrWorkspaceId])];
      await tx.collection('role_assignments').updateOne({ id: a.id }, { $set: { constraints: { ...(a.constraints ?? {}), hrWorkspaceIds: ids } } });
    }
  }

  private async removeAdmin(tx: TenantTx, membershipId: string, hrWorkspaceId: string) {
    const role = await tx.collection('roles').findOne({ key: HR_WORKSPACE_ADMIN_ROLE, is_system: true });
    if (!role) return;
    const a = await tx.collection('role_assignments').findOne({ membership_id: membershipId, role_id: role.id });
    // Company-wide HR Workspace access is not an HR Workspace's to take away.
    if (!a || !((a.constraints?.hrWorkspaceIds ?? []) as string[]).includes(hrWorkspaceId)) return;
    const ids = ((a.constraints?.hrWorkspaceIds ?? []) as string[]).filter((x) => x !== hrWorkspaceId);
    if (ids.length) await tx.collection('role_assignments').updateOne({ id: a.id }, { $set: { constraints: { ...(a.constraints ?? {}), hrWorkspaceIds: ids } } });
    else await tx.collection('role_assignments').delete({ id: a.id });
  }

  update(id: string, patch: HrWorkspaceUpdate) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const w = await tx.collection('hr_workspaces').findOne({ id });
      if (!w || w.status === 'archived') throw Errors.notFound('HR Workspace');
      if (patch.version !== undefined && patch.version !== (w.version ?? 1)) {
        throw Errors.conflict('version_conflict', 'Someone else changed this HR Workspace while you were editing. Reload to see their change, then try again.');
      }
      const c = await this.company(tx);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const set: Doc = {};
      const field = (key: string, col: string, value: unknown, before: unknown) => {
        if (value === undefined) return;
        if (JSON.stringify(value) === JSON.stringify(before ?? null)) return;
        changes[key] = { from: before ?? null, to: value };
        set[col] = value;
      };
      if (patch.features) {
        const features = patch.features.filter((k) => !CORE.has(k));
        const added = features.filter((k) => !((w.features ?? []) as string[]).includes(k));
        await this.refuseBeyondParent(tx, s, added.filter((k) => !c.delegable.includes(k)), { type: 'hr_workspace', id, name: w.name });
        if (!sameSet(features, (w.features ?? []) as string[])) field('features', 'features', features, w.features ?? []);
      }
      if (patch.maxEmployees !== undefined) {
        await this.checkEmployeeLimit(c.limits.max_employees, patch.maxEmployees);
        const now = await tx.collection('employees').count({ hr_workspace_id: id, status: { $ne: 'exited' } });
        if (patch.maxEmployees !== UNLIMITED && patch.maxEmployees < now) throw Errors.badRequest('below_usage', `It already has ${now} employees. Move some out first, or choose at least ${now}.`);
        field('maxEmployees', 'max_employees', patch.maxEmployees, w.max_employees);
      }
      if (patch.name !== undefined || patch.code !== undefined) await this.checkUnique(tx, patch.name ?? w.name, patch.code === undefined ? (w.code ?? null) : patch.code, id);
      field('name', 'name', patch.name, w.name);
      field('code', 'code', patch.code, w.code);
      field('kind', 'kind', patch.kind, w.kind);
      field('description', 'description', patch.description, w.description);
      field('departmentIds', 'department_ids', patch.departmentIds, w.department_ids ?? []);
      field('locationIds', 'location_ids', patch.locationIds, w.location_ids ?? []);
      if (!Object.keys(set).length) return { id, version: w.version ?? 1, changed: false };
      const version = (w.version ?? 1) + 1;
      const n = await tx.collection('hr_workspaces').update({ id, version: w.version ?? 1 }, { $set: { ...set, version } });
      if (!n) throw Errors.conflict('version_conflict', 'Someone else changed this HR Workspace at the same moment. Reload and try again.');
      await this.version(tx, s, { level: 'super', targetType: 'hr_workspace', targetId: id, version, action: 'updated', changes });
      await this.audit.record(tx, { action: 'hr_workspace.updated', resourceType: 'hr_workspace', resourceId: id, changes, metadata: { level: 'super', version } });
      if (changes.features) {
        await this.outbox.publish(tx, tx.tenantId, 'hr_workspace.modules_changed', { hrWorkspaceId: id, from: changes.features.from, to: changes.features.to });
        await this.notifications.signal(tx, await this.affected(tx, id), 'access.changed', { hrWorkspaceId: id });
      }
      return { id, version, changed: true };
    });
  }

  setStatus(id: string, status: HrWorkspaceStatus, reason: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const w = await tx.collection('hr_workspaces').findOne({ id });
      if (!w) throw Errors.notFound('HR Workspace');
      if (w.status === status) return { id, status };
      if (w.status === 'archived') throw Errors.conflict('archived', 'An archived HR Workspace cannot be opened again. Create a new one.');
      const affected = await this.affected(tx, id);
      const version = (w.version ?? 1) + 1;
      if (status === 'archived') {
        // Its people go back to the central group with a transfer record each; its admins lose it.
        const people = await tx.collection('employees').find({ hr_workspace_id: id }, { projection: { _id: 1 } });
        for (const e of people) await this.move(tx, s, e.id as string, id, null, `HR Workspace ${w.name} archived: ${reason}`);
        for (const m of (await this.adminsOf(tx, [id])).get(id) ?? []) await this.removeAdmin(tx, m, id);
      }
      await tx.collection('hr_workspaces').updateOne({ id }, { $set: { status, status_reason: reason, version, ...(status === 'archived' ? { archived_at: new Date() } : {}) } });
      await this.version(tx, s, { level: 'super', targetType: 'hr_workspace', targetId: id, version, action: `status_${status}`, changes: { status: { from: w.status, to: status } } });
      await this.audit.record(tx, { action: `hr_workspace.${status === 'active' ? 'reactivated' : status}`, resourceType: 'hr_workspace', resourceId: id, changes: { status: { from: w.status, to: status } }, metadata: { reason, level: 'super' } });
      await this.outbox.publish(tx, tx.tenantId, 'hr_workspace.status_changed', { hrWorkspaceId: id, from: w.status, to: status });
      await this.notifications.signal(tx, affected, 'access.changed', { hrWorkspaceId: id });
      return { id, status };
    });
  }

  setAdmins(id: string, membershipIds: string[]) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const w = await tx.collection('hr_workspaces').findOne({ id });
      if (!w || w.status === 'archived') throw Errors.notFound('HR Workspace');
      await this.activeMembers(tx, membershipIds);
      const before = (await this.adminsOf(tx, [id])).get(id) ?? [];
      const added = membershipIds.filter((m) => !before.includes(m));
      const removed = before.filter((m) => !membershipIds.includes(m));
      for (const m of added) await this.addAdmin(tx, m, id);
      for (const m of removed) await this.removeAdmin(tx, m, id);
      if (!added.length && !removed.length) return { admins: before };
      const version = (w.version ?? 1) + 1;
      await tx.collection('hr_workspaces').updateOne({ id }, { $set: { version } });
      await this.version(tx, s, { level: 'super', targetType: 'hr_workspace', targetId: id, version, action: 'admins_changed', changes: { admins: { from: before, to: membershipIds } } });
      await this.audit.record(tx, { action: 'hr_workspace.admins_changed', resourceType: 'hr_workspace', resourceId: id, changes: { admins: { from: before, to: membershipIds } }, metadata: { level: 'super' } });
      if (added.length) await this.notifications.notify(tx, { membershipIds: added.filter((m) => m !== s.membershipId), kind: 'hr_workspace.admin_added', title: `You now run the HR Workspace ${w.name as string}`, link: `/hr-workspaces/${id}`, email: true });
      if (removed.length) await this.notifications.notify(tx, { membershipIds: removed.filter((m) => m !== s.membershipId), kind: 'hr_workspace.admin_removed', title: `You no longer run the HR Workspace ${w.name as string}` });
      await this.notifications.signal(tx, [...added, ...removed], 'access.changed', { hrWorkspaceId: id });
      return { admins: membershipIds };
    });
  }

  // People and their modules -----------------------------------------------------------------------------------------------

  /** Employees of an HR Workspace ('central' for the company's central group) with the modules each one gets. */
  members(hrWorkspaceId: string | 'central', q: { q?: string; limit: number }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (hrWorkspaceId === 'central') {
        if (this.administered(s, 'hierarchy:read') !== null) throw Errors.forbidden();
      } else await this.mayRead(tx, s, hrWorkspaceId);
      const w = hrWorkspaceId === 'central' ? null : await tx.collection('hr_workspaces').findOne({ id: hrWorkspaceId });
      if (hrWorkspaceId !== 'central' && !w) throw Errors.notFound('HR Workspace');
      let rows = await tx.collection('employees').find({ hr_workspace_id: hrWorkspaceId === 'central' ? null : hrWorkspaceId, status: { $ne: 'exited' } }, { sort: { first_name: 1 }, limit: 2000 });
      if (q.q) {
        const needle = q.q.toLowerCase();
        rows = rows.filter((e) => `${e.preferred_name ?? e.first_name} ${e.last_name} ${e.employee_code} ${e.work_email ?? ''}`.toLowerCase().includes(needle));
      }
      rows = rows.slice(0, q.limit);
      return { items: await this.memberRows(tx, rows), hrWorkspace: w ? { id: w.id as string, name: w.name as string } : null };
    });
  }

  private async memberRows(tx: TenantTx, rows: Doc[]): Promise<HierarchyMemberRow[]> {
    const c = await this.company(tx);
    const spaces = new Map((await tx.collection('hr_workspaces').find({ id: { $in: [...new Set(rows.map((e) => e.hr_workspace_id).filter(Boolean))] } })).map((w) => [w.id as string, w]));
    const assignments = new Map((await tx.collection('member_module_assignments').find({ membership_id: { $in: rows.map((e) => e.membership_id).filter(Boolean) } })).map((a) => [a.membership_id as string, a]));
    const departments = await fieldById(tx, 'departments', rows.map((e) => e.current_department_id));
    const memberships = new Map((await tx.collection('memberships').find({ id: { $in: rows.map((e) => e.membership_id).filter(Boolean) } }, { projection: { email: 1 } })).map((m) => [m.id as string, m]));
    return rows.map((e) => {
      const w = e.hr_workspace_id ? spaces.get(e.hr_workspace_id) : undefined;
      const parent = this.parentOf(c.features, w);
      const a = e.membership_id ? assignments.get(e.membership_id) : undefined;
      const withheld = ((a?.withheld_features ?? []) as string[]).filter((k) => parent.includes(k));
      return {
        employeeId: e.id, membershipId: e.membership_id ?? null, name: `${e.preferred_name ?? e.first_name} ${e.last_name}`.trim(), code: e.employee_code,
        email: (e.work_email as string | null) ?? (e.membership_id ? (memberships.get(e.membership_id)?.email as string | undefined) ?? null : null),
        department: departments.get(e.current_department_id) ?? null, status: e.status,
        hrWorkspaceId: e.hr_workspace_id ?? null, hrWorkspaceName: w?.name ?? null,
        modules: parent.filter((k) => !withheld.includes(k)), withheld, version: (a?.version as number | undefined) ?? 0,
      };
    });
  }

  /** What a person's HR Workspace holds (core always), or the company's modules for the central group. */
  private parentOf(companyFeatures: string[], w: Doc | undefined): string[] {
    if (!w) return companyFeatures;
    const given = new Set([...((w.features ?? []) as string[]), ...CORE]);
    return companyFeatures.filter((k) => given.has(k));
  }

  /** Chooses which of their HR Workspace's modules one employee gets (HR Workspace admins or the Super Workspace). */
  setMemberModules(employeeId: string, modules: string[], version?: number) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const e = await tx.collection('employees').findOne({ id: employeeId });
      if (!e) throw Errors.notFound('Employee');
      const d = can(s, 'modules:assign', attrsOfEmployee(e));
      if (!d.allowed) {
        await this.recordRefusal({ action: 'delegation.denied', resourceType: 'employee', resourceId: employeeId, metadata: { level: this.levelOf(s), reason: d.reason } });
        throw d.reason === 'out_of_scope' ? Errors.notFound('Employee') : Errors.forbidden();
      }
      if (!e.membership_id) throw Errors.badRequest('no_login', 'This person has no SampCrew login yet, so there is nothing to give them. Invite them first.');
      const w = e.hr_workspace_id ? await tx.collection('hr_workspaces').findOne({ id: e.hr_workspace_id }) : undefined;
      if (w && w.status !== 'active') throw Errors.conflict('hr_workspace_inactive', `The HR Workspace ${w.name as string} is ${w.status as string}; its people cannot be changed now.`);
      const c = await this.company(tx);
      const parent = this.parentOf(c.features, w);
      const wanted = modules.filter((k) => !CORE.has(k));
      await this.refuseBeyondParent(tx, s, wanted.filter((k) => !parent.includes(k)), { type: 'employee', id: employeeId, name: `${e.first_name} ${e.last_name}` });
      const withheld = parent.filter((k) => !CORE.has(k) && !wanted.includes(k)).sort();
      const current = await tx.collection('member_module_assignments').findOne({ membership_id: e.membership_id });
      const before = ((current?.withheld_features ?? []) as string[]).filter((k) => parent.includes(k)).sort();
      if (version !== undefined && version !== ((current?.version as number | undefined) ?? 0)) {
        throw Errors.conflict('version_conflict', "Someone else changed this person's modules while you were editing. Reload and try again.");
      }
      if (sameSet(before, withheld)) return { modules: parent.filter((k) => !withheld.includes(k)), version: (current?.version as number | undefined) ?? 0 };
      const level = this.levelOf(s);
      const next = ((current?.version as number | undefined) ?? 0) + 1;
      if (current) await tx.collection('member_module_assignments').updateOne({ id: current.id }, { $set: { withheld_features: withheld, version: next, updated_by_level: level, updated_by_membership_id: s.membershipId } });
      else await tx.collection('member_module_assignments').insert({ membership_id: e.membership_id, withheld_features: withheld, version: next, updated_by_level: level, updated_by_membership_id: s.membershipId });
      const given = (list: string[]) => parent.filter((k) => !list.includes(k));
      const changes = { modules: { from: given(before), to: given(withheld) } };
      await this.version(tx, s, { level, targetType: 'member', targetId: employeeId, version: next, action: 'modules_changed', changes });
      await this.audit.record(tx, { action: 'employee.modules_changed', resourceType: 'employee', resourceId: employeeId, changes, metadata: { level, hrWorkspaceId: e.hr_workspace_id ?? null } });
      await this.notifications.signal(tx, [e.membership_id], 'access.changed', { employeeId });
      return { modules: given(withheld), version: next };
    });
  }

  // Transfers ------------------------------------------------------------------------------------------------------------

  /** Moves one employee (in the caller's transaction): membership changes, history and audit, nothing else is touched. */
  private async move(tx: TenantTx, s: Subject, employeeId: string, from: string | null, to: string | null, reason: string) {
    await tx.collection('employees').updateOne({ id: employeeId }, { $set: { hr_workspace_id: to } });
    await tx.collection('employee_transfers').insert({ employee_id: employeeId, from_hr_workspace_id: from, to_hr_workspace_id: to, reason, by_membership_id: s.membershipId });
    // The new HR Workspace decides what the person gets: choices made by the previous one are cleared.
    const e = await tx.collection('employees').findOne({ id: employeeId }, { projection: { membership_id: 1 } });
    if (e?.membership_id) await tx.collection('member_module_assignments').update({ membership_id: e.membership_id }, { $set: { withheld_features: [], updated_by_level: this.levelOf(s), updated_by_membership_id: s.membershipId } });
    await this.audit.record(tx, { action: 'employee.transferred', resourceType: 'employee', resourceId: employeeId, changes: { hrWorkspace: { from, to } }, metadata: { reason, level: this.levelOf(s) } });
    await this.outbox.publish(tx, tx.tenantId, 'employee.transferred', { employeeId, from, to });
    return e?.membership_id as string | undefined;
  }

  transfer(input: { employeeId: string; toHrWorkspaceId: string | null; reason: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const e = await tx.collection('employees').findOne({ id: input.employeeId });
      if (!e) throw Errors.notFound('Employee');
      if (e.status === 'exited') throw Errors.conflict('exited', 'This person has left. Their records stay where they are.');
      const from = (e.hr_workspace_id ?? null) as string | null;
      if (from === input.toHrWorkspaceId) throw Errors.badRequest('same_workspace', 'They are already there.');
      const names = new Map((await tx.collection('hr_workspaces').find({ id: { $in: [from, input.toHrWorkspaceId].filter(Boolean) } })).map((w) => [w.id as string, w]));
      const to = input.toHrWorkspaceId ? names.get(input.toHrWorkspaceId) : null;
      if (input.toHrWorkspaceId && (!to || to.status !== 'active')) throw Errors.badRequest('unknown_hr_workspace', 'Choose an active HR Workspace');
      if (to && (to.max_employees ?? UNLIMITED) !== UNLIMITED) {
        const n = await tx.collection('employees').count({ hr_workspace_id: to.id, status: { $ne: 'exited' } });
        if (n + 1 > to.max_employees) throw Errors.limitReached(`employees in ${to.name as string}`, to.max_employees);
      }
      const membershipId = await this.move(tx, s, e.id as string, from, input.toHrWorkspaceId, input.reason);
      const fromName = from ? (names.get(from)?.name as string | undefined) ?? 'an HR Workspace' : 'the central group';
      const toName = to ? (to.name as string) : 'the central group';
      const admins = await this.adminsOf(tx, [from, input.toHrWorkspaceId].filter((x): x is string => !!x));
      const told = [...new Set([...admins.values()].flat())].filter((m) => m !== s.membershipId);
      const person = `${e.preferred_name ?? e.first_name} ${e.last_name}`.trim();
      if (told.length) await this.notifications.notify(tx, { membershipIds: told, kind: 'employee.transferred', title: `${person} moved from ${fromName} to ${toName}`, link: `/employees/${e.id}` });
      if (membershipId && membershipId !== s.membershipId) await this.notifications.notify(tx, { membershipIds: [membershipId], kind: 'employee.transferred', title: `You are now looked after by ${to ? `the HR Workspace ${toName}` : 'your company\'s central HR'}` });
      await this.notifications.signal(tx, [membershipId, ...told], 'access.changed', { employeeId: e.id });
      return { employeeId: e.id as string, from, to: input.toHrWorkspaceId };
    });
  }

  /** Moves several employees into one HR Workspace (or the central group) at once, from the HR Workspace page. */
  assign(hrWorkspaceId: string | null, employeeIds: string[], reason: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const to = hrWorkspaceId ? await tx.collection('hr_workspaces').findOne({ id: hrWorkspaceId }) : null;
      if (hrWorkspaceId && (!to || to.status !== 'active')) throw Errors.badRequest('unknown_hr_workspace', 'Choose an active HR Workspace');
      const people = await tx.collection('employees').find({ id: { $in: employeeIds }, status: { $ne: 'exited' } });
      if (people.length !== employeeIds.length) throw Errors.badRequest('unknown_employee', 'Some of these people are not current employees');
      const moving = people.filter((e) => (e.hr_workspace_id ?? null) !== hrWorkspaceId);
      if (to && (to.max_employees ?? UNLIMITED) !== UNLIMITED) {
        const n = await tx.collection('employees').count({ hr_workspace_id: to.id, status: { $ne: 'exited' } });
        if (n + moving.length > to.max_employees) throw Errors.limitReached(`employees in ${to.name as string}`, to.max_employees);
      }
      const touched: (string | undefined)[] = [];
      for (const e of moving) touched.push(await this.move(tx, s, e.id as string, (e.hr_workspace_id ?? null) as string | null, hrWorkspaceId, reason));
      if (hrWorkspaceId && moving.length) {
        const admins = (await this.adminsOf(tx, [hrWorkspaceId])).get(hrWorkspaceId) ?? [];
        await this.notifications.signal(tx, [...touched, ...admins], 'access.changed', { hrWorkspaceId });
        const names = moving.slice(0, 3).map((e) => `${e.preferred_name ?? e.first_name} ${e.last_name}`.trim());
        const more = moving.length > 3 ? ` and ${moving.length - 3} more` : '';
        await this.notifications.notify(tx, { membershipIds: admins.filter((m) => m !== s.membershipId), kind: 'hr_workspace.people_joined', title: `${names.join(', ')}${more} joined ${to!.name as string}`, body: reason, link: `/hr-workspaces/${hrWorkspaceId}?tab=people` });
      }
      return { moved: moving.length };
    });
  }

  transfers(q: { employeeId?: string; hrWorkspaceId?: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (q.hrWorkspaceId) await this.mayRead(tx, s, q.hrWorkspaceId);
      else if (!q.employeeId && this.administered(s, 'hierarchy:read') !== null) throw Errors.forbidden();
      if (q.employeeId) {
        const e = await tx.collection('employees').findOne({ id: q.employeeId });
        if (!e || !can(s, 'employees:read', attrsOfEmployee(e)).allowed) throw Errors.notFound('Employee');
      }
      const filter: Doc = q.employeeId ? { employee_id: q.employeeId } : q.hrWorkspaceId ? { $or: [{ from_hr_workspace_id: q.hrWorkspaceId }, { to_hr_workspace_id: q.hrWorkspaceId }] } : {};
      const rows = await tx.collection('employee_transfers').find(filter, { sort: { created_at: -1 }, limit: 200 });
      const spaces = await fieldById(tx, 'hr_workspaces', rows.flatMap((r) => [r.from_hr_workspace_id, r.to_hr_workspace_id]));
      const people = new Map((await tx.collection('employees').find({ id: { $in: rows.map((r) => r.employee_id) } }, { projection: { first_name: 1, last_name: 1, preferred_name: 1 } })).map((e) => [e.id as string, `${e.preferred_name ?? e.first_name} ${e.last_name}`.trim()]));
      const by = await memberNames(tx, rows.map((r) => r.by_membership_id));
      return {
        items: rows.map((r): TransferRow => ({
          id: r.id, employeeId: r.employee_id, employeeName: people.get(r.employee_id) ?? null,
          fromHrWorkspaceId: r.from_hr_workspace_id ?? null, fromName: r.from_hr_workspace_id ? (spaces.get(r.from_hr_workspace_id) ?? null) : null,
          toHrWorkspaceId: r.to_hr_workspace_id ?? null, toName: r.to_hr_workspace_id ? (spaces.get(r.to_hr_workspace_id) ?? null) : null,
          reason: r.reason, byName: r.by_membership_id ? (by.get(r.by_membership_id) ?? null) : null, createdAt: iso(r.created_at),
        })),
      };
    });
  }

  /** The versioned change history of the delegation chain, newest first (one HR Workspace, or the whole company). */
  history(q: { hrWorkspaceId?: string; limit?: number }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      let filter: Doc = {};
      if (q.hrWorkspaceId) {
        await this.mayRead(tx, s, q.hrWorkspaceId);
        const people = await tx.collection('employees').distinct<string>('id', { hr_workspace_id: q.hrWorkspaceId });
        filter = { $or: [{ target_type: 'hr_workspace', target_id: q.hrWorkspaceId }, { target_type: 'member', target_id: { $in: people } }] };
      } else if (this.administered(s, 'hierarchy:read') !== null) throw Errors.forbidden();
      const rows = await tx.collection('config_versions').find(filter, { sort: { created_at: -1 }, limit: Math.min(q.limit ?? 100, 500) });
      const spaces = await fieldById(tx, 'hr_workspaces', rows.filter((r) => r.target_type === 'hr_workspace').map((r) => r.target_id));
      const people = new Map((await tx.collection('employees').find({ id: { $in: rows.filter((r) => r.target_type === 'member').map((r) => r.target_id) } }, { projection: { first_name: 1, last_name: 1 } })).map((e) => [e.id as string, `${e.first_name} ${e.last_name}`.trim()]));
      const tenant = await tx.collection('tenants').findOne({});
      const by = await memberNames(tx, rows.map((r) => r.actor_membership_id));
      return {
        items: rows.map((r): ConfigVersionRow => ({
          id: r.id, version: r.version, level: r.level, targetType: r.target_type, targetId: r.target_id,
          targetName: r.target_type === 'company' ? (tenant?.name as string) : r.target_type === 'hr_workspace' ? (spaces.get(r.target_id) ?? null) : (people.get(r.target_id) ?? null),
          action: r.action, changes: r.changes ?? {}, actorName: r.actor_membership_id ? (by.get(r.actor_membership_id) ?? null) : ((r.actor_label as string | null) ?? null), createdAt: iso(r.created_at),
        })),
      };
    });
  }

  // Recalculation --------------------------------------------------------------------------------------------------------

  /**
   * After the company lost modules (a Console switch, a plan change, the Console keeping a module at company level):
   * removes them from every HR Workspace that was given them, with a version and an audit entry each, and tells
   * everyone affected to reload. Entitlements already ignore them (they are worked out per request); this keeps the
   * stored delegation equal to what is real, so nothing comes back by itself if the company gets the module again.
   */
  /**
   * Runs after a level above changes what the company holds (Console module switches, plan or subscription changes,
   * the delegation policy). Stored choices are never rewritten, so a module switched off and on again comes back as
   * it was; what is no longer held above simply stops working at once (the entitlement check intersects every level
   * on each request), is shown as inactive on the screens, and is recorded here. Everyone's screens refresh.
   */
  async recalculate(tx: TenantTx, source: { level: PlatformLevel; label: string }): Promise<{ hrWorkspaces: number; inactive: Record<string, string[]> }> {
    const c = await this.company(tx);
    const spaces = await tx.collection('hr_workspaces').find({ status: { $ne: 'archived' } });
    const inactive: Record<string, string[]> = {};
    for (const w of spaces) {
      const off = ((w.features ?? []) as string[]).filter((k) => !c.delegable.includes(k));
      if (off.length) inactive[w.id as string] = off;
    }
    await this.audit.record(tx, {
      tenantId: tx.tenantId, action: 'hierarchy.recalculated', resourceType: 'tenant', resourceId: tx.tenantId,
      changes: { companyModules: c.features, nonDelegable: c.nonDelegable, inactive },
      metadata: { level: source.level, by: source.label }, actorLabel: source.label,
    });
    const everyone = await tx.collection('memberships').distinct<string>('id', { status: 'active' });
    await this.notifications.signal(tx, everyone, 'access.changed', {});
    return { hrWorkspaces: Object.keys(inactive).length, inactive };
  }
}
