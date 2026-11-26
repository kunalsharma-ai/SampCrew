import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_PREFIX, CONSOLE_DELETE_ACTIONS, CONSOLE_DELETE_PERMISSION, DELETE_AREA_INFO, deleteActionFor, partForApiPath, PLATFORM_ROLE_CAPABILITIES, WORKSPACE_DELETE_ACTIONS, type DeleteAction, type DeleteArea } from '@crew/contracts';
import { recordMobileUsage, requireMobileRoute } from '../entitlements/mobile-access';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthzService, routeSwitchedOff } from '../authz/authz.service';
import { ALLOW_PENDING_PASSWORD_KEY, ALLOW_WHEN_LOCKED_KEY, ALLOW_WITHOUT_MFA_KEY, FEATURE_KEY, PERMISSION_KEY, PUBLIC_KEY, REALM_KEY } from '../authz/decorators';
import { requestContext } from '../context/request-context';
import { MongoService as DatabaseService } from '../database/mongo.service';
import { EntitlementsService } from '../entitlements/entitlements.service';
import { Errors } from '../http/errors';
import { ApiKeysService } from '../../modules/integrations/api-keys.service';
import { ScimService } from '../../modules/identity/scim.service';
import { idleLimit, isIdle } from './idle';
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
    private readonly audit: AuditService,
  ) {}

  /** The last time each person was recorded being refused a permission, so a retrying screen writes one entry a minute. */
  private readonly deniedSeen = new Map<string, number>();

  /**
   * Records a refused change (POST, PUT, PATCH, DELETE) in the workspace's audit trail: who tried, which permission
   * they lacked and which route, as the hierarchy rules ask (an HR Workspace admin trying to create an HR Workspace,
   * an employee calling an admin route). Reads are not recorded. A failure to record never changes the answer.
   */
  private async recordDenied(req: Request, permission: string, error: unknown) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const code = (error as { code?: string; getResponse?: () => unknown })?.code ?? ((error as { getResponse?: () => { code?: string } })?.getResponse?.() as { code?: string } | undefined)?.code;
    if (code !== 'forbidden') return;
    const actor = requestContext.get()?.actor;
    if (actor?.kind !== 'user') return;
    const key = `${actor.membershipId}:${permission}:${req.method}:${req.route?.path ?? req.path}`;
    const now = Date.now();
    if ((this.deniedSeen.get(key) ?? 0) > now - 60_000) return;
    this.deniedSeen.set(key, now);
    if (this.deniedSeen.size > 5000) for (const [k, t] of this.deniedSeen) if (t < now - 60_000) this.deniedSeen.delete(k);
    await this.db.tenant((tx) => this.audit.record(tx, {
      action: 'authz.denied', resourceType: 'route', resourceId: null,
      metadata: { permission, method: req.method, route: req.route?.path ?? req.path },
    })).catch(() => undefined);
  }

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
    if (realm?.realm === 'platform') return this.platform(req, token, realm.capability, allowWithoutMfa, this.meta<boolean>(ALLOW_PENDING_PASSWORD_KEY, ctx) ?? false);
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
      const idle = await idleLimit(tx, tenant.id as string, session.client as string);
      const idleOut = !!idle && !session.revoked_at && isIdle(session.last_active_at as Date | null | undefined, idle);
      if (idleOut) await tx.collection('sessions').update({ family_id: session.family_id, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'idle_timeout' } });
      return {
        idle_out: idleOut,
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
    if (row?.idle_out) throw Errors.sessionIdle();
    if (!row?.session_ok || row.membership_status !== 'active') throw Errors.unauthorized('Your session is no longer valid. Sign in again.');
    if (row.tenant_status !== 'active') throw Errors.tenantSuspended();
    // An app SAMPLEDGE switched off for the workspace is closed on every request, not only at sign-in.
    if ((row.client === 'web' && !row.web_on) || (row.client === 'mobile' && !row.mobile_on)) throw Errors.appSwitchedOff(row.client);

    requestContext.setActor({ kind: 'user', userId: claims.sub, tenantId: claims.tid, membershipId: claims.mid, sessionId: claims.sid, mfa: claims.mfa, client: row.client, label: `${row.full_name} <${row.email}>` });

    if (row.require_mfa && !claims.mfa && !allowWithoutMfa) throw Errors.mfaRequired();
    if (row.locked) this.readOnly(req, ctx);

    const feature = this.meta<string>(FEATURE_KEY, ctx);
    if (feature) await this.entitlements.requireFeature(feature);
    await this.requirePart(req);
    // The phone shows only what the Super Workspace published for the mobile app; routes of a hidden module stay
    // closed to phones even when called directly. The Web Portal is never affected.
    if (row.client === 'mobile') {
      const used = await this.db.tenant((tx) => requireMobileRoute(tx, claims.mid, apiPath(req), req.method));
      if (used) await this.db.tenant((tx) => recordMobileUsage(tx, claims.mid, used)).catch(() => undefined);
    }

    const permission = this.meta<string>(PERMISSION_KEY, ctx);
    if (permission) {
      try {
        await this.authz.require(permission);
      } catch (e) {
        await this.recordDenied(req, permission, e);
        throw e;
      }
    }
    await this.requireRouteOn(req);
    const del = deleteActionFor(WORKSPACE_DELETE_ACTIONS, apiPath(req), req.method, req.body);
    if (del) await this.requireDelete(req, del);
    return true;
  }

  /**
   * Password-confirmed, permission-gated deletion (contracts delete-permissions.ts). Runs last, after every other
   * check, so a refused request never uses up the typed password:
   *  1. the level above must have given the person's level this delete area (Console > Super Workspace > HR and
   *     Employee Workspace), else delete_not_permitted, audited as delete.denied;
   *  2. the session must hold a password confirmation from the last two minutes, which this delete uses up, else
   *     delete_password_required (the apps then ask for the password and send the delete again).
   * The delete is audited once it has run (DeleteAuditInterceptor).
   */
  private async requireDelete(req: Request, action: DeleteAction) {
    const s = await this.authz.subject();
    const area = DELETE_AREA_INFO[action.area as DeleteArea];
    if (!s.deleteAreas?.has(action.area)) {
      const isSuper = s.grants.some((g) => g.roleKey === 'super_workspace');
      const isHr = s.grants.some((g) => g.roleKey === 'hr_workspace');
      const message = isSuper
        ? `Console Admin has not allowed your Super Workspace to delete ${area.label.toLowerCase()}.`
        : `Your Super Workspace has not given ${isHr ? 'HR Workspace' : 'Employee Workspace'} permission to delete ${area.label.toLowerCase()}. Ask your Super Workspace to switch it on in Settings > Workspace Permissions.`;
      await this.db.tenant((tx) => this.audit.record(tx, {
        action: 'delete.denied', resourceType: 'delete_area', resourceId: null,
        metadata: { area: action.area, what: action.label, reason: 'not_permitted', method: req.method, route: req.route?.path ?? req.path, level: isSuper ? 'super' : isHr ? 'hr' : 'employee' },
      })).catch(() => undefined);
      throw Errors.deleteNotPermitted(message);
    }
    const actor = requestContext.tenantActor();
    if (actor.apiKey) throw Errors.deleteNotPermitted('Deleting needs a person to confirm with their password, so API keys cannot delete.');
    const used = await this.db.platform((tx) => tx.collection('sessions').updateOne(
      { id: actor.sessionId, delete_confirmed_until: { $gt: new Date() } }, { $set: { delete_confirmed_until: null } },
    ));
    if (!used) throw Errors.deletePasswordRequired(action.label);
    (req as Request & { crewDelete?: unknown }).crewDelete = { realm: 'workspace', area: action.area, label: action.label };
  }

  /** The Console: deleting needs records:delete and the admin's password, typed just before (one delete each). */
  private async requireConsoleDelete(req: Request, action: DeleteAction, permissions: readonly string[], sessionId: string) {
    if (!permissions.includes(CONSOLE_DELETE_PERMISSION)) {
      await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'delete.denied', resourceType: 'delete_area', resourceId: null, metadata: { what: action.label, reason: 'not_permitted', method: req.method, route: req.route?.path ?? req.path } })).catch(() => undefined);
      throw Errors.deleteNotPermitted('Your Console role does not include Delete records. Ask a Super Admin to add it in Roles & permissions.');
    }
    const used = await this.db.platform((tx) => tx.collection('platform_sessions').updateOne(
      { id: sessionId, delete_confirmed_until: { $gt: new Date() } }, { $set: { delete_confirmed_until: null } },
    ));
    if (!used) throw Errors.deletePasswordRequired(action.label);
    (req as Request & { crewDelete?: unknown }).crewDelete = { realm: 'console', area: action.area, label: action.label };
  }

  /** Settings > Workspace Permissions: a route switched off for the person's level is refused, also when called directly. */
  private async requireRouteOn(req: Request) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const s = await this.authz.subject();
    if (routeSwitchedOff(s, apiPath(req), req.method)) {
      const e = Errors.forbidden('Your Super Workspace has switched this off for your workspace in Settings > Workspace Permissions');
      await this.recordDenied(req, 'workspace_permissions', e);
      throw e;
    }
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
    await this.requirePart(req);
    await this.authz.require(permission);
    await this.requireRouteOn(req);
    const del = deleteActionFor(WORKSPACE_DELETE_ACTIONS, apiPath(req), req.method, req.body);
    if (del) await this.requireDelete(req, del);
    return true;
  }

  /**
   * Feature management below the module: a route that belongs to one page or button (FEATURE_PARTS `api`) is closed
   * while any level switched that page or button off, also when called directly.
   */
  private async requirePart(req: Request) {
    const part = partForApiPath(apiPath(req), req.method);
    if (part) await this.entitlements.requireFeature(part.key);
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

  private async platform(req: Request, token: string, capability: string | undefined, allowWithoutMfa: boolean, allowPendingPassword: boolean): Promise<boolean> {
    const claims = await this.tokens.verifyPlatform(token).catch(() => {
      throw Errors.unauthorized('Your console session has expired. Sign in again.');
    });
    const row = await this.db.platform(async (tx) => {
      const session = await tx.collection('platform_sessions').findOne({ id: claims.sid, admin_id: claims.sub });
      const admin = session && (await tx.collection('platform_admins').findOne({ id: claims.sub }));
      if (!admin) return undefined;
      // The role's permissions come from the database on every request, so a role or permission change applies to
      // signed-in admins at once. An archived custom role gives nothing; a built-in role missing its row (a database
      // not yet migrated) falls back to the built-in list.
      const role = String(admin.role);
      const roleRow = await tx.collection<{ permissions: string[]; archived_at: Date | null }>('platform_roles').findOne({ key: role });
      const permissions = roleRow ? (roleRow.archived_at ? [] : roleRow.permissions ?? []) : PLATFORM_ROLE_CAPABILITIES[role] ?? [];
      return { ok: !session!.revoked_at && session!.expires_at > new Date() && admin.status === 'active', email: admin.email as string, mustChangePassword: admin.must_change_password === true, role, permissions };
    });
    if (!row?.ok) throw Errors.unauthorized('Your console session is no longer valid.');
    requestContext.setActor({ kind: 'platform_admin', adminId: claims.sub, role: row.role, permissions: row.permissions, sessionId: claims.sid, mfa: claims.mfa, label: `SAMPLEDGE ${row.email}` });
    // MFA is mandatory for every platform action except enrolling MFA itself.
    if (!claims.mfa && !allowWithoutMfa) throw Errors.mfaRequired();
    // A temporary password (set by another admin or the recovery command) is replaced before anything else.
    if (row.mustChangePassword && !allowWithoutMfa && !allowPendingPassword) throw Errors.passwordChangeRequired();
    if (capability && !row.permissions.includes(capability)) {
      // Refused Console actions go into the audit log (status "denied"), so Security can show who tried what.
      await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'platform.permission_denied', resourceType: 'permission', resourceId: capability, metadata: { role: row.role } })).catch(() => undefined);
      throw Errors.forbidden();
    }
    const del = deleteActionFor(CONSOLE_DELETE_ACTIONS, apiPath(req), req.method, req.body);
    if (del) await this.requireConsoleDelete(req, del, row.permissions, claims.sid);
    return true;
  }
}

/** The request path after /api/v1/. */
function apiPath(req: Request) {
  return (req.path ?? '').replace(/^.*?\/api\/v\d+\//, '');
}
