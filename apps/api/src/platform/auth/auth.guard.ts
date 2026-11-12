import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_PREFIX, PLATFORM_ROLE_CAPABILITIES, type PlatformRole } from '@crew/contracts';
import type { Request } from 'express';
import { AuthzService } from '../authz/authz.service';
import { ALLOW_PENDING_PASSWORD_KEY, ALLOW_WHEN_LOCKED_KEY, ALLOW_WITHOUT_MFA_KEY, FEATURE_KEY, PERMISSION_KEY, PUBLIC_KEY, REALM_KEY } from '../authz/decorators';
import { requestContext } from '../context/request-context';
import { MongoService as DatabaseService } from '../database/mongo.service';
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
    if (realm?.realm === 'platform') return this.platform(token, realm.capability, allowWithoutMfa, this.meta<boolean>(ALLOW_PENDING_PASSWORD_KEY, ctx) ?? false);
    if (realm?.realm === 'scim') return this.scim(token);
    if (token.startsWith(API_KEY_PREFIX)) return this.apiKey(token, req, ctx);

    const claims = await this.tokens.verifyAccess(token).catch(() => {
      throw Errors.unauthorized('Your session has expired. Sign in again.');
    });
    const row = await this.db.platform(async (tx) => {
      const session = await tx.collection('sessions').findOne({ id: claims.sid, user_id: claims.sub, tenant_id: claims.tid });
      if (!session) return undefined;
      const membership = await tx.collection('memberships').findOne({ id: claims.mid, user_id: session.user_id, tenant_id: claims.tid });
      const tenant = membership && (await tx.collection('tenants').findOne({ id: membership.tenant_id }));
      const user = tenant && (await tx.collection('users').findOne({ id: session.user_id, status: 'active' }));
      if (!membership || !tenant || !user) return undefined;
      const controls = await tx.collection('tenant_access_controls').findOne({ tenant_id: tenant.id });
      const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenant.id }, { projection: { locked_at: 1 } });
      return {
        session_ok: !session.revoked_at && session.expires_at > new Date(),
        membership_status: membership.status as string,
        tenant_status: tenant.status as string,
        require_mfa: tenant.require_mfa as boolean,
        full_name: user.full_name as string,
        email: user.email as string,
        client: session.client as 'web' | 'mobile' | 'api',
        web_on: controls?.web_portal_enabled ?? true,
        mobile_on: controls?.mobile_app_enabled ?? true,
        locked: Boolean(sub?.locked_at),
      };
    });
    if (!row?.session_ok || row.membership_status !== 'active') throw Errors.unauthorized('Your session is no longer valid. Sign in again.');
    if (row.tenant_status !== 'active') throw Errors.tenantSuspended();
    // An app SAMPLEDGE switched off for the workspace is closed on every request, not only at sign-in.
    if ((row.client === 'web' && !row.web_on) || (row.client === 'mobile' && !row.mobile_on)) throw Errors.appSwitchedOff(row.client);

    requestContext.setActor({ kind: 'user', userId: claims.sub, tenantId: claims.tid, membershipId: claims.mid, sessionId: claims.sid, mfa: claims.mfa, client: row.client, label: `${row.full_name} <${row.email}>` });

    if (row.require_mfa && !claims.mfa && !allowWithoutMfa) throw Errors.mfaRequired();
    if (row.locked) this.readOnly(req, ctx);

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
    if (await this.db.platform((tx) => tx.collection('subscriptions').exists({ tenant_id: key.tenantId, locked_at: { $ne: null } }))) this.readOnly(req, ctx);
    const feature = this.meta<string>(FEATURE_KEY, ctx);
    if (feature) await this.entitlements.requireFeature(feature);
    await this.authz.require(permission);
    return true;
  }

  /** While a workspace is read-only for an unpaid invoice, only reads (and billing, sign-out, own security) go through. */
  private readOnly(req: Request, ctx: ExecutionContext) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (this.meta<boolean>(ALLOW_WHEN_LOCKED_KEY, ctx)) return;
    throw Errors.workspaceLocked();
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

  private async platform(token: string, capability: string | undefined, allowWithoutMfa: boolean, allowPendingPassword: boolean): Promise<boolean> {
    const claims = await this.tokens.verifyPlatform(token).catch(() => {
      throw Errors.unauthorized('Your console session has expired. Sign in again.');
    });
    const row = await this.db.platform(async (tx) => {
      const session = await tx.collection('platform_sessions').findOne({ id: claims.sid, admin_id: claims.sub });
      const admin = session && (await tx.collection('platform_admins').findOne({ id: claims.sub }));
      return admin
        ? { ok: !session!.revoked_at && session!.expires_at > new Date() && admin.status === 'active', email: admin.email as string, mustChangePassword: admin.must_change_password === true }
        : undefined;
    });
    if (!row?.ok) throw Errors.unauthorized('Your console session is no longer valid.');
    requestContext.setActor({ kind: 'platform_admin', adminId: claims.sub, role: claims.role, sessionId: claims.sid, mfa: claims.mfa, label: `SAMPLEDGE ${row.email}` });
    // MFA is mandatory for every platform action except enrolling MFA itself.
    if (!claims.mfa && !allowWithoutMfa) throw Errors.mfaRequired();
    // A temporary password (set by another admin or the recovery command) is replaced before anything else.
    if (row.mustChangePassword && !allowWithoutMfa && !allowPendingPassword) throw Errors.passwordChangeRequired();
    if (capability && !PLATFORM_ROLE_CAPABILITIES[claims.role as PlatformRole]?.includes(capability)) throw Errors.forbidden();
    return true;
  }
}
