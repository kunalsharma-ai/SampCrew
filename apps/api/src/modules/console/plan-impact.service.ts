import { Injectable } from '@nestjs/common';
import { billingMath as bm, FEATURES, isCoreFeature, UNLIMITED, workspaceLimitKindOf, type PlanEntitlementsUpdate, type PlanImpact, type PlanLifecycle } from '@crew/contracts';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { BillingEngine } from '../billing/billing-engine.service';
import { countWorkspaces } from '../workspace-limits/workspace-limits.service';
import { loadTenantStats } from './portfolio';

const LIVE = ['trialing', 'active', 'past_due'];
const LABEL = new Map<string, string>(FEATURES.map((f) => [f.key, f.name]));

/**
 * What a plan touches: its subscribers, their MRR and revenue, and its billing records (which block deleting it).
 * With a proposed change of modules and limits, it also says which modules the subscribers would lose and which
 * companies are already above a lowered limit, so the Console can show the impact before anything is saved.
 */
@Injectable()
export class PlanImpactService {
  constructor(private readonly db: DatabaseService, private readonly engine: BillingEngine) {}

  impact(key: string, proposed?: PlanEntitlementsUpdate): Promise<PlanImpact> {
    const money = requestContext.platformActor().permissions.includes('billing:read');
    return this.db.platform(async (tx) => {
      const plan = await tx.collection<{ id: string; key: string; name: string; archived_at: Date | null; retired_at: Date | null; is_public: boolean }>('plans').findOne({ key });
      if (!plan) throw Errors.notFound('Plan');
      const subs = await tx.collection<{ tenant_id: string; status: string; seats: number }>('subscriptions').find({ plan_id: plan.id }, { projection: { tenant_id: 1, status: 1, seats: 1 } });
      const stats = await loadTenantStats(tx, this.engine, { tenantIds: subs.map((s) => s.tenant_id) });
      const live = stats.filter((t) => t.sub && LIVE.includes(t.sub.status));
      const mrr: Record<string, string> = {};
      const revenue: Record<string, string> = {};
      if (money) {
        for (const t of live) if (t.sub) mrr[t.sub.currency] = bm.sum([mrr[t.sub.currency] ?? '0', t.mrr]);
        for (const t of stats) for (const [c, v] of Object.entries(t.revenue)) revenue[c] = bm.sum([revenue[c] ?? '0', v]);
      }
      const tenantIds = subs.map((s) => s.tenant_id);
      const invoices = tenantIds.length ? await tx.collection('invoices').count({ tenant_id: { $in: tenantIds } }) : 0;
      const billingEvents = await tx.collection('billing_events').count({ $or: [{ plan_key: key }, { from_plan_key: key }] });
      const blocked: string[] = [];
      if (['starter', 'professional', 'business', 'enterprise'].includes(key)) blocked.push('It is one of the four launch plans');
      if (subs.length) blocked.push(`${subs.length} workspace(s) have a subscription on it`);
      if (billingEvents) blocked.push(`${billingEvents} billing record(s) mention it`);

      const removed: PlanImpact['removed'] = [];
      const lowered: PlanImpact['lowered'] = [];
      if (proposed) {
        const current = await tx.collection<{ feature_key: string; limit_value: number | null }>('plan_features').find({ plan_id: plan.id });
        const kinds = new Map((await tx.collection<{ key: string; kind: string }>('features').find()).map((f) => [f.key, f.kind]));
        const next = new Set(proposed.features);
        for (const f of current) {
          if (kinds.get(f.feature_key) === 'boolean' && !isCoreFeature(f.feature_key) && !next.has(f.feature_key)) {
            removed.push({ feature: f.feature_key, label: LABEL.get(f.feature_key) ?? f.feature_key, workspaces: live.length });
          }
        }
        for (const [limit, to] of Object.entries(proposed.limits)) {
          if (to === undefined) continue;
          const from = current.find((c) => c.feature_key === limit)?.limit_value ?? null;
          if (from === null || to === from) continue;
          const lower = from === UNLIMITED ? to !== UNLIMITED : to !== UNLIMITED && to < from;
          if (!lower) continue;
          const kind = workspaceLimitKindOf(limit);
          let over: number | null = null;
          if (kind) {
            over = 0;
            for (const t of live) if ((await countWorkspaces(tx, t.id, kind)) > to) over++;
          } else if (limit === 'max_employees') {
            over = live.filter((t) => t.employees > to).length;
          }
          lowered.push({ limit, label: LABEL.get(limit) ?? limit, from, to, overLimit: over });
        }
      }
      const lifecycle: PlanLifecycle = plan.retired_at ? 'retired' : plan.archived_at ? 'archived' : !plan.is_public && !subs.length ? 'draft' : 'active';
      return {
        key, name: plan.name, lifecycle,
        subscribers: {
          total: subs.length, active: subs.filter((s) => s.status === 'active').length, trialing: subs.filter((s) => s.status === 'trialing').length,
          pastDue: subs.filter((s) => s.status === 'past_due').length, cancelled: subs.filter((s) => s.status === 'cancelled').length,
        },
        companies: stats.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200).map((t) => ({ clientId: t.companyId, tenantId: t.id, name: t.name, status: t.sub?.status ?? 'none', seats: t.sub?.seats ?? 0 })),
        mrr, revenue, invoices, billingEvents, canDelete: !blocked.length, deleteBlockedBy: blocked, removed, lowered,
      };
    });
  }
}
