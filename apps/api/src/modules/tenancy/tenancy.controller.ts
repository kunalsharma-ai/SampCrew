import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { tenantSettingsInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { RequirePermission } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

/** The workspace's settings as the API shows them. */
async function settings(tx: TenantTx) {
  const t = (await tx.collection('tenants').findOne({}))!;
  return {
    id: t.id as string,
    slug: t.slug as string,
    name: t.name as string,
    status: t.status as string,
    region: t.region as string,
    timezone: t.timezone as string,
    currency: t.currency as string,
    locale: t.locale as string,
    countryCode: t.country_code as string,
    brandColor: (t.brand_color as string | null) ?? null,
    requireMfa: t.require_mfa as boolean,
    isDemo: t.is_demo as boolean,
    createdAt: t.created_at as Date,
  };
}

@Controller('tenant')
export class TenancyController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('tenant:read')
  @Doc({ summary: 'Workspace settings' })
  get() {
    return this.db.tenant(settings);
  }

  @Patch()
  @RequirePermission('tenant:manage')
  @Doc({ summary: 'Update workspace settings (name, time zone, currency, locale, brand colour, MFA policy)', body: tenantSettingsInput })
  update(@Body(new ZodPipe(tenantSettingsInput)) body: z.infer<typeof tenantSettingsInput>) {
    return this.db.tenant(async (tx) => {
      const before = await settings(tx);
      const map: Record<string, string> = { name: 'name', timezone: 'timezone', currency: 'currency', locale: 'locale', brandColor: 'brand_color', requireMfa: 'require_mfa' };
      const entries = Object.entries(body).filter(([k, v]) => map[k] && v !== undefined);
      if (body.requireMfa) {
        const me = await this.db.platform((ptx) => ptx.collection('users').findOne({ id: requestContext.tenantActor().userId }, { projection: { mfa_enabled: 1 } }));
        if (!me?.mfa_enabled) throw Errors.badRequest('enable_mfa_first', 'Turn on MFA for your own account before requiring it for everyone');
      }
      if (entries.length) await tx.collection('tenants').updateOne({ id: before.id }, { $set: Object.fromEntries(entries.map(([k, v]) => [map[k]!, v])) });
      const after = await settings(tx);
      await this.audit.record(tx, { action: 'tenant.settings_updated', resourceType: 'tenant', resourceId: after.id as string, changes: diff(before, after) });
      return after;
    });
  }
}

/** Tenant-side control over SAMPLEDGE support access. Support staff never see tenant data without an approved, time-boxed grant. */
@Controller('support-access')
export class SupportAccessController {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('tenant:read')
  @Doc({ summary: 'Support access requests from SAMPLEDGE' })
  list() {
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const grants = await tx.collection('support_access_grants').find({}, { sort: { created_at: -1 }, limit: 50 });
      return grants.map((g) => ({
        id: g.id,
        reason: g.reason,
        durationMinutes: g.duration_minutes,
        status: g.status,
        createdAt: g.created_at,
        decidedAt: g.decided_at ?? null,
        expiresAt: g.expires_at ?? null,
        effectiveStatus: g.status === 'approved' && g.expires_at && g.expires_at < now ? 'expired' : g.status,
      }));
    });
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('tenant:manage')
  @Doc({ summary: 'Approve a support access request for its requested duration' })
  approve(@Param('id', UuidPipe) id: string) {
    return this.decide(id, 'approved');
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('tenant:manage')
  @Doc({ summary: 'Reject a support access request' })
  reject(@Param('id', UuidPipe) id: string) {
    return this.decide(id, 'rejected');
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('tenant:manage')
  @Doc({ summary: 'End an approved support session early' })
  revoke(@Param('id', UuidPipe) id: string) {
    return this.decide(id, 'revoked');
  }

  private decide(id: string, status: 'approved' | 'rejected' | 'revoked') {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const g = await tx.collection('support_access_grants').findOne({ id });
      if (!g) throw Errors.notFound('Support request');
      const allowed = status === 'revoked' ? g.status === 'approved' : g.status === 'pending';
      if (!allowed) throw Errors.conflict('invalid_state', `This request is ${g.status}`);
      const now = new Date();
      const expires = status === 'approved' ? { expires_at: new Date(now.getTime() + g.duration_minutes * 60_000) } : status === 'revoked' ? { expires_at: now } : {};
      // Writing the grant in this transaction is what keeps two decisions from both passing the state check above.
      await tx.collection('support_access_grants').updateOne({ id, status: g.status }, { $set: { status, decided_by: actor.membershipId, decided_at: now, ...expires } });
      await this.audit.record(tx, { action: `support_access.${status}`, resourceType: 'support_access_grant', resourceId: id });
      return { id, status };
    });
  }
}
