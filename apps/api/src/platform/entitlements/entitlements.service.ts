import { Injectable } from '@nestjs/common';
import { FEATURES, UNLIMITED, type FeatureBlockReason, type FeatureDefinition } from '@crew/contracts';
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
}

const KEY = Symbol('entitlements');
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

  async requireFeature(feature: string, tx?: TenantTx) {
    const e = await this.current(tx);
    if (!e.features.has(feature)) {
      const name = FEATURES.find((f) => f.key === feature)?.name ?? feature;
      const reason = e.blocked[feature];
      if (reason === 'workspace_off') throw Errors.featureSwitchedOff(name);
      if (reason === 'member_blocked') throw Errors.featureNotForMember(name);
      if (reason === 'channel_off') throw Errors.featureOffInApp(name, (requestContext.get()?.actor as { client?: string } | undefined)?.client ?? 'web');
      throw Errors.featureNotInPlan(name);
    }
  }

  /** Throws when adding `adding` more units would exceed the plan limit. */
  async requireWithinLimit(limit: string, currentCount: number, tx?: TenantTx, adding = 1) {
    const e = await this.current(tx);
    const max = e.limits[limit];
    if (max === undefined || max === UNLIMITED) return;
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
    return { planKey: plan?.key ?? null, status: sub?.status ?? null, features: new Set(), limits: {}, trialEndsOn: null, blocked: {} };
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
  return { planKey: plan.key, status: sub.status, features, limits, trialEndsOn: sub.trial_ends_on ?? null, blocked };
}
