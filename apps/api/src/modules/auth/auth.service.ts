import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { LoginResponse, MeResponse, SignupRequest, TokenPair } from '@crew/contracts';
import { provisionTenant, SlugTakenError } from '@crew/db';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField, hashPassword, randomToken, sha256, verifyPassword } from '../../platform/auth/crypto';
import { generateMfaSecret, mfaUri, verifyTotp } from '../../platform/auth/mfa';
import { TokenService } from '../../platform/auth/token.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { effectivePermissions } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { AppError, Errors } from '../../platform/http/errors';
import { SsoService, type SsoResult } from '../identity/sso.service';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

type Client = 'web' | 'mobile' | 'api';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string | null;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  status: string;
  locked_until: Date | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly authz: AuthzService,
    private readonly entitlements: EntitlementsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sso: SsoService,
  ) {}

  // ---------------------------------------------------------------------------
  // Sign up: creates a tenant, its owner and a trial subscription
  // ---------------------------------------------------------------------------
  async signup(input: SignupRequest, client: Client): Promise<TokenPair & { tenantId: string }> {
    const passwordHash = await hashPassword(input.password);
    const result = await this.db.platform(async (tx) => {
      if (await one(tx, 'select 1 from users where email = $1', [input.email])) {
        throw Errors.conflict('account_exists', 'An account with this email already exists. Sign in to create another workspace.');
      }
      try {
        const t = await provisionTenant(tx, {
          name: input.companyName,
          slug: input.slug,
          countryCode: input.countryCode,
          currency: input.currency,
          timezone: input.timezone,
          owner: { email: input.email, fullName: input.fullName, passwordHash },
          plan: { key: 'professional', seats: 10, billingCycle: 'monthly', trialDays: 14 },
        });
        await this.audit.record(tx, { tenantId: t.tenantId, action: 'tenant.created', resourceType: 'tenant', resourceId: t.tenantId, metadata: { via: 'self_signup', plan: 'professional', trialDays: 14 } });
        await this.outbox.publish(tx, t.tenantId, 'tenant.created', { tenantId: t.tenantId, ownerUserId: t.ownerUserId });
        const pair = await this.issueSession(tx, { userId: t.ownerUserId, tenantId: t.tenantId, membershipId: t.ownerMembershipId, mfa: false, client });
        return { ...pair, tenantId: t.tenantId };
      } catch (e) {
        if (e instanceof SlugTakenError) throw Errors.conflict('slug_taken', e.message);
        throw e;
      }
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Login: password -> (MFA) -> (tenant picker) -> session
  // ---------------------------------------------------------------------------
  async login(email: string, password: string, tenantSlug: string | undefined, client: Client): Promise<LoginResponse> {
    const user = await this.db.platform((tx) => one<UserRow>(tx, 'select * from users where email = $1', [email]));
    if (user?.locked_until && user.locked_until > new Date()) throw Errors.tooMany('Too many failed sign-in attempts. Try again in a few minutes.');
    const ok = await verifyPassword(user?.password_hash ?? null, password);
    if (!user || !ok || user.status !== 'active') {
      if (user) await this.recordFailedLogin(user.id);
      throw Errors.unauthorized('Email or password is incorrect');
    }
    await this.db.platform((tx) => tx.query('update users set failed_login_count = 0, locked_until = null where id = $1', [user.id]));

    if (user.mfa_enabled) {
      return { status: 'mfa_required', mfaToken: await this.tokens.signStep({ sub: user.id, purpose: 'mfa', tenantSlug, client }) };
    }
    return this.afterPrimaryAuth(user.id, tenantSlug, false, client);
  }

  async verifyMfa(mfaToken: string, code: string): Promise<LoginResponse> {
    const step = await this.tokens.verifyStep(mfaToken, 'mfa').catch(() => {
      throw Errors.unauthorized('The verification step expired. Sign in again.');
    });
    const user = await this.db.platform((tx) => one<UserRow>(tx, 'select * from users where id = $1', [step.sub]));
    if (!user?.mfa_secret_enc || !user.mfa_enabled) throw Errors.unauthorized();
    if (user.locked_until && user.locked_until > new Date()) throw Errors.tooMany();
    if (!verifyTotp(decryptField(user.mfa_secret_enc, this.config.fieldKeys), code)) {
      await this.recordFailedLogin(user.id);
      throw Errors.unauthorized('That code is not valid. Check your authenticator app and try again.');
    }
    return this.afterPrimaryAuth(user.id, step.tenantSlug, true, (step.client as Client) ?? 'web');
  }

  async selectTenant(selectToken: string, tenantId: string): Promise<LoginResponse> {
    const step = await this.tokens.verifyStep(selectToken, 'select_tenant').catch(() => {
      throw Errors.unauthorized('The sign-in step expired. Sign in again.');
    });
    const memberships = await this.activeMemberships(step.sub);
    const m = memberships.find((x) => x.tenant_id === tenantId);
    if (!m) throw Errors.forbidden('You are not a member of that workspace');
    const pair = await this.db.platform((tx) => this.issueSession(tx, { userId: step.sub, tenantId, membershipId: m.membership_id, mfa: step.mfa ?? false, client: (step.client as Client) ?? 'web' }));
    return { status: 'ok', ...pair };
  }

  private async afterPrimaryAuth(userId: string, tenantSlug: string | undefined, mfa: boolean, client: Client): Promise<LoginResponse> {
    const all = await this.activeMemberships(userId);
    if (!all.length) throw Errors.forbidden('Your account is not active in any workspace');
    // Workspaces that require single sign-on take members (other than owners) through their identity provider instead.
    const blocked = new Set<string>();
    await this.db.platform(async (tx) => {
      for (const m of all) if (await this.sso.passwordBlocked(tx, m.tenant_id, m.membership_id)) blocked.add(m.tenant_id);
    });
    const memberships = all.filter((m) => !blocked.has(m.tenant_id));
    if (!memberships.length || (tenantSlug && all.some((m) => m.slug === tenantSlug && blocked.has(m.tenant_id)))) {
      throw new AppError(HttpStatus.FORBIDDEN, 'sso_required', 'Your organisation signs in with single sign-on. Use "Sign in with single sign-on" and your work email.');
    }
    let chosen = tenantSlug ? memberships.find((m) => m.slug === tenantSlug) : memberships.length === 1 ? memberships[0] : undefined;
    if (tenantSlug && !chosen) throw Errors.forbidden('You are not a member of that workspace');
    if (!chosen) {
      return {
        status: 'select_tenant',
        tenants: memberships.map((m) => ({ id: m.tenant_id, name: m.name, slug: m.slug })),
        selectToken: await this.tokens.signStep({ sub: userId, purpose: 'select_tenant', mfa, client }),
      };
    }
    const pair = await this.db.platform((tx) => this.issueSession(tx, { userId, tenantId: chosen!.tenant_id, membershipId: chosen!.membership_id, mfa, client }));
    return { status: 'ok', ...pair };
  }

  private activeMemberships(userId: string) {
    return this.db.platform((tx) =>
      many<{ membership_id: string; tenant_id: string; name: string; slug: string }>(
        tx,
        `select m.id as membership_id, t.id as tenant_id, t.name, t.slug::text
           from memberships m join tenants t on t.id = m.tenant_id
          where m.user_id = $1 and m.status = 'active' and t.status = 'active'
          order by t.name`,
        [userId],
      ),
    );
  }

  private async recordFailedLogin(userId: string) {
    await this.db.platform(async (tx) => {
      await tx.query(
        `update users set failed_login_count = failed_login_count + 1,
                locked_until = case when failed_login_count + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
          where id = $1`,
        [userId, MAX_FAILED_LOGINS, LOCK_MINUTES],
      );
      await this.audit.record(tx, { tenantId: null, action: 'auth.login_failed', resourceType: 'user', resourceId: userId });
    });
  }

  /** Finishes an OpenID Connect sign-in: a session for a member, a hand-off for the mobile app, or an owner's test result. */
  async ssoCallback(code: string, state: string) {
    return this.ssoResult(await this.sso.callback(code, state));
  }

  /** Finishes a SAML sign-in from the identity provider's HTTP-POST response. */
  async ssoSamlCallback(samlResponse: string, relayState: string) {
    return this.ssoResult(await this.sso.samlCallback(samlResponse, relayState));
  }

  /** The mobile app collects its session with the one-time code and the verifier behind the challenge it started with. */
  async ssoExchange(code: string, verifier: string): Promise<LoginResponse> {
    const h = await this.sso.exchange(code, verifier);
    return this.ssoSession({ ...h, client: 'mobile' });
  }

  private async ssoResult(r: SsoResult): Promise<LoginResponse | { status: 'sso_test_passed'; email: string } | { status: 'mobile_handoff'; redirectTo: string }> {
    if (r.kind === 'test') return { status: 'sso_test_passed', email: r.email };
    if (r.kind === 'handoff') return { status: 'mobile_handoff', redirectTo: r.redirectTo };
    return this.ssoSession(r);
  }

  private async ssoSession(r: { userId: string; tenantId: string; membershipId: string; mfa: boolean; client: Client }): Promise<LoginResponse> {
    const pair = await this.db.platform(async (tx) => {
      const p = await this.issueSession(tx, { userId: r.userId, tenantId: r.tenantId, membershipId: r.membershipId, mfa: r.mfa, client: r.client });
      await this.audit.record(tx, { tenantId: r.tenantId, action: 'auth.sso_login', resourceType: 'membership', resourceId: r.membershipId, metadata: { mfaAtProvider: r.mfa, client: r.client } });
      return p;
    });
    return { status: 'ok', ...pair };
  }

  /** Creates a session row (refresh token stored as a hash) and returns a signed access token. */
  private async issueSession(
    tx: Tx,
    s: { userId: string; tenantId: string; membershipId: string; mfa: boolean; client: Client; familyId?: string },
  ): Promise<TokenPair> {
    // SAMPLEDGE can switch the Web Portal or the mobile app off for a workspace (Console > Features & permissions > Apps).
    if (s.client === 'web' || s.client === 'mobile') {
      const apps = await one<{ web: boolean; mobile: boolean }>(tx, 'select web_portal_enabled as web, mobile_app_enabled as mobile from tenant_access_controls where tenant_id = $1', [s.tenantId]);
      if (apps && !apps[s.client]) throw Errors.appSwitchedOff(s.client);
    }
    const refreshToken = randomToken(32);
    const ctx = requestContext.get();
    const session = await one<{ id: string }>(
      tx,
      `insert into sessions (user_id, tenant_id, refresh_token_hash, family_id, mfa_verified, client, ip, user_agent, expires_at)
       values ($1, $2, $3, coalesce($4::uuid, gen_random_uuid()), $5, $6, $7, $8, now() + make_interval(days => $9)) returning id`,
      [s.userId, s.tenantId, sha256(refreshToken), s.familyId ?? null, s.mfa, s.client, ctx?.ip ?? null, ctx?.userAgent?.slice(0, 400) ?? null, this.config.REFRESH_TOKEN_TTL_DAYS],
    );
    if (!s.familyId) {
      await tx.query('update users set last_login_at = now() where id = $1', [s.userId]);
      await tx.query(`update memberships set joined_at = coalesce(joined_at, now()) where id = $1`, [s.membershipId]);
      await this.audit.record(tx, { tenantId: s.tenantId, action: 'auth.login', resourceType: 'session', resourceId: session!.id, metadata: { client: s.client, mfa: s.mfa } });
    }
    const accessToken = await this.tokens.signAccess({ sub: s.userId, tid: s.tenantId, mid: s.membershipId, sid: session!.id, mfa: s.mfa });
    return { accessToken, refreshToken, expiresIn: this.tokens.accessTtl };
  }

  /**
   * Rotates the refresh token. Presenting an already-rotated token means it was stolen or replayed, so the
   * whole session family is revoked.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    return this.db.platform(async (tx) => {
      const s = await one<{ id: string; user_id: string; tenant_id: string; family_id: string; mfa_verified: boolean; client: Client; expires_at: Date; rotated_at: Date | null; revoked_at: Date | null }>(
        tx,
        'select * from sessions where refresh_token_hash = $1 for update',
        [sha256(refreshToken)],
      );
      if (!s) throw Errors.unauthorized();
      if (s.rotated_at) {
        await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'refresh_token_reuse' where family_id = $1 and revoked_at is null`, [s.family_id]);
        await this.audit.record(tx, { tenantId: s.tenant_id, action: 'auth.refresh_reuse_detected', resourceType: 'session', resourceId: s.id });
        // Commit the revocation, then reject.
        return null;
      }
      if (s.revoked_at || s.expires_at < new Date()) throw Errors.unauthorized('Your session has ended. Sign in again.');
      const m = await one<{ id: string }>(
        tx,
        `select m.id from memberships m join tenants t on t.id = m.tenant_id join users u on u.id = m.user_id
          where m.user_id = $1 and m.tenant_id = $2 and m.status = 'active' and t.status = 'active' and u.status = 'active'`,
        [s.user_id, s.tenant_id],
      );
      if (!m) throw Errors.unauthorized('Your access to this workspace has changed. Sign in again.');
      await tx.query('update sessions set rotated_at = now(), revoked_at = now(), revoked_reason = $2 where id = $1', [s.id, 'rotated']);
      return this.issueSession(tx, { userId: s.user_id, tenantId: s.tenant_id, membershipId: m.id, mfa: s.mfa_verified, client: s.client, familyId: s.family_id });
    }).then((r) => {
      if (!r) throw Errors.unauthorized('This session was revoked for your security. Sign in again.');
      return r;
    });
  }

  async logout(): Promise<void> {
    const actor = requestContext.tenantActor();
    await this.db.platform(async (tx) => {
      await tx.query(
        `update sessions set revoked_at = now(), revoked_reason = 'logout'
          where family_id = (select family_id from sessions where id = $1) and revoked_at is null`,
        [actor.sessionId],
      );
      await this.audit.record(tx, { tenantId: actor.tenantId, action: 'auth.logout', resourceType: 'session', resourceId: actor.sessionId });
    });
  }

  async switchTenant(tenantId: string): Promise<TokenPair> {
    const actor = requestContext.tenantActor();
    const memberships = await this.activeMemberships(actor.userId);
    const target = memberships.find((m) => m.tenant_id === tenantId);
    if (!target) throw Errors.forbidden('You are not a member of that workspace');
    return this.db.platform((tx) => this.issueSession(tx, { userId: actor.userId, tenantId, membershipId: target.membership_id, mfa: actor.mfa, client: 'web' }));
  }

  // ---------------------------------------------------------------------------
  // Current user
  // ---------------------------------------------------------------------------
  async me(): Promise<MeResponse> {
    const actor = requestContext.tenantActor();
    const data = await this.db.tenant(async (tx) => {
      const user = await one<{ id: string; email: string; full_name: string; mfa_enabled: boolean }>(tx, 'select id, email::text, full_name, mfa_enabled from users where id = $1', [actor.userId]);
      const tenant = await one<{ id: string; name: string; slug: string; is_demo: boolean; status: string; timezone: string; currency: string; locale: string }>(
        tx,
        'select id, name, slug::text, is_demo, status, timezone, currency, locale from tenants where id = $1',
        [actor.tenantId],
      );
      const membership = await one<{ id: string; status: string }>(tx, 'select id, status from memberships where id = $1', [actor.membershipId]);
      const roles = await many<{ key: string; name: string }>(tx, 'select r.key, r.name from role_assignments ra join roles r on r.id = ra.role_id where ra.membership_id = $1 order by r.name', [actor.membershipId]);
      const subject = await this.authz.subject(tx);
      const ent = await this.entitlements.current(tx);
      const controls = await one<{ disabled_permissions: string[] }>(tx, 'select disabled_permissions from tenant_access_controls');
      return { user, tenant, membership, roles, subject, ent, disabledPermissions: controls?.disabled_permissions ?? [] };
    });
    // Workspace switcher: runs outside the tenant so RLS shows only this user's own memberships.
    const tenants = await this.db.user(actor.userId, (tx) =>
      many<{ id: string; name: string; slug: string }>(
        tx,
        `select t.id, t.name, t.slug::text from memberships m join tenants t on t.id = m.tenant_id
          where m.user_id = $1 and m.status = 'active' and t.status = 'active' order by t.name`,
        [actor.userId],
      ),
    );
    return {
      user: { id: data.user!.id, email: data.user!.email, fullName: data.user!.full_name, mfaEnabled: data.user!.mfa_enabled },
      tenant: { id: data.tenant!.id, name: data.tenant!.name, slug: data.tenant!.slug, isDemo: data.tenant!.is_demo, status: data.tenant!.status, timezone: data.tenant!.timezone, currency: data.tenant!.currency, locale: data.tenant!.locale },
      membership: { id: data.membership!.id, status: data.membership!.status, roles: data.roles },
      permissions: effectivePermissions(data.subject),
      features: [...data.ent.features].sort(),
      featureBlocks: data.ent.blocked,
      disabledPermissions: data.disabledPermissions,
      limits: data.ent.limits,
      subscription: data.ent.planKey ? { plan: data.ent.planKey, status: data.ent.status!, trialEndsOn: data.ent.trialEndsOn } : null,
      session: { mfa: actor.mfa },
      client: actor.client ?? 'web',
      tenants,
    };
  }

  async sessions() {
    const actor = requestContext.tenantActor();
    return this.db.platform((tx) =>
      many(
        tx,
        `select id, client, host(ip) as ip, user_agent as "userAgent", created_at as "createdAt", expires_at as "expiresAt", (id = $2) as current
           from sessions where user_id = $1 and tenant_id = $3 and revoked_at is null and expires_at > now() order by created_at desc`,
        [actor.userId, actor.sessionId, actor.tenantId],
      ),
    );
  }

  async revokeSession(sessionId: string) {
    const actor = requestContext.tenantActor();
    await this.db.platform(async (tx) => {
      const r = await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'user_revoked' where id = $1 and user_id = $2 and revoked_at is null`, [sessionId, actor.userId]);
      if (!r.rowCount) throw Errors.notFound('Session');
      await this.audit.record(tx, { tenantId: actor.tenantId, action: 'auth.session_revoked', resourceType: 'session', resourceId: sessionId });
    });
  }

  // ---------------------------------------------------------------------------
  // MFA enrolment
  // ---------------------------------------------------------------------------
  async mfaSetup(): Promise<{ secret: string; otpauthUri: string }> {
    const actor = requestContext.tenantActor();
    return this.db.platform(async (tx) => {
      const user = await one<{ email: string; mfa_enabled: boolean }>(tx, 'select email::text, mfa_enabled from users where id = $1', [actor.userId]);
      if (user!.mfa_enabled) throw Errors.conflict('mfa_already_enabled', 'Multi-factor authentication is already on');
      const secret = generateMfaSecret();
      await tx.query('update users set mfa_secret_enc = $2 where id = $1', [actor.userId, encryptField(secret, this.config.fieldKeys)]);
      return { secret, otpauthUri: mfaUri(user!.email, secret) };
    });
  }

  /** Confirms enrolment with a first code and upgrades the current session to MFA-verified. */
  async mfaEnable(code: string): Promise<TokenPair> {
    const actor = requestContext.tenantActor();
    return this.db.platform(async (tx) => {
      const user = await one<{ mfa_secret_enc: string | null; mfa_enabled: boolean }>(tx, 'select mfa_secret_enc, mfa_enabled from users where id = $1', [actor.userId]);
      if (!user?.mfa_secret_enc) throw Errors.badRequest('mfa_not_started', 'Start MFA setup first');
      if (!verifyTotp(decryptField(user.mfa_secret_enc, this.config.fieldKeys), code)) throw Errors.badRequest('invalid_code', 'That code is not valid');
      await tx.query('update users set mfa_enabled = true where id = $1', [actor.userId]);
      await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'mfa_upgraded' where id = $1`, [actor.sessionId]);
      await this.audit.record(tx, { tenantId: actor.tenantId, action: 'auth.mfa_enabled', resourceType: 'user', resourceId: actor.userId });
      return this.issueSession(tx, { userId: actor.userId, tenantId: actor.tenantId, membershipId: actor.membershipId, mfa: true, client: 'web' });
    });
  }

  async changePassword(currentPassword: string, newPassword: string) {
    const actor = requestContext.tenantActor();
    const user = await this.db.platform((tx) => one<{ password_hash: string | null }>(tx, 'select password_hash from users where id = $1', [actor.userId]));
    if (!(await verifyPassword(user?.password_hash ?? null, currentPassword))) throw Errors.badRequest('wrong_password', 'Your current password is incorrect');
    const hash = await hashPassword(newPassword);
    await this.db.platform(async (tx) => {
      await tx.query('update users set password_hash = $2 where id = $1', [actor.userId, hash]);
      // Sign out every other session.
      await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'password_changed' where user_id = $1 and id <> $2 and revoked_at is null`, [actor.userId, actor.sessionId]);
      await this.audit.record(tx, { tenantId: actor.tenantId, action: 'auth.password_changed', resourceType: 'user', resourceId: actor.userId });
    });
  }

  // ---------------------------------------------------------------------------
  // Invitations
  // ---------------------------------------------------------------------------
  async invitationPreview(token: string) {
    const inv = await this.findInvitation(token);
    return { email: inv.email, tenantName: inv.tenant_name, fullName: inv.full_name, existingAccount: inv.has_password };
  }

  async acceptInvitation(token: string, fullName: string, password: string, client: Client): Promise<TokenPair> {
    const inv = await this.findInvitation(token);
    let newHash: string | null = null;
    if (inv.has_password) {
      const user = await this.db.platform((tx) => one<{ password_hash: string }>(tx, 'select password_hash from users where id = $1', [inv.user_id]));
      if (!(await verifyPassword(user!.password_hash, password))) throw Errors.unauthorized('You already have a CREW account. Enter its password to join this workspace.');
    } else {
      newHash = await hashPassword(password);
    }
    return this.db.platform(async (tx) => {
      if (newHash) await tx.query('update users set password_hash = $2, full_name = $3, email_verified_at = now() where id = $1', [inv.user_id, newHash, fullName]);
      await tx.query(`update memberships set status = 'active', joined_at = now() where id = $1`, [inv.membership_id]);
      await tx.query('update invitations set accepted_at = now() where id = $1', [inv.id]);
      await tx.query(`select set_config('app.tenant_id', $1, true)`, [inv.tenant_id]);
      await this.audit.record(tx, { tenantId: inv.tenant_id, action: 'membership.activated', resourceType: 'membership', resourceId: inv.membership_id, metadata: { via: 'invitation' } });
      await this.outbox.publish(tx, inv.tenant_id, 'membership.activated', { membershipId: inv.membership_id, userId: inv.user_id });
      return this.issueSession(tx, { userId: inv.user_id, tenantId: inv.tenant_id, membershipId: inv.membership_id, mfa: false, client });
    });
  }

  private async findInvitation(token: string) {
    const inv = await this.db.platform((tx) =>
      one<{ id: string; tenant_id: string; membership_id: string; email: string; tenant_name: string; full_name: string; user_id: string; has_password: boolean }>(
        tx,
        `select i.id, i.tenant_id, i.membership_id, i.email::text, t.name as tenant_name, u.full_name, u.id as user_id, (u.password_hash is not null) as has_password
           from invitations i
           join tenants t on t.id = i.tenant_id and t.status = 'active'
           join memberships m on m.id = i.membership_id and m.status = 'invited'
           join users u on u.id = m.user_id
          where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()`,
        [sha256(token)],
      ),
    );
    if (!inv) throw Errors.notFound('Invitation (it may have expired or already been used)');
    return inv;
  }
}
