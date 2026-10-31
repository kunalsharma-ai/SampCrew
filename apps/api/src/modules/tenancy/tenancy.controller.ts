import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { tenantSettingsInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { RequirePermission } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';

const SETTINGS = `id, slug::text, name, status, region, timezone, currency, locale, country_code as "countryCode", brand_color as "brandColor", require_mfa as "requireMfa", is_demo as "isDemo", created_at as "createdAt"`;

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
    return this.db.tenant((tx) => one(tx, `select ${SETTINGS} from tenants where id = app_tenant_id()`));
  }

  @Patch()
  @RequirePermission('tenant:manage')
  @Doc({ summary: 'Update workspace settings (name, time zone, currency, locale, brand colour, MFA policy)', body: tenantSettingsInput })
  update(@Body(new ZodPipe(tenantSettingsInput)) body: z.infer<typeof tenantSettingsInput>) {
    return this.db.tenant(async (tx) => {
      const before = (await one<Record<string, unknown>>(tx, `select ${SETTINGS} from tenants where id = app_tenant_id()`))!;
      const map: Record<string, string> = { name: 'name', timezone: 'timezone', currency: 'currency', locale: 'locale', brandColor: 'brand_color', requireMfa: 'require_mfa' };
      const entries = Object.entries(body).filter(([k, v]) => map[k] && v !== undefined);
      if (body.requireMfa) {
        const me = await this.db.platform((ptx) => one<{ mfa_enabled: boolean }>(ptx, 'select mfa_enabled from users where id = $1', [requestContext.tenantActor().userId]));
        if (!me?.mfa_enabled) throw Errors.badRequest('enable_mfa_first', 'Turn on MFA for your own account before requiring it for everyone');
      }
      if (entries.length) await tx.query(`update tenants set ${entries.map(([k], i) => `${map[k]} = $${i + 1}`).join(', ')} where id = app_tenant_id()`, entries.map(([, v]) => v));
      const after = (await one<Record<string, unknown>>(tx, `select ${SETTINGS} from tenants where id = app_tenant_id()`))!;
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
    return this.db.tenant((tx) =>
      many(
        tx,
        `select g.id, g.reason, g.duration_minutes as "durationMinutes", g.status, g.created_at as "createdAt", g.decided_at as "decidedAt", g.expires_at as "expiresAt",
                case when g.status = 'approved' and g.expires_at < now() then 'expired' else g.status end as "effectiveStatus"
           from support_access_grants g order by g.created_at desc limit 50`,
      ),
    );
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
      const g = await one<{ status: string; duration_minutes: number }>(tx, 'select status, duration_minutes from support_access_grants where id = $1 for update', [id]);
      if (!g) throw Errors.notFound('Support request');
      const allowed = status === 'revoked' ? g.status === 'approved' : g.status === 'pending';
      if (!allowed) throw Errors.conflict('invalid_state', `This request is ${g.status}`);
      await tx.query(
        `update support_access_grants set status = $2, decided_by = $3, decided_at = now(),
           expires_at = case when $2 = 'approved' then now() + make_interval(mins => $4) when $2 = 'revoked' then now() else expires_at end
         where id = $1`,
        [id, status, actor.membershipId, g.duration_minutes],
      );
      await this.audit.record(tx, { action: `support_access.${status}`, resourceType: 'support_access_grant', resourceId: id });
      return { id, status };
    });
  }
}
