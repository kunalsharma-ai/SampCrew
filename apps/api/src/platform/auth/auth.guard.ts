import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_PREFIX, PLATFORM_ROLE_CAPABILITIES, type PlatformRole } from '@crew/contracts';
import type { Request } from 'express';
import { AuthzService } from '../authz/authz.service';
import { ALLOW_WITHOUT_MFA_KEY, FEATURE_KEY, PERMISSION_KEY, PUBLIC_KEY, REALM_KEY } from '../authz/decorators';
import { requestContext } from '../context/request-context';
import { DatabaseService, one } from '../database/database.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { Errors } from '../http/errors';
import { ApiKeysService } from '../../modules/integrations/api-keys.service';
import { ScimService } from '../../modules/identity/scim.service';
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
    private readonly apiKeys: ApiKeysService,
    private readonly scimTokens: ScimService,
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

    const realm = this.meta<{ realm: 'platform' | 'scim'; capability?: string }>(REALM_KEY, ctx);
    if (realm?.realm === 'platform') return this.platform(token, realm.capability, allowWithoutMfa);
    if (realm?.realm === 'scim') return this.scim(token);
    if (token.startsWith(API_KEY_PREFIX)) return this.apiKey(token, req, ctx);

    const claims = await this.tokens.verifyAccess(token).catch(() => {
      throw Errors.unauthorized('Your session has expired. Sign in again.');
    });
    const row = await this.db.platform((tx) =>
      one<{ session_ok: boolean; membership_status: string; tenant_status: string; require_mfa: boolean; full_name: string; email: string; client: 'web' | 'mobile' | 'api'; web_on: boolean; mobile_on: boolean }>(
        tx,
        `select (s.revoked_at is null and s.expires_at > now()) as session_ok, m.status as membership_status,
                t.status as tenant_status, t.require_mfa, u.full_name, u.email::text, s.client,
                coalesce(c.web_portal_enabled, true) as web_on, coalesce(c.mobile_app_enabled, true) as mobile_on
           from sessions s
           join memberships m on m.id = $2 and m.user_id = s.user_id and m.tenant_id = $3
           join tenants t on t.id = m.tenant_id
           join users u on u.id = s.user_id and u.status = 'active'
           left join tenant_access_controls c on c.tenant_id = t.id
          where s.id = $1 and s.user_id = $4 and s.tenant_id = $3`,
        [claims.sid, claims.mid, claims.tid, claims.sub],
      ),
    );
    if (!row?.session_ok || row.membership_status !== 'active') throw Errors.unauthorized('Your session is no longer valid. Sign in again.');
    if (row.tenant_status !== 'active') throw Errors.tenantSuspended();
    // An app SAMPLEDGE switched off for the workspace is closed on every request, not only at sign-in.
    if ((row.client === 'web' && !row.web_on) || (row.client === 'mobile' && !row.mobile_on)) throw Errors.appSwitchedOff(row.client);

    requestContext.setActor({ kind: 'user', userId: claims.sub, tenantId: claims.tid, membershipId: claims.mid, sessionId: claims.sid, mfa: claims.mfa, client: row.client, label: `${row.full_name} <${row.email}>` });

    if (row.require_mfa && !claims.mfa && !allowWithoutMfa) throw Errors.mfaRequired();

    const feature = this.meta<string>(FEATURE_KEY, ctx);
    if (feature) await this.entitlements.requireFeature(feature);

    const permission = this.meta<string>(PERMISSION_KEY, ctx);
    if (permission) await this.authz.require(permission);
    return true;
  }

  /**
   * Workspace API keys. A key may only call routes that declare a permission, and only when that permission is
   * one of its scopes; everything else (your profile, sessions, settings) is closed to keys. It then acts as its
   * creator, so their current access and the workspace's plan still apply.
   */
  private async apiKey(token: string, req: Request, ctx: ExecutionContext): Promise<boolean> {
    const key = await this.apiKeys.authenticate(token, req.ip);
    if (!key) throw Errors.unauthorized('This API key is not valid. It may have been revoked or have expired.');
    if (key.tenantStatus !== 'active') throw Errors.tenantSuspended();
    const permission = this.meta<string>(PERMISSION_KEY, ctx);
    if (!permission || !key.scopes.includes(permission)) {
      throw Errors.forbidden(permission ? `This API key does not have the ${permission} scope` : 'This route cannot be used with an API key');
    }
    requestContext.setActor({ kind: 'user', userId: key.userId, tenantId: key.tenantId, membershipId: key.membershipId, sessionId: `api_key:${key.id}`, mfa: false, label: key.label, apiKey: { id: key.id, scopes: key.scopes } });
    const feature = this.meta<string>(FEATURE_KEY, ctx);
    if (feature) await this.entitlements.requireFeature(feature);
    await this.authz.require(permission);
    return true;
  }

  /**
   * SCIM provisioning. The token belongs to a workspace and acts as the owner who created it; it works only on
   * SCIM routes, only while that owner is active and only while the plan includes single sign-on.
   */
  private async scim(token: string): Promise<boolean> {
    const t = await this.scimTokens.authenticate(token);
    if (!t) throw Errors.unauthorized('This SCIM token is not valid. It may have been revoked.');
    if (t.tenantStatus !== 'active') throw Errors.tenantSuspended();
    requestContext.setActor({ kind: 'user', userId: t.userId, tenantId: t.tenantId, membershipId: t.membershipId, sessionId: `scim:${t.id}`, mfa: false, label: `SCIM provisioning (token ${t.prefix}, created by ${t.createdBy})` });
    await this.entitlements.requireFeature('sso');
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
