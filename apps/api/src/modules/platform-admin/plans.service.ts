import { Injectable } from '@nestjs/common';
import { FEATURES, isCoreFeature, LIMIT_KEYS, type PlanCreate, type PlanEntitlementsUpdate, type PlanUpdate } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx as Tx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';

const BOOLEAN_KEYS = new Set<string>(FEATURES.filter((f) => f.kind === 'boolean').map((f) => f.key));
const CORE_KEYS = FEATURES.filter((f) => isCoreFeature(f.key)).map((f) => f.key as string);

const LIVE = ['trialing', 'active', 'past_due'];
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface PlanRow { id: string; key: string; name: string; quote_only: boolean; is_public: boolean; archived_at: Date | null }

/**
 * The plan builder. SAMPLEDGE decides here which modules and limits each plan includes; a workspace's
 * subscription then decides what it can use (EntitlementsService reads plan_features on every request, so a
 * change applies to every workspace on the plan straight away). Workspace-specific switches and limits in the
 * Console still sit on top of the plan.
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  list() {
    return this.db.platform(async (tx) => {
      const rows = await tx.collection<PlanRow & { tagline: string | null; minimum_seats: number; sort_order: number; customised_at: Date | null; customised_by_admin_id: string | null; trial_days: number | null; trial_features: string[] | null; overage: Record<string, { policy: string; prices: Record<string, string> }> | null }>('plans').find();
      const admins = new Map((await tx.collection<{ id: string; full_name: string }>('platform_admins').find({ id: { $in: rows.map((r) => r.customised_by_admin_id).filter(Boolean) } })).map((a) => [a.id, a.full_name]));
      const plans = rows
        .sort((a, b) => Number(!!a.archived_at) - Number(!!b.archived_at) || a.sort_order - b.sort_order || cmp(a.name, b.name))
        .map((p) => ({
          id: p.id, key: p.key, name: p.name, tagline: p.tagline ?? '', quoteOnly: p.quote_only, minimumSeats: p.minimum_seats, isPublic: p.is_public,
          sortOrder: p.sort_order, customisedAt: p.customised_at ?? null, customisedBy: (p.customised_by_admin_id && admins.get(p.customised_by_admin_id)) ?? null, archivedAt: p.archived_at ?? null,
          trialDays: p.trial_days ?? 0, trialFeatures: p.trial_features ?? [], overage: p.overage ?? {},
        }));
      const prices = (await tx.collection<{ plan_id: string; currency: string; monthly_per_seat: string; annual_per_seat_month: string }>('plan_prices').find({}, { sort: { currency: 1 } }))
        .map((x) => ({ plan_id: x.plan_id, currency: x.currency, monthly: x.monthly_per_seat, annualPerMonth: x.annual_per_seat_month }));
      const features = (await tx.collection<{ plan_id: string; feature_key: string; limit_value: number | null }>('plan_features').find({}, { sort: { feature_key: 1 } }))
        .map((x) => ({ plan_id: x.plan_id, key: x.feature_key, limitValue: x.limit_value ?? null }));
      const subs = await tx.collection<{ plan_id: string; status: string }>('subscriptions').find({}, { projection: { plan_id: 1, status: 1 } });
      const counts = [...new Set(subs.map((x) => x.plan_id))].map((plan_id) => ({
        plan_id,
        n: subs.filter((x) => x.plan_id === plan_id).length,
        active: subs.filter((x) => x.plan_id === plan_id && LIVE.includes(x.status)).length,
      }));
      const pending = await tx.collection<{ plan_id: string }>('plan_requests').find({ status: 'pending' }, { projection: { plan_id: 1 } });
      const requests = [...new Set(pending.map((x) => x.plan_id))].map((plan_id) => ({ plan_id, n: pending.filter((x) => x.plan_id === plan_id).length }));
      return plans.map((p) => ({
        ...p,
        prices: prices.filter((x) => x.plan_id === p.id).map(({ plan_id: _p, ...rest }) => rest),
        features: features.filter((x) => x.plan_id === p.id).map(({ plan_id: _p, ...rest }) => rest),
        tenants: counts.find((c) => c.plan_id === p.id)?.n ?? 0,
        activeTenants: counts.find((c) => c.plan_id === p.id)?.active ?? 0,
        pendingRequests: requests.find((c) => c.plan_id === p.id)?.n ?? 0,
      }));
    });
  }

  async create(input: PlanCreate) {
    return this.db.platform(async (tx) => {
      if (await tx.collection('plans').exists({ key: input.key })) throw Errors.conflict('plan_key_taken', `A plan with the key "${input.key}" already exists`);
      const source = input.copyFrom ? await this.plan(tx, input.copyFrom) : undefined;
      const last = await tx.collection<{ sort_order: number }>('plans').findOne({}, { sort: { sort_order: -1 } });
      const order = input.sortOrder ?? (last?.sort_order ?? 0) + 1;
      const created = await tx.collection<{ id: string }>('plans').insert({
        key: input.key, name: input.name, tagline: input.tagline ?? '', sort_order: order, minimum_seats: input.minimumSeats ?? 1,
        quote_only: input.quoteOnly ?? false, is_public: input.isPublic ?? false, customised_at: new Date(), customised_by_admin_id: requestContext.platformActor().adminId,
      });
      const planFeatures = tx.collection('plan_features');
      if (source) {
        const fs = await planFeatures.find({ plan_id: source.id });
        if (fs.length) await planFeatures.insertMany(fs.map((f) => ({ plan_id: created.id, feature_key: f.feature_key, limit_value: f.limit_value ?? null })));
        const ps = await tx.collection('plan_prices').find({ plan_id: source.id });
        if (ps.length) await tx.collection('plan_prices').insertMany(ps.map((x) => ({ plan_id: created.id, currency: x.currency, monthly_per_seat: x.monthly_per_seat, annual_per_seat_month: x.annual_per_seat_month })));
      } else {
        await planFeatures.insertMany([
          ...CORE_KEYS.map((key) => ({ plan_id: created.id, feature_key: key })),
          // A new plan with no source starts at zero for every limit, so nothing is unlimited by accident.
          ...LIMIT_KEYS.map((key) => ({ plan_id: created.id, feature_key: key, limit_value: 0 })),
        ]);
      }
      await this.audit.record(tx, { tenantId: null, action: 'platform.plan_created', resourceType: 'plan', resourceId: input.key, changes: { ...input } });
      return { key: input.key, id: created.id };
    });
  }

  async update(key: string, input: PlanUpdate) {
    return this.db.platform(async (tx) => {
      const plan = await this.plan(tx, key);
      const cols: Record<keyof PlanUpdate, string> = { name: 'name', tagline: 'tagline', minimumSeats: 'minimum_seats', quoteOnly: 'quote_only', isPublic: 'is_public', sortOrder: 'sort_order' };
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input) as [keyof PlanUpdate, unknown][]) {
        if (v === undefined || !cols[k]) continue;
        set[cols[k]] = v;
      }
      if (!Object.keys(set).length) return { ok: true };
      await tx.collection('plans').updateOne({ id: plan.id }, { $set: { ...set, customised_at: new Date(), customised_by_admin_id: requestContext.platformActor().adminId } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.plan_updated', resourceType: 'plan', resourceId: key, changes: { ...input } });
      return { ok: true };
    });
  }

  /**
   * Replaces the modules a plan includes and sets its limits. The foundation (Core HR) is always included.
   * Takes effect on the next request of every workspace on the plan.
   */
  async setEntitlements(key: string, input: PlanEntitlementsUpdate) {
    return this.db.platform(async (tx) => {
      const plan = await this.plan(tx, key);
      const unknown = input.features.filter((f) => !BOOLEAN_KEYS.has(f));
      if (unknown.length) throw Errors.badRequest('unknown_feature', `Unknown module: ${unknown.join(', ')}`);
      const next = new Set([...input.features, ...CORE_KEYS]);
      const planFeatures = tx.collection<{ feature_key: string; limit_value: number | null }>('plan_features');
      const kinds = new Map((await tx.collection<{ key: string; kind: string }>('features').find()).map((f) => [f.key, f.kind]));
      const before = (await planFeatures.find({ plan_id: plan.id })).map((r) => ({ feature_key: r.feature_key, limit_value: r.limit_value ?? null, kind: kinds.get(r.feature_key) }));
      const had = new Set(before.filter((r) => r.kind === 'boolean').map((r) => r.feature_key));
      const added = [...next].filter((k) => !had.has(k)).sort();
      const removed = [...had].filter((k) => !next.has(k)).sort();
      const booleans = [...kinds].filter(([, kind]) => kind === 'boolean').map(([k]) => k);
      await planFeatures.delete({ plan_id: plan.id, feature_key: { $in: booleans } });
      await planFeatures.insertMany([...next].sort().map((k) => ({ plan_id: plan.id, feature_key: k })));
      const limitChanges: Record<string, { from: number | null; to: number }> = {};
      for (const [k, v] of Object.entries(input.limits)) {
        if (v === undefined) continue;
        const prev = before.find((r) => r.feature_key === k)?.limit_value ?? null;
        if (prev !== v) limitChanges[k] = { from: prev, to: v };
        await planFeatures.upsert({ plan_id: plan.id, feature_key: k }, { plan_id: plan.id, feature_key: k, limit_value: v }, { $set: { limit_value: v } });
      }
      await tx.collection('plans').updateOne({ id: plan.id }, { $set: { customised_at: new Date(), customised_by_admin_id: requestContext.platformActor().adminId } });
      const affected = await tx.collection('subscriptions').count({ plan_id: plan.id, status: { $in: LIVE } });
      await this.audit.record(tx, {
        tenantId: null, action: 'platform.plan_entitlements_changed', resourceType: 'plan', resourceId: key,
        changes: { added, removed, limits: limitChanges }, metadata: { workspaces: affected },
      });
      // Each affected workspace's own trail records the change too, so its admins can see why a module appeared or went.
      if (added.length || removed.length || Object.keys(limitChanges).length) {
        const tenants = await tx.collection<{ tenant_id: string }>('subscriptions').find({ plan_id: plan.id }, { projection: { tenant_id: 1 } });
        for (const t of tenants) {
          await this.audit.record(tx, { tenantId: t.tenant_id, action: 'subscription.plan_contents_changed', resourceType: 'subscription', resourceId: t.tenant_id, changes: { plan: key, added, removed, limits: limitChanges } });
        }
      }
      return { ok: true, added, removed, workspaces: affected };
    });
  }

  async setArchived(key: string, archived: boolean) {
    return this.db.platform(async (tx) => {
      const plan = await this.plan(tx, key);
      await tx.collection('plans').updateOne({ id: plan.id }, { $set: { archived_at: archived ? new Date() : null } });
      if (archived) {
        // Open requests for a plan that is no longer sold are declined, so the customer is not left waiting.
        const requests = tx.collection<{ id: string; tenant_id: string; requested_by_membership_id: string | null }>('plan_requests');
        const open = await requests.find({ plan_id: plan.id, status: 'pending' });
        await requests.update(
          { id: { $in: open.map((r) => r.id) }, status: 'pending' },
          { $set: { status: 'declined', decision_note: 'This plan is no longer offered', decided_at: new Date(), decided_by_admin_id: requestContext.platformActor().adminId } },
        );
        for (const r of open) await this.notifications.notify(tx, { membershipIds: [r.requested_by_membership_id], kind: 'billing.plan_request_declined', title: `Your request for the ${plan.name} plan was declined`, body: 'This plan is no longer offered.', link: '/settings/billing' });
      }
      await this.audit.record(tx, { tenantId: null, action: archived ? 'platform.plan_archived' : 'platform.plan_restored', resourceType: 'plan', resourceId: key });
      const n = await tx.collection('subscriptions').count({ plan_id: plan.id });
      return { ok: true, note: archived ? `${plan.name} is no longer offered. ${n} workspace(s) on it keep it until they change plan.` : `${plan.name} is offered again.` };
    });
  }

  /** Deletes a plan nobody has ever subscribed to (for example, one created by mistake). */
  async remove(key: string) {
    return this.db.platform(async (tx) => {
      const plan = await this.plan(tx, key);
      if (['starter', 'professional', 'business', 'enterprise'].includes(key)) throw Errors.badRequest('launch_plan', 'The four launch plans can be archived but not deleted');
      if (await tx.collection('subscriptions').exists({ plan_id: plan.id })) throw Errors.conflict('plan_in_use', 'Workspaces are on this plan. Archive it instead.');
      await tx.collection('plan_requests').delete({ plan_id: plan.id });
      await tx.collection('plans').delete({ id: plan.id });
      await this.audit.record(tx, { tenantId: null, action: 'platform.plan_deleted', resourceType: 'plan', resourceId: key });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Plan requests from workspace admins
  // ---------------------------------------------------------------------------------------------------------

  requests(status?: string) {
    return this.db.platform(async (tx) => {
      const rows = await tx.collection<{
        id: string; tenant_id: string; plan_id: string; seats: number; billing_cycle: string; message: string | null; status: string;
        requested_by_label: string; created_at: Date; decision_note: string | null; decided_at: Date | null; decided_by_admin_id: string | null;
      }>('plan_requests').find(status ? { status } : {});
      rows.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.created_at.getTime() - a.created_at.getTime());
      const page = rows.slice(0, 200);
      const tenantIds = [...new Set(page.map((r) => r.tenant_id))];
      const tenants = new Map((await tx.collection<{ id: string; name: string }>('tenants').find({ id: { $in: tenantIds } })).map((t) => [t.id, t.name]));
      const subs = new Map((await tx.collection<{ tenant_id: string; plan_id: string }>('subscriptions').find({ tenant_id: { $in: tenantIds } })).map((x) => [x.tenant_id, x.plan_id]));
      const plans = new Map((await tx.collection<{ id: string; key: string; name: string }>('plans').find({ id: { $in: [...page.map((r) => r.plan_id), ...subs.values()] } })).map((p) => [p.id, p]));
      const admins = new Map((await tx.collection<{ id: string; full_name: string }>('platform_admins').find({ id: { $in: page.map((r) => r.decided_by_admin_id).filter(Boolean) } })).map((a) => [a.id, a.full_name]));
      return page
        .filter((r) => tenants.has(r.tenant_id) && plans.has(r.plan_id))
        .map((r) => {
          const p = plans.get(r.plan_id)!;
          const cp = plans.get(subs.get(r.tenant_id) ?? '');
          return {
            id: r.id, tenantId: r.tenant_id, tenantName: tenants.get(r.tenant_id)!, planKey: p.key, planName: p.name,
            currentPlanKey: cp?.key ?? null, currentPlanName: cp?.name ?? null,
            seats: r.seats, billingCycle: r.billing_cycle, message: r.message ?? null, status: r.status, requestedBy: r.requested_by_label, createdAt: r.created_at,
            decisionNote: r.decision_note ?? null, decidedAt: r.decided_at ?? null, decidedBy: (r.decided_by_admin_id && admins.get(r.decided_by_admin_id)) ?? null,
          };
        });
    });
  }

  async decide(id: string, decision: 'approved' | 'declined', note?: string) {
    return this.db.platform(async (tx) => {
      const requests = tx.collection<{ id: string; tenant_id: string; plan_id: string; seats: number; billing_cycle: string; status: string; requested_by_membership_id: string | null }>('plan_requests');
      if (!(await requests.lock({ id }))) throw Errors.notFound('Plan request');
      const req = (await requests.findOne({ id }))!;
      const p = await tx.collection<PlanRow>('plans').findOne({ id: req.plan_id });
      if (!p) throw Errors.notFound('Plan request');
      const r = { ...req, plan_key: p.key, plan_name: p.name, archived_at: p.archived_at };
      if (r.status !== 'pending') throw Errors.conflict('request_decided', 'This request has already been answered');
      const adminId = requestContext.platformActor().adminId;
      if (decision === 'approved') {
        if (r.archived_at) throw Errors.badRequest('plan_archived', 'This plan is archived. Restore it before approving.');
        const subscriptions = tx.collection<{ currency: string; plan_id: string; unit_price: string; status: string }>('subscriptions');
        await subscriptions.lock({ tenant_id: r.tenant_id });
        const s = (await subscriptions.findOne({ tenant_id: r.tenant_id }))!;
        const sub = { ...s, plan_key: (await tx.collection<{ key: string }>('plans').findOne({ id: s.plan_id }))?.key };
        const price = await tx.collection<{ monthly_per_seat: string; annual_per_seat_month: string }>('plan_prices').findOne({ plan_id: r.plan_id, currency: sub.currency });
        // A quote-only plan has no list price: the subscription keeps its price until SAMPLEDGE sets the negotiated one.
        const unit = price ? (r.billing_cycle === 'annual' ? price.annual_per_seat_month : price.monthly_per_seat) : sub.unit_price;
        await subscriptions.updateOne({ tenant_id: r.tenant_id }, {
          $set: { plan_id: r.plan_id, seats: r.seats, billing_cycle: r.billing_cycle, unit_price: unit, status: ['trialing', 'active'].includes(s.status) ? s.status : 'active' },
        });
        await this.audit.record(tx, {
          tenantId: r.tenant_id, action: 'subscription.changed', resourceType: 'subscription', resourceId: r.tenant_id,
          changes: { from: { plan: sub.plan_key }, to: { plan: r.plan_key, seats: r.seats, cycle: r.billing_cycle }, via: 'plan_request', requestId: r.id },
        });
      }
      await requests.updateOne({ id: r.id }, { $set: { status: decision, decision_note: note ?? null, decided_at: new Date(), decided_by_admin_id: adminId } });
      await this.audit.record(tx, { tenantId: null, action: `platform.plan_request_${decision}`, resourceType: 'plan_request', resourceId: r.id, metadata: { tenantId: r.tenant_id, plan: r.plan_key } });
      await this.notifications.notify(tx, {
        membershipIds: [r.requested_by_membership_id],
        kind: `billing.plan_request_${decision}`,
        title: decision === 'approved' ? `Your workspace is now on the ${r.plan_name} plan` : `Your request for the ${r.plan_name} plan was declined`,
        body: note,
        link: '/settings/billing',
        email: true,
      });
      return { ok: true };
    });
  }

  private async plan(tx: Tx, key: string): Promise<PlanRow> {
    const p = await tx.collection<PlanRow>('plans').findOne({ key });
    if (!p) throw Errors.notFound('Plan');
    return p;
  }
}
