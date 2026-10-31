import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_ROLE_CAPABILITIES, type PlatformRole } from '@crew/contracts';
import type { Request } from 'express';
import { AuthzService } from '../authz/authz.service';
import { ALLOW_WITHOUT_MFA_KEY, FEATURE_KEY, PERMISSION_KEY, PUBLIC_KEY, REALM_KEY } from '../authz/decorators';
import { requestContext } from '../context/request-context';
import { DatabaseService, one } from '../database/database.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { Errors } from '../http/errors';
import { TokenService } from './token.service';

/**
 * Global guard. Order of checks for tenant routes:
 *   1. bearer token signature, audience, expiry
 *   2. session not revoked, membership active, tenant active (one DB round trip)
 *   3. workspace MFA policy
 *   4. subscription entitlement (@RequireFeature)
 *   5. RBAC permission (@RequirePermission); record-level ABAC happens in services
 * Platform routes (@PlatformRealm) use a separate signing key, session table and capability list.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private meta<T>(key: string, ctx: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    if (this.meta<boolean>(PUBLIC_KEY, ctx)) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw Errors.unauthorized();
    const allowWithoutMfa = this.meta<boolean>(ALLOW_WITHOUT_MFA_KEY, ctx) ?? false;

    const realm = this.meta<{ realm: 'platform'; capability?: string }>(REALM_KEY, ctx);
    if (realm?.realm === 'platform') return this.platform(token, realm.capability, allowWithoutMfa);

    const claims = await this.tokens.verifyAccess(token).catch(() => {
      throw Errors.unauthorized('Your session has expired. Sign in again.');
    });
    const row = await this.db.platform((tx) =>
      one<{ session_ok: boolean; membership_status: string; tenant_status: string; require_mfa: boolean; full_name: string; email: string }>(
        tx,
        `select (s.revoked_at is null and s.expires_at > now()) as session_ok, m.status as membership_status,
                t.status as tenant_status, t.require_mfa, u.full_name, u.email::text
           from sessions s
           join memberships m on m.id = $2 and m.user_id = s.user_id and m.tenant_id = $3
           join tenants t on t.id = m.tenant_id
           join users u on u.id = s.user_id and u.status = 'active'
          where s.id = $1 and s.user_id = $4 and s.tenant_id = $3`,
        [claims.sid, claims.mid, claims.tid, claims.sub],
      ),
    );
    if (!row?.session_ok || row.membership_status !== 'active') throw Errors.unauthorized('Your session is no longer valid. Sign in again.');
    if (row.tenant_status !== 'active') throw Errors.tenantSuspended();

    requestContext.setActor({ kind: 'user', userId: claims.sub, tenantId: claims.tid, membershipId: claims.mid, sessionId: claims.sid, mfa: claims.mfa, label: `${row.full_name} <${row.email}>` });

    if (row.require_mfa && !claims.mfa && !allowWithoutMfa) throw Errors.mfaRequired();

    const feature = this.meta<string>(FEATURE_KEY, ctx);
    if (feature) await this.entitlements.requireFeature(feature);

    const permission = this.meta<string>(PERMISSION_KEY, ctx);
    if (permission) await this.authz.require(permission);
    return true;
  }

  private async platform(token: string, capability: string | undefined, allowWithoutMfa: boolean): Promise<boolean> {
    const claims = await this.tokens.verifyPlatform(token).catch(() => {
      throw Errors.unauthorized('Your console session has expired. Sign in again.');
    });
    const row = await this.db.platform((tx) =>
      one<{ ok: boolean; email: string }>(
        tx,
        `select (s.revoked_at is null and s.expires_at > now() and a.status = 'active') as ok, a.email::text
           from platform_sessions s join platform_admins a on a.id = s.admin_id where s.id = $1 and a.id = $2`,
        [claims.sid, claims.sub],
      ),
    );
    if (!row?.ok) throw Errors.unauthorized('Your console session is no longer valid.');
    requestContext.setActor({ kind: 'platform_admin', adminId: claims.sub, role: claims.role, sessionId: claims.sid, mfa: claims.mfa, label: `SAMPLEDGE ${row.email}` });
    // MFA is mandatory for every platform action except enrolling MFA itself.
    if (!claims.mfa && !allowWithoutMfa) throw Errors.mfaRequired();
    if (capability && !PLATFORM_ROLE_CAPABILITIES[claims.role as PlatformRole]?.includes(capability)) throw Errors.forbidden();
    return true;
  }
}
