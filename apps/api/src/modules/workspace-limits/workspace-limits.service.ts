import { HttpStatus, Injectable } from '@nestjs/common';
import {
  UNLIMITED,
  WORKSPACE_LIMIT_KEY,
  WORKSPACE_LIMIT_KINDS,
  workspaceLimitKindOf,
  workspaceLimitMessage,
  workspaceLimitUsage,
  type WorkspaceLimitKind,
  type WorkspaceLimits,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { hasPermission } from '../../platform/authz/policy';
import { AuthzService } from '../../platform/authz/authz.service';
import { MongoService as DatabaseService, type PlatformTx, type TenantTx } from '../../platform/database/mongo.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { AppError, Errors } from '../../platform/http/errors';

/** What each limit counts (the same rule as the database guard in packages/db workspace-limits.ts). */
const COUNTED: Record<WorkspaceLimitKind, { table: string; filter: Record<string, unknown> }> = {
  hr: { table: 'hr_workspaces', filter: { archived_at: null } },
  employee: { table: 'memberships', filter: { status: { $ne: 'suspended' } } },
};

/** Who may see the company's workspace usage: those who create workspaces or logins, or look after billing. */
const VIEWERS = ['hierarchy:read', 'users:invite', 'users:manage', 'employees:create', 'billing:read'];

/** The count for one company from a platform (Console) transaction. */
export function countWorkspaces(tx: PlatformTx, tenantId: string, kind: WorkspaceLimitKind): Promise<number> {
  return tx.collection(COUNTED[kind].table).count({ tenant_id: tenantId, ...COUNTED[kind].filter });
}

export function workspaceLimitReached(kind: WorkspaceLimitKind, used: number, limit: number) {
  return new AppError(HttpStatus.PAYMENT_REQUIRED, 'workspace_limit_reached', workspaceLimitMessage(kind, used, limit), { kind, key: WORKSPACE_LIMIT_KEY[kind], used, limit });
}

/**
 * Plan-based workspace limits (see @crew/contracts workspace-limits.ts). The flow is
 * Console plan limits -> the company's subscription (plan + add-ons + SAMPLEDGE's per-company figure) -> every creation.
 * Nothing is copied onto the company: the figures are read from the plan on each request, so a plan edit in the
 * Console or an upgrade applies straight away, and lowering a limit never removes a workspace.
 */
@Injectable()
export class WorkspaceLimitsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  async count(tx: TenantTx, kind: WorkspaceLimitKind): Promise<number> {
    return tx.collection(COUNTED[kind].table).count(COUNTED[kind].filter);
  }

  /** The company's limit now; null when there is none. */
  async limit(tx: TenantTx, kind: WorkspaceLimitKind): Promise<number | null> {
    const v = (await loadEntitlements(tx)).limits[WORKSPACE_LIMIT_KEY[kind]];
    return v === undefined || v === UNLIMITED ? null : v;
  }

  /**
   * Current + adding <= Allowed, or a 402 workspace_limit_reached that says so (recorded in the audit trail). The
   * database guard checks the same rule again when the workspace is written, so a race or a missed path cannot pass.
   */
  async require(tx: TenantTx, kind: WorkspaceLimitKind, adding = 1, context: Record<string, unknown> = {}): Promise<void> {
    const limit = await this.limit(tx, kind);
    if (limit === null) return;
    const used = await this.count(tx, kind);
    if (used + adding <= limit) return;
    // The request's own transaction rolls back, so the refusal is recorded in a transaction of its own.
    await this.db.tenant((t) => this.audit.record(t, { action: 'workspace_limit.reached', resourceType: kind === 'hr' ? 'hr_workspace' : 'membership', metadata: { kind, key: WORKSPACE_LIMIT_KEY[kind], used, limit, adding, ...context } }), { tenantId: tx.tenantId }).catch(() => undefined);
    throw workspaceLimitReached(kind, used, limit);
  }

  /** Used / Maximum for the signed-in company, with where the figures come from and the ways to get more. */
  async mine(): Promise<WorkspaceLimits> {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      // Seeing the figures needs no second factor; acting on them (billing, creating) asks for it where it always did.
      const holds = (p: string) => { const d = hasPermission(s, p); return d.allowed || d.reason === 'mfa_required'; };
      if (!VIEWERS.some(holds)) throw Errors.forbidden();
      return this.usage(tx, holds('billing:manage'));
    });
  }

  /** The same for one company, for the SAMPLEDGE Console. */
  forTenant(tenantId: string): Promise<WorkspaceLimits> {
    return this.db.tenant((tx) => this.usage(tx, false), { tenantId });
  }

  async usage(tx: TenantTx, canManageBilling: boolean): Promise<WorkspaceLimits> {
    const e = await loadEntitlements(tx);
    const sub = await tx.collection('subscriptions').findOne({});
    const plan = sub ? await tx.collection('plans').findOne({ id: sub.plan_id }) : undefined;
    const active = !!sub && sub.status !== 'cancelled' && sub.status !== 'suspended';
    const planRows = plan ? await tx.collection('plan_features').find({ plan_id: plan.id, feature_key: { $in: Object.values(WORKSPACE_LIMIT_KEY) } }) : [];
    const bought = await tx.collection('subscription_addons').find({ status: 'active' });
    const addonDefs = bought.length ? await tx.collection('addons').find({ id: { $in: bought.map((b) => b.addon_id) }, kind: 'limit' }) : [];
    const overrides = (sub?.feature_overrides ?? {}) as Record<string, unknown>;
    const toLimit = (v: unknown) => (typeof v === 'number' && v !== UNLIMITED ? v : null);

    const sources = {} as WorkspaceLimits['sources'];
    const out = {} as Record<WorkspaceLimitKind, WorkspaceLimits['hr']>;
    for (const kind of WORKSPACE_LIMIT_KINDS) {
      const key = WORKSPACE_LIMIT_KEY[kind];
      const addons = bought.reduce((n, b) => {
        const d = addonDefs.find((a) => a.id === b.addon_id && a.feature_key === key);
        return d ? n + Number(d.unit_quantity) * Number(b.quantity) : n;
      }, 0);
      sources[kind] = { plan: toLimit(planRows.find((r) => r.feature_key === key)?.limit_value), addons, override: toLimit(overrides[key]) };
      out[kind] = workspaceLimitUsage(kind, await this.count(tx, kind), active ? e.limits[key] : null);
    }

    // Ways to get more room: plans with a higher figure than now, and add-ons that raise a limit.
    const plans = await tx.collection('plans').find({ is_public: true, archived_at: null });
    const allRows = plans.length ? await tx.collection('plan_features').find({ plan_id: { $in: plans.map((p) => p.id) }, feature_key: { $in: Object.values(WORKSPACE_LIMIT_KEY) } }) : [];
    const figure = (planId: string, kind: WorkspaceLimitKind) => {
      const r = allRows.find((x) => x.plan_id === planId && x.feature_key === WORKSPACE_LIMIT_KEY[kind]);
      return r ? toLimit(r.limit_value ?? UNLIMITED) : null;
    };
    const roomier = (kind: WorkspaceLimitKind, planId: string) => {
      const now = out[kind].limit;
      if (now === null) return false;
      const f = figure(planId, kind);
      return f === null || f > now;
    };
    const planOptions = plans
      .filter((p) => p.id !== plan?.id && (roomier('hr', p.id as string) || roomier('employee', p.id as string)))
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map((p) => ({ key: p.key as string, name: p.name as string, hr: figure(p.id as string, 'hr'), employee: figure(p.id as string, 'employee'), quoteOnly: !!p.quote_only, higherTier: Number(p.sort_order ?? 0) > Number(plan?.sort_order ?? 0) }))
      // Steps up first: a plan below the current one is offered only when no higher one has more room.
      .sort((a, b) => Number(b.higherTier) - Number(a.higherTier));
    const addonOptions = (await tx.collection('addons').find({ kind: 'limit', feature_key: { $in: Object.values(WORKSPACE_LIMIT_KEY) }, is_public: true, archived_at: null }))
      .filter((a) => !plan || !(a.plan_keys as string[] | undefined)?.length || (a.plan_keys as string[]).includes(plan.key as string))
      .map((a) => ({ key: a.key as string, name: a.name as string, kind: workspaceLimitKindOf(a.feature_key as string)!, unitQuantity: Number(a.unit_quantity) }));

    return {
      plan: plan ? { key: plan.key as string, name: plan.name as string } : null,
      active,
      hr: out.hr,
      employee: out.employee,
      sources,
      upgrade: { canManageBilling, plans: planOptions, addons: addonOptions },
    };
  }
}
