import { Injectable } from '@nestjs/common';
import {
  BOOLEAN_FEATURES,
  FEATURE_PARTS,
  isCoreFeature,
  isPlannedFeature,
  moduleOfFeature,
  type PlatformFeatureRow,
  type PlatformFeatureState,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx as Tx } from '../../platform/database/mongo.service';

/**
 * Console > Feature management: every module and every page or sub-area of the application, with its state for the
 * whole application. Off (or pending, for a feature not yet released) takes it away from every company and every
 * level below at once, whatever the plan says; the companies' records stay. Each change is in the platform audit log.
 */
@Injectable()
export class PlatformFeaturesService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  list() {
    return this.db.platform((tx) => this.rows(tx));
  }

  async set(input: { changes: { key: string; state: 'active' | 'off' }[]; reason?: string }) {
    return this.db.platform(async (tx) => {
      const by = requestContext.platformActor();
      const admin = await tx.collection('platform_admins').findOne({ id: by.adminId }, { projection: { email: 1 } });
      const before = new Map((await tx.collection('platform_feature_states').find({ key: { $in: input.changes.map((c) => c.key) } })).map((r) => [r.key as string, r.state as PlatformFeatureState]));
      const diff: { key: string; from: PlatformFeatureState; to: PlatformFeatureState }[] = [];
      for (const c of input.changes) {
        const from = before.get(c.key) ?? 'active';
        if (from === c.state) continue;
        const fields = { state: c.state, reason: input.reason ?? null, updated_by: (admin?.email as string | undefined) ?? by.adminId };
        await tx.collection('platform_feature_states').upsert({ key: c.key }, { key: c.key, ...fields }, { $set: fields });
        diff.push({ key: c.key, from, to: c.state });
      }
      if (diff.length) {
        await this.audit.record(tx, { tenantId: null, action: 'platform.features_switched', resourceType: 'feature', resourceId: null, changes: { features: diff }, metadata: input.reason ? { reason: input.reason } : undefined });
      }
      return this.rows(tx);
    });
  }

  private async rows(tx: Tx): Promise<{ items: PlatformFeatureRow[]; counts: Record<PlatformFeatureState, number> }> {
    const states = new Map((await tx.collection('platform_feature_states').find({})).map((r) => [r.key as string, r]));
    // Companies whose plan includes each module (active, trialing or past due subscriptions).
    const subs = await tx.collection('subscriptions').find({ status: { $in: ['trialing', 'active', 'past_due'] } }, { projection: { plan_id: 1 } });
    const perPlan = new Map<string, number>();
    for (const s of subs) perPlan.set(s.plan_id as string, (perPlan.get(s.plan_id as string) ?? 0) + 1);
    const companies = new Map<string, number>();
    for (const pf of await tx.collection('plan_features').find({ plan_id: { $in: [...perPlan.keys()] } }, { projection: { plan_id: 1, feature_key: 1 } })) {
      companies.set(pf.feature_key as string, (companies.get(pf.feature_key as string) ?? 0) + (perPlan.get(pf.plan_id as string) ?? 0));
    }
    const row = (key: string, name: string, module: string, parent: string | null, audience: PlatformFeatureRow['audience'], core: boolean): PlatformFeatureRow => {
      const s = states.get(key);
      return {
        key, name, module, parent, audience, core,
        state: core ? 'active' : ((s?.state as PlatformFeatureState | undefined) ?? 'active'),
        companies: companies.get(moduleOfFeature(key)) ?? 0,
        updatedAt: s?.updated_at ? new Date(s.updated_at as Date).toISOString() : null,
        updatedBy: (s?.updated_by as string | undefined) ?? null,
      };
    };
    const items: PlatformFeatureRow[] = [];
    for (const f of BOOLEAN_FEATURES.filter((x) => !isPlannedFeature(x.key))) {
      items.push(row(f.key, f.name, f.module, null, null, isCoreFeature(f.key)));
      for (const p of FEATURE_PARTS.filter((x) => x.feature === f.key)) items.push(row(p.key, p.name, f.module, f.key, p.audience, false));
    }
    const counts = { active: 0, off: 0, pending: 0 } as Record<PlatformFeatureState, number>;
    for (const i of items) counts[i.state]++;
    return { items, counts };
  }
}
