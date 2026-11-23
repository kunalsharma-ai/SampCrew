import { Injectable } from '@nestjs/common';
import { ADMIN_ONLY_FEATURES, FEATURE_PARTS, FEATURES, featurePart, type FeaturePart, moduleOfFeature, UNLIMITED, type FeatureBlockReason, type FeatureDefinition } from '@crew/contracts';
import { requestContext } from '../context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../database/mongo.service';
import { Errors } from '../http/errors';

export interface Entitlements {
  planKey: string | null;
  status: string | null;
  features: Set<string>;
  limits: Record<string, number>;
  trialEndsOn: string | null;
  /** Modules the plan includes but SAMPLEDGE switched off, for the workspace or for this member only. */
  blocked: Record<string, Exclude<FeatureBlockReason, 'not_in_plan'>>;
  /** Limits the plan lets the workspace go beyond (billed as overage at the period end) instead of stopping. */
  overage: Set<string>;
  /** Unpaid past the grace period: the workspace is read-only until it pays. */
  locked: boolean;
}

const KEY = Symbol('entitlements');
/** Levels that work for the whole company (not inside one HR Workspace): Super Workspace, and HR Workspace when not limited to HR Workspaces. */
export const COMPANY_ADMIN_ROLES = new Set(['super_workspace', 'hr_workspace']);
const CORE = new Set<string>(FEATURES.filter((f) => 'core' in f && f.core).map((f) => f.key));

/** Resolves which features and limits the current tenant's subscription grants. */
@Injectable()
export class EntitlementsService {
  constructor(private readonly db: DatabaseService) {}

  async current(tx?: TenantTx): Promise<Entitlements> {
    const ctx = requestContext.get() as Record<symbol, Entitlements> | undefined;
    if (ctx?.[KEY]) return ctx[KEY];
    // Per-member module access applies to people signed in to the workspace (and API keys acting as them).
    const actor = requestContext.get()?.actor;
    const membershipId = actor?.kind === 'user' ? actor.membershipId : undefined;
    // Modules switched off in one app apply to sessions opened in that app; API keys carry no app.
    const client = actor?.kind === 'user' && !actor.apiKey && (actor.client === 'web' || actor.client === 'mobile') ? actor.client : undefined;
    const load = (t: TenantTx) => loadEntitlements(t, membershipId, client);
    const e = tx ? await load(tx) : await this.db.tenant(load);
    if (ctx) ctx[KEY] = e;
    return e;
  }

  async requireFeature(feature: string, tx?: TenantTx): Promise<void> {
    const e = await this.current(tx);
    if (!e.features.has(feature)) {
      const part = featurePart(feature);
      // A page whose module is unavailable answers with the module's reason; a button, with its page's.
      if (part && !e.features.has(part.feature)) return this.requireFeature(part.feature, tx);
      if (part?.page && !e.features.has(part.page)) return this.requireFeature(part.page, tx);
      const name = part?.name ?? FEATURES.find((f) => f.key === feature)?.name ?? feature;
      const reason = e.blocked[feature];
      if (reason === 'platform_off') throw Errors.featureOffByPlatform(name);
      if (reason === 'level_off') throw Errors.featureOffForLevel(name);
      if (reason === 'hr_level_off') throw Errors.featureOffForEmployees(name);
      if (reason === 'workspace_off') throw Errors.featureSwitchedOff(name);
      if (reason === 'admin_off') throw Errors.featureSwitchedOffByAdmin(name);
      if (reason === 'member_blocked') throw Errors.featureNotForMember(name);
      if (reason === 'hr_workspace_off') throw Errors.featureNotForHrWorkspace(name);
      if (reason === 'hr_member_off') throw Errors.featureNotForMember(name);
      if (reason === 'channel_off') throw Errors.featureOffInApp(name, (requestContext.get()?.actor as { client?: string } | undefined)?.client ?? 'web');
      throw Errors.featureNotInPlan(name);
    }
  }

  /** Throws when adding `adding` more units would exceed the plan limit. */
  async requireWithinLimit(limit: string, currentCount: number, tx?: TenantTx, adding = 1) {
    const e = await this.current(tx);
    const max = e.limits[limit];
    if (max === undefined || max === UNLIMITED || e.overage.has(limit)) return;
    if (currentCount + adding > max) throw Errors.limitReached((FEATURES as readonly FeatureDefinition[]).find((f) => f.key === limit)?.unit ?? limit, max);
  }
}

/**
 * Subscriptions that are cancelled or suspended keep only the read-only baseline; trialing/active/past_due keep the plan.
 * With a membership, the modules SAMPLEDGE took away from that member are removed as well.
 */
export async function loadEntitlements(tx: TenantTx, membershipId?: string, client?: 'web' | 'mobile'): Promise<Entitlements> {
  const sub = await tx.collection('subscriptions').findOne({});
  const plan = sub ? await tx.collection('plans').findOne({ id: sub.plan_id }) : undefined;
  if (!sub || !plan || sub.status === 'cancelled' || sub.status === 'suspended') {
    return { planKey: plan?.key ?? null, status: sub?.status ?? null, features: new Set(), limits: {}, trialEndsOn: null, blocked: {}, overage: new Set(), locked: Boolean(sub?.locked_at) };
  }
  const planFeatures = await tx.collection('plan_features').find({ plan_id: sub.plan_id });
  const kinds = new Map((await tx.collection('features').find({ key: { $in: planFeatures.map((r) => r.feature_key) } })).map((f) => [f.key as string, f.kind as string]));
  const rows = planFeatures.filter((r) => kinds.has(r.feature_key)).map((r) => ({ feature_key: r.feature_key as string, limit_value: (r.limit_value ?? null) as number | null, kind: kinds.get(r.feature_key)! }));
  const features = new Set<string>();
  const limits: Record<string, number> = {};
  for (const r of rows) {
    if (r.kind === 'boolean') features.add(r.feature_key);
    else if (r.limit_value !== null) limits[r.feature_key] = r.limit_value;
  }
  // A trial can be limited to some of the plan's modules.
  const trialOnly = sub.status === 'trialing' && Array.isArray(plan.trial_features) && plan.trial_features.length ? new Set<string>(plan.trial_features as string[]) : null;
  if (trialOnly) for (const k of [...features]) if (!CORE.has(k) && !trialOnly.has(k)) features.delete(k);
  // Add-ons bought on top of the plan: a module, or more of a limit.
  const addons = await tx.collection('subscription_addons').find({ status: 'active' });
  if (addons.length) {
    const defs = new Map((await tx.collection('addons').find({ id: { $in: addons.map((a) => a.addon_id) } })).map((a) => [a.id as string, a]));
    for (const a of addons) {
      const d = defs.get(a.addon_id);
      if (!d) continue;
      if (d.kind === 'module') features.add(d.feature_key);
      else if (limits[d.feature_key] !== UNLIMITED) limits[d.feature_key] = (limits[d.feature_key] ?? 0) + d.unit_quantity * a.quantity;
    }
  }
  // Modules agreed in a contract with this workspace, until the contract ends.
  const deal = sub.deal as { features?: string[]; endsOn?: string | null } | null | undefined;
  if (deal?.features?.length && (!deal.endsOn || deal.endsOn >= new Date().toISOString().slice(0, 10))) for (const k of deal.features) features.add(k);
  const overage = new Set(Object.entries((plan.overage ?? {}) as Record<string, { policy?: string }>).filter(([, v]) => v?.policy === 'overage').map(([k]) => k));
  const blocked: Entitlements['blocked'] = {};
  // Platform-granted overrides: a negotiated add-on or pilot (true), or a module SAMPLEDGE switched off (false).
  for (const [key, value] of Object.entries(sub.feature_overrides ?? {})) {
    if (typeof value === 'boolean') {
      if (value) features.add(key);
      else if (!CORE.has(key)) {
        if (features.delete(key)) blocked[key] = 'workspace_off';
      }
    } else if (typeof value === 'number') limits[key] = value;
  }
  // Pages and buttons (FEATURE_PARTS) come with their module; each level below can still switch one off.
  for (const p of FEATURE_PARTS) if (features.has(p.feature)) features.add(p.key);
  // A page or button SAMPLEDGE switched off for this company only (Console > Workspace > Features & permissions).
  for (const [key, value] of Object.entries(sub.feature_overrides ?? {})) {
    if (value === false && featurePart(key) && features.delete(key)) blocked[key] = 'workspace_off';
  }
  // Console > Feature management: switched off, or not yet released, for the whole application. Beats every plan,
  // add-on, deal and per-company override; the records stay.
  const released = await tx.collection('platform_feature_states').find({ state: { $in: ['off', 'pending'] } }, { projection: { key: 1 } });
  for (const r of released) {
    const key = r.key as string;
    if (!CORE.has(key) && features.delete(key)) blocked[key] = 'platform_off';
  }
  // Modules the workspace's own administrators switched off in HR Workspace Admin (within what the plan includes).
  const own = await tx.collection('workspace_modules').findOne({ key: 'workspace' });
  for (const key of (own?.disabled_features ?? []) as string[]) {
    if (!CORE.has(key) && features.delete(key)) blocked[key] = 'admin_off';
  }
  if (membershipId) await applyHierarchy(tx, membershipId, features, blocked, own);
  if (membershipId) {
    const member = await tx.collection('member_feature_access').findOne({ membership_id: membershipId });
    for (const key of member?.blocked_features ?? []) {
      if (!CORE.has(key) && features.delete(key)) blocked[key] = 'member_blocked';
    }
  }
  if (client) {
    const controls = await tx.collection('tenant_access_controls').findOne({});
    for (const key of ((client === 'mobile' ? controls?.mobile_off_features : controls?.web_off_features) ?? []) as string[]) {
      if (!CORE.has(key) && features.delete(key)) blocked[key] = 'channel_off';
    }
  }
  // A part never outlives its module, a button never outlives its page, and each says why. (Pages come before the
  // buttons in FEATURE_PARTS, so a page is settled before the buttons on it.)
  for (const p of FEATURE_PARTS as readonly FeaturePart[]) {
    const parent = !features.has(p.feature) ? p.feature : p.page && !features.has(p.page) ? p.page : null;
    if (!parent) continue;
    features.delete(p.key);
    if (!blocked[p.key] && blocked[parent]) blocked[p.key] = 'module_off';
  }
  return { planKey: plan.key, status: sub.status, features, limits, trialEndsOn: sub.trial_ends_on ?? null, blocked, overage, locked: Boolean(sub.locked_at) };
}

/** The level a person works at, from their access levels: the highest one counts. */
export type WorkLevel = 'super' | 'hr' | 'employee';

/**
 * The Super > HR > Employee part of the chain, applied after the company's own modules are known:
 *  - a person in an HR Workspace (as its admin, or as one of its employees) gets only the modules the Super Workspace
 *    gave that HR Workspace (for an admin of several, any of them);
 *  - then the modules their HR Workspace admins (or the Super Workspace) withheld from them are removed.
 * Super Workspace and company-wide HR Workspace people are not limited by an HR Workspace: they work for the whole company.
 * Computed on every request, so a change at any level applies at once, also to sessions that are already open.
 */
export async function applyHierarchy(tx: TenantTx, membershipId: string, features: Set<string>, blocked: Entitlements['blocked'], company?: Record<string, unknown> | null): Promise<void> {
  const held = await tx.collection('role_assignments').find({ membership_id: membershipId });
  const keyOf = new Map(
    (await tx.collection('roles').find({ id: { $in: held.map((a) => a.role_id) }, is_system: true, key: { $in: ['super_workspace', 'hr_workspace', 'employee_workspace'] } }, { projection: { key: 1 } })).map((r) => [r.id as string, r.key as string]),
  );
  // Only the access levels count (old roles kept for rollback give nothing).
  const assignments = held.filter((a) => keyOf.has(a.role_id as string));
  const level: WorkLevel = assignments.some((a) => keyOf.get(a.role_id) === 'super_workspace') ? 'super' : assignments.some((a) => keyOf.get(a.role_id) === 'hr_workspace') ? 'hr' : 'employee';
  const own = company === undefined ? await tx.collection('workspace_modules').findOne({ key: 'workspace' }) : company;
  const drop = (keys: unknown, reason: Entitlements['blocked'][string]) => {
    for (const key of (keys ?? []) as string[]) if (!CORE.has(key) && features.delete(key)) blocked[key] = reason;
  };
  // Feature management by level: the Super Workspace's switches for the HR Workspace and Employee Workspace levels,
  // and for Employee Workspace also what company-wide HR switched off for the central group.
  if (level === 'hr') drop(own?.hr_level_off, 'level_off');
  let employeeLevel = false;
  if (level === 'employee') {
    drop(own?.employee_level_off, 'level_off');
    // Administrator-only modules (data import) never reach Employee Workspace, whatever is switched where.
    drop([...features].filter((k) => ADMIN_ONLY_FEATURES.has(moduleOfFeature(k))), 'level_off');
    employeeLevel = true;
  }
  // Company-wide: Super Workspace, and HR Workspace not limited to HR Workspaces.
  if (assignments.some((a) => COMPANY_ADMIN_ROLES.has(keyOf.get(a.role_id) ?? '') && !((a.constraints?.hrWorkspaceIds ?? []) as string[]).length)) return;
  const administered = [...new Set(assignments.flatMap((a) => ((a.constraints?.hrWorkspaceIds ?? []) as string[])))];
  const employee = await tx.collection('employees').findOne({ membership_id: membershipId }, { projection: { hr_workspace_id: 1 } });
  const ids = administered.length ? administered : employee?.hr_workspace_id ? [employee.hr_workspace_id as string] : [];
  // Employee Workspace people of the central group: what company-wide HR switched off for them.
  if (employeeLevel && !ids.length) drop(own?.employee_level_off_by_hr, 'hr_level_off');
  if (ids.length) {
    const spaces = await tx.collection('hr_workspaces').find({ id: { $in: ids }, status: { $in: ['active', 'suspended'] } }, { projection: { features: 1, employee_off_features: 1 } });
    // The Console may keep some of the company's modules at company level: they never reach an HR Workspace.
    const controls = await tx.collection('tenant_access_controls').findOne({}, { projection: { non_delegable_features: 1 } });
    const kept = new Set((controls?.non_delegable_features ?? []) as string[]);
    const given = new Set(spaces.flatMap((w) => (w.features ?? []) as string[]).filter((k) => !kept.has(k)));
    for (const key of [...features]) {
      const module = moduleOfFeature(key);
      if (!CORE.has(module) && !given.has(module)) {
        features.delete(key);
        blocked[key] = 'hr_workspace_off';
      }
    }
    // Employee Workspace people of an HR Workspace: what its admins switched off for Employee Workspace.
    if (employeeLevel) for (const w of spaces) drop(w.employee_off_features, 'hr_level_off');
  }
  const mine = await tx.collection('member_module_assignments').findOne({ membership_id: membershipId }, { projection: { withheld_features: 1 } });
  for (const key of (mine?.withheld_features ?? []) as string[]) {
    if (!CORE.has(key) && features.delete(key)) blocked[key] = 'hr_member_off';
  }
}
