import { Injectable } from '@nestjs/common';
import { FEATURES, UNLIMITED, type FeatureBlockReason, type FeatureDefinition } from '@crew/contracts';
import { requestContext } from '../context/request-context';
import { DatabaseService, many, one, type Tx } from '../database/database.service';
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

  async current(tx?: Tx): Promise<Entitlements> {
    const ctx = requestContext.get() as Record<symbol, Entitlements> | undefined;
    if (ctx?.[KEY]) return ctx[KEY];
    // Per-member module access applies to people signed in to the workspace (and API keys acting as them).
    const actor = requestContext.get()?.actor;
    const membershipId = actor?.kind === 'user' ? actor.membershipId : undefined;
    const load = (t: Tx) => loadEntitlements(t, membershipId);
    const e = tx ? await load(tx) : await this.db.tenant(load);
    if (ctx) ctx[KEY] = e;
    return e;
  }

  async requireFeature(feature: string, tx?: Tx) {
    const e = await this.current(tx);
    if (!e.features.has(feature)) {
      const name = FEATURES.find((f) => f.key === feature)?.name ?? feature;
      const reason = e.blocked[feature];
      if (reason === 'workspace_off') throw Errors.featureSwitchedOff(name);
      if (reason === 'member_blocked') throw Errors.featureNotForMember(name);
      throw Errors.featureNotInPlan(name);
    }
  }

  /** Throws when adding `adding` more units would exceed the plan limit. */
  async requireWithinLimit(limit: string, currentCount: number, tx?: Tx, adding = 1) {
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
export async function loadEntitlements(tx: Tx, membershipId?: string): Promise<Entitlements> {
  const sub = await one<{ plan_id: string; plan_key: string; status: string; trial_ends_on: string | null; feature_overrides: Record<string, boolean | number> }>(
    tx,
    `select s.plan_id, p.key as plan_key, s.status, to_char(s.trial_ends_on, 'YYYY-MM-DD') as trial_ends_on, s.feature_overrides
       from subscriptions s join plans p on p.id = s.plan_id`,
  );
  if (!sub || sub.status === 'cancelled' || sub.status === 'suspended') {
    return { planKey: sub?.plan_key ?? null, status: sub?.status ?? null, features: new Set(), limits: {}, trialEndsOn: null, blocked: {} };
  }
  const rows = await many<{ feature_key: string; limit_value: number | null; kind: string }>(
    tx,
    `select pf.feature_key, pf.limit_value, f.kind from plan_features pf join features f on f.key = pf.feature_key where pf.plan_id = $1`,
    [sub.plan_id],
  );
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
    const member = await one<{ blocked_features: string[] }>(tx, 'select blocked_features from member_feature_access where membership_id = $1', [membershipId]);
    for (const key of member?.blocked_features ?? []) {
      if (!CORE.has(key) && features.delete(key)) blocked[key] = 'member_blocked';
    }
  }
  return { planKey: sub.plan_key, status: sub.status, features, limits, trialEndsOn: sub.trial_ends_on, blocked };
}
