import { Injectable } from '@nestjs/common';
import { FEATURES, type ViewAsSession } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { PlatformService } from '../platform-admin/platform.service';
import { TenantControlService } from '../platform-admin/tenant-control.service';
import { canSeePii, maskEmail } from './companies.service';

type Section = ViewAsSession['sections'][number];
const LABEL = new Map<string, string>(FEATURES.map((f) => [f.key, f.name]));

/**
 * "View as": a read-only look at a client's Super Workspace from the Console, only while the client has approved a
 * support access request from this admin (Settings > Support access in SampCrew) and the grant has not expired.
 * Every section opened is recorded in the client's own audit trail and in the Console's, the Console shows a banner
 * with the time left and an Exit button, and Exit ends the grant at once. What it shows never goes past the admin's
 * own permissions: users need users:read (emails masked without users:pii), billing needs billing:read. It never
 * shows employee records, messages, documents, payroll or attendance.
 */
@Injectable()
export class ViewAsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly platform: PlatformService,
    private readonly control: TenantControlService,
  ) {}

  private sections(): Section[] {
    const p = requestContext.platformActor().permissions;
    return ['overview', 'structure', 'modules', 'activity', ...(p.includes('users:read') ? (['users'] as const) : []), ...(p.includes('billing:read') ? (['billing'] as const) : [])];
  }

  private async grant(tx: PlatformTx, tenantId: string) {
    const a = requestContext.platformActor();
    const g = await tx.collection<{ id: string; expires_at: Date; reason: string; decided_by: string | null }>('support_access_grants')
      .findOne({ tenant_id: tenantId, platform_admin_id: a.adminId, status: 'approved', expires_at: { $gt: new Date() } }, { sort: { expires_at: -1 } });
    if (!g) throw Errors.forbidden('No approved support access for this workspace. Request access and wait for the client to approve it.');
    return g;
  }

  /** The current approved grant for this admin, or null (the Console then offers "Request access"). */
  current(tenantId: string): Promise<{ session: ViewAsSession | null }> {
    return this.db.platform(async (tx) => {
      const t = await tx.collection<{ id: string; name: string; company_id: string | null }>('tenants').findOne({ id: tenantId }, { projection: { name: 1, company_id: 1 } });
      if (!t) throw Errors.notFound('Workspace');
      const g = await this.grant(tx, tenantId).catch(() => null);
      if (!g) return { session: null };
      const by = g.decided_by ? await tx.collection<{ user_id: string }>('memberships').findOne({ id: g.decided_by }, { projection: { user_id: 1 } }) : null;
      const who = by ? await tx.collection<{ full_name: string }>('users').findOne({ id: by.user_id }, { projection: { full_name: 1 } }) : null;
      return { session: { grantId: g.id, tenantId, workspace: t.name, clientId: t.company_id ?? null, expiresAt: g.expires_at.toISOString(), reason: g.reason, approvedBy: who?.full_name ?? null, sections: this.sections() } };
    });
  }

  async section(tenantId: string, section: Section) {
    if (!this.sections().includes(section)) throw Errors.forbidden('Your role cannot see this part of the workspace.');
    const a = requestContext.platformActor();
    const grant = await this.db.platform(async (tx) => {
      const g = await this.grant(tx, tenantId);
      await this.audit.record(tx, { tenantId: null, action: 'platform.view_as_viewed', resourceType: 'tenant', resourceId: tenantId, metadata: { grantId: g.id, section } });
      return g;
    });
    if (section === 'overview' || section === 'activity') {
      // The existing read-only snapshot, read through the tenant role and audited in the client's own trail.
      const snap = await this.platform.supportView(tenantId);
      if (section === 'activity') return { section, items: snap.recentAudit };
      const cfg = await this.db.platform((tx) => tx.collection<{ name: string; timezone: string; region: string; status: string; locale: string; setup_completed_at: Date | null; require_mfa: boolean; country_code: string | null }>('tenants').findOne({ id: tenantId }));
      return {
        section, overview: snap.overview, roles: snap.roles,
        config: cfg ? { name: cfg.name, status: cfg.status, timezone: cfg.timezone, region: cfg.region, locale: cfg.locale, country: cfg.country_code ?? null, setupDone: !!cfg.setup_completed_at, requireMfa: cfg.require_mfa } : null,
      };
    }
    return this.db.tenant(async (tx) => {
      await this.audit.record(tx, { tenantId, action: 'support_access.viewed', resourceType: 'tenant', resourceId: tenantId, metadata: { grantId: grant.id, by: a.label, section } });
      if (section === 'structure') {
        const hr = await tx.collection<{ id: string; name: string; kind: string; status: string; max_employees: number }>('hr_workspaces').find({ archived_at: null }, { sort: { name: 1 }, projection: { name: 1, kind: 1, status: 1, max_employees: 1 } });
        const names = async (table: string) => (await tx.collection<{ name: string }>(table).find({ archived_at: null }, { sort: { name: 1 }, projection: { name: 1 }, limit: 200 })).map((r) => r.name);
        return { section, hrWorkspaces: hr.map((h) => ({ id: h.id, name: h.name, kind: h.kind, status: h.status, maxEmployees: h.max_employees })), legalEntities: await names('legal_entities'), locations: await names('locations'), departments: await names('departments') };
      }
      if (section === 'modules') {
        const sub = await tx.collection<{ plan_id: string; status: string }>('subscriptions').findOne({});
        const features = sub ? await tx.collection<{ feature_key: string; limit_value: number | null }>('plan_features').find({ plan_id: sub.plan_id }) : [];
        const plan = sub ? await tx.collection<{ name: string }>('plans').findOne({ id: sub.plan_id }, { projection: { name: 1 } }) : null;
        return {
          section, plan: plan?.name ?? null, status: sub?.status ?? null,
          modules: features.filter((f) => f.limit_value == null).map((f) => ({ key: f.feature_key, label: LABEL.get(f.feature_key) ?? f.feature_key })),
          limits: features.filter((f) => f.limit_value != null).map((f) => ({ key: f.feature_key, label: LABEL.get(f.feature_key) ?? f.feature_key, value: f.limit_value })),
        };
      }
      if (section === 'billing') {
        const sub = await tx.collection<{ status: string; seats: number; currency: string; billing_cycle: string; current_period_end: string; trial_ends_on: string | null }>('subscriptions').findOne({});
        return { section, subscription: sub ? { status: sub.status, seats: sub.seats, currency: sub.currency, cycle: sub.billing_cycle, periodEnd: sub.current_period_end, trialEndsOn: sub.trial_ends_on ?? null } : null };
      }
      return { section };
    }, { tenantId }).then(async (r) => {
      if (section !== 'users') return r;
      const users = await this.control.users({ tenantId, limit: 100, offset: 0 });
      const pii = canSeePii();
      return { section, total: users.total, summary: users.summary, items: users.items.map((u) => ({ ...u, email: pii ? u.email : maskEmail(u.email) })) };
    });
  }

  /** Exit: ends the grant now, so nobody can keep looking (the client sees it as ended in Settings > Support access). */
  exit(tenantId: string) {
    return this.db.platform(async (tx) => {
      const g = await this.grant(tx, tenantId);
      const now = new Date();
      await tx.collection('support_access_grants').updateOne({ id: g.id }, { $set: { status: 'revoked', expires_at: now } });
      await this.audit.record(tx, { tenantId, action: 'support_access.ended', resourceType: 'support_access_grant', resourceId: g.id, metadata: { by: requestContext.platformActor().label } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.view_as_ended', resourceType: 'tenant', resourceId: tenantId, metadata: { grantId: g.id } });
      return { ended: true };
    });
  }
}
