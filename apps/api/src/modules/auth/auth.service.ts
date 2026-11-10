import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { LoginResponse, MeResponse, SignupRequest, TokenPair } from '@crew/contracts';
import { mongo } from '@crew/db';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField, hashPassword, randomToken, sha256, verifyPassword } from '../../platform/auth/crypto';
import { generateMfaSecret, mfaUri, verifyTotp } from '../../platform/auth/mfa';
import { TokenService } from '../../platform/auth/token.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { effectivePermissions } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
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
  must_change_password: boolean;
  email_verified_at?: Date | null;
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
      if (await tx.collection('users').exists({ email: input.email })) {
        throw Errors.conflict('account_exists', 'An account with this email already exists. Sign in to create another workspace.');
      }
      try {
        const t = await mongo.provisionTenantMongo(tx, {
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
        if (e instanceof mongo.SlugTakenError) throw Errors.conflict('slug_taken', e.message);
        throw e;
      }
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Login: password -> (MFA) -> (tenant picker) -> session
  // ---------------------------------------------------------------------------
  async login(email: string, password: string, tenantSlug: string | undefined, client: Client): Promise<LoginResponse> {
    const user = await this.db.platform((tx) => tx.collection<UserRow>('users').findOne({ email }));
    if (user?.locked_until && user.locked_until > new Date()) throw Errors.tooMany('Too many failed sign-in attempts. Try again in a few minutes.');
    const ok = await verifyPassword(user?.password_hash ?? null, password);
    if (!user || !ok || user.status !== 'active') {
      if (user) await this.recordFailedLogin(user.id);
      throw Errors.unauthorized('Email or password is incorrect');
    }
    await this.db.platform((tx) => tx.collection('users').updateOne({ id: user.id }, { $set: { failed_login_count: 0, locked_until: null } }));

    if (user.mfa_enabled) {
      return { status: 'mfa_required', mfaToken: await this.tokens.signStep({ sub: user.id, purpose: 'mfa', tenantSlug, client }) };
    }
    return this.afterPrimaryAuth(user.id, tenantSlug, false, client);
  }

  async verifyMfa(mfaToken: string, code: string): Promise<LoginResponse> {
    const step = await this.tokens.verifyStep(mfaToken, 'mfa').catch(() => {
      throw Errors.unauthorized('The verification step expired. Sign in again.');
    });
    const user = await this.db.platform((tx) => tx.collection<UserRow>('users').findOne({ id: step.sub }));
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

  /**
   * A login HR created with a temporary password: the person chooses their own password before any session is
   * issued. The step token carries what was already proven (password, and MFA if it was asked for).
   */
  async setInitialPassword(changeToken: string, newPassword: string): Promise<LoginResponse> {
    const step = await this.tokens.verifyStep(changeToken, 'password_change').catch(() => {
      throw Errors.unauthorized('The sign-in step expired. Sign in again with your temporary password.');
    });
    const user = await this.db.platform((tx) => tx.collection<UserRow>('users').findOne({ id: step.sub }));
    if (!user || user.status !== 'active' || !user.must_change_password) throw Errors.unauthorized('Sign in again.');
    if (await verifyPassword(user.password_hash, newPassword)) throw Errors.badRequest('same_password', 'Choose a password different from the temporary one');
    const hash = await hashPassword(newPassword);
    await this.db.platform(async (tx) => {
      await tx.collection('users').updateOne({ id: user.id }, { $set: { password_hash: hash, must_change_password: false, email_verified_at: user.email_verified_at ?? new Date() } });
      await this.audit.record(tx, { tenantId: null, action: 'auth.initial_password_set', resourceType: 'user', resourceId: user.id });
    });
    return this.afterPrimaryAuth(user.id, step.tenantSlug, step.mfa ?? false, (step.client as Client) ?? 'web');
  }

  private async afterPrimaryAuth(userId: string, tenantSlug: string | undefined, mfa: boolean, client: Client): Promise<LoginResponse> {
    const pending = await this.db.platform((tx) => tx.collection('users').findOne({ id: userId }, { projection: { must_change_password: 1 } }));
    if (pending?.must_change_password) {
      return { status: 'password_change_required', changeToken: await this.tokens.signStep({ sub: userId, purpose: 'password_change', tenantSlug, mfa, client }) };
    }
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
    return this.db.platform((tx) => activeMembershipsOf(tx, userId));
  }

  private async recordFailedLogin(userId: string) {
    await this.db.platform(async (tx) => {
      const users = tx.collection('users');
      const u = await users.findOne({ id: userId }, { projection: { failed_login_count: 1 } });
      const count = ((u?.failed_login_count as number) ?? 0) + 1;
      await users.updateOne({ id: userId }, { $set: { failed_login_count: count, ...(count >= MAX_FAILED_LOGINS ? { locked_until: new Date(Date.now() + LOCK_MINUTES * 60_000) } : {}) } });
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
    tx: PlatformTx,
    s: { userId: string; tenantId: string; membershipId: string; mfa: boolean; client: Client; familyId?: string },
  ): Promise<TokenPair> {
    // SAMPLEDGE can switch the Web Portal or the mobile app off for a workspace (Console > Features & permissions > Apps).
    if (s.client === 'web' || s.client === 'mobile') {
      const apps = await tx.collection('tenant_access_controls').findOne({ tenant_id: s.tenantId });
      if (apps && !(s.client === 'web' ? apps.web_portal_enabled : apps.mobile_app_enabled)) throw Errors.appSwitchedOff(s.client);
    }
    const refreshToken = randomToken(32);
    const ctx = requestContext.get();
    const session = await tx.collection('sessions').insert({
      user_id: s.userId,
      tenant_id: s.tenantId,
      refresh_token_hash: sha256(refreshToken),
      family_id: s.familyId ?? randomUUID(),
      mfa_verified: s.mfa,
      client: s.client,
      ip: ctx?.ip ?? null,
      user_agent: ctx?.userAgent?.slice(0, 400) ?? null,
      expires_at: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    });
    if (!s.familyId) {
      await tx.collection('users').updateOne({ id: s.userId }, { $set: { last_login_at: new Date() } });
      await tx.collection('memberships').updateOne({ id: s.membershipId, joined_at: null }, { $set: { joined_at: new Date() } });
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
      const s = await tx
        .collection<{ id: string; user_id: string; tenant_id: string; family_id: string; mfa_verified: boolean; client: Client; expires_at: Date; rotated_at: Date | null; revoked_at: Date | null }>('sessions')
        .findOne({ refresh_token_hash: sha256(refreshToken) });
      if (!s) throw Errors.unauthorized();
      if (s.rotated_at) {
        await tx.collection('sessions').update({ family_id: s.family_id, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'refresh_token_reuse' } });
        await this.audit.record(tx, { tenantId: s.tenant_id, action: 'auth.refresh_reuse_detected', resourceType: 'session', resourceId: s.id });
        // Commit the revocation, then reject.
        return null;
      }
      if (s.revoked_at || s.expires_at < new Date()) throw Errors.unauthorized('Your session has ended. Sign in again.');
      const m = (await activeMembershipsOf(tx, s.user_id)).find((x) => x.tenant_id === s.tenant_id && x.user_active);
      if (!m) throw Errors.unauthorized('Your access to this workspace has changed. Sign in again.');
      // Marking it rotated in this transaction means a second refresh with the same token conflicts and is retried,
      // then sees rotated_at and is treated as reuse (the row lock did this in PostgreSQL).
      await tx.collection('sessions').updateOne({ id: s.id }, { $set: { rotated_at: new Date(), revoked_at: new Date(), revoked_reason: 'rotated' } });
      return this.issueSession(tx, { userId: s.user_id, tenantId: s.tenant_id, membershipId: m.membership_id, mfa: s.mfa_verified, client: s.client, familyId: s.family_id });
    }).then((r) => {
      if (!r) throw Errors.unauthorized('This session was revoked for your security. Sign in again.');
      return r;
    });
  }

  async logout(): Promise<void> {
    const actor = requestContext.tenantActor();
    await this.db.platform(async (tx) => {
      const current = await tx.collection('sessions').findOne({ id: actor.sessionId }, { projection: { family_id: 1 } });
      if (current) await tx.collection('sessions').update({ family_id: current.family_id, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'logout' } });
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
      const user = await (await tx.users()).findOne({ id: actor.userId });
      const tenant = await tx.collection('tenants').findOne({});
      const membership = await tx.collection('memberships').findOne({ id: actor.membershipId });
      const roleIds = (await tx.collection('role_assignments').find({ membership_id: actor.membershipId })).map((a) => a.role_id);
      const roles = (await tx.collection('roles').find({ id: { $in: roleIds } }, { sort: { name: 1 } })).map((r) => ({ key: r.key as string, name: r.name as string }));
      const subject = await this.authz.subject(tx);
      const ent = await this.entitlements.current(tx);
      const controls = await tx.collection('tenant_access_controls').findOne({});
      const employee = await tx.collection('employees').findOne({ membership_id: actor.membershipId }, { projection: { _id: 1, photo_updated_at: 1 } });
      return { user, tenant, membership, roles, subject, ent, employee, disabledPermissions: (controls?.disabled_permissions as string[]) ?? [] };
    });
    // Workspace switcher: only this user's own active workspaces.
    const tenants = (await this.db.platform((tx) => activeMembershipsOf(tx, actor.userId))).map((m) => ({ id: m.tenant_id, name: m.name, slug: m.slug }));
    return {
      user: { id: data.user!.id, email: data.user!.email, fullName: data.user!.full_name, mfaEnabled: data.user!.mfa_enabled },
      tenant: { id: data.tenant!.id, name: data.tenant!.name, slug: data.tenant!.slug, isDemo: data.tenant!.is_demo, status: data.tenant!.status, timezone: data.tenant!.timezone, currency: data.tenant!.currency, locale: data.tenant!.locale, setupCompletedAt: data.tenant!.setup_completed_at?.toISOString() ?? null },
      membership: { id: data.membership!.id, status: data.membership!.status, roles: data.roles },
      permissions: effectivePermissions(data.subject),
      features: [...data.ent.features].sort(),
      featureBlocks: data.ent.blocked,
      disabledPermissions: data.disabledPermissions,
      limits: data.ent.limits,
      subscription: data.ent.planKey ? { plan: data.ent.planKey, status: data.ent.status!, trialEndsOn: data.ent.trialEndsOn, locked: data.ent.locked } : null,
      session: { mfa: actor.mfa },
      client: actor.client ?? 'web',
      tenants,
      employee: data.employee ? { id: data.employee.id, photoUpdatedAt: data.employee.photo_updated_at?.toISOString() ?? null } : null,
    };
  }

  async sessions() {
    const actor = requestContext.tenantActor();
    const now = new Date();
    const rows = await this.db.platform((tx) =>
      tx.collection('sessions').find({ user_id: actor.userId, tenant_id: actor.tenantId, revoked_at: null, expires_at: { $gt: now } }, { sort: { created_at: -1 } }),
    );
    return rows.map((r) => ({ id: r.id, client: r.client, ip: r.ip ?? null, userAgent: r.user_agent ?? null, createdAt: r.created_at, expiresAt: r.expires_at, current: r.id === actor.sessionId }));
  }

  async revokeSession(sessionId: string) {
    const actor = requestContext.tenantActor();
    await this.db.platform(async (tx) => {
      const n = await tx.collection('sessions').updateOne({ id: sessionId, user_id: actor.userId, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'user_revoked' } });
      if (!n) throw Errors.notFound('Session');
      await this.audit.record(tx, { tenantId: actor.tenantId, action: 'auth.session_revoked', resourceType: 'session', resourceId: sessionId });
    });
  }

  // ---------------------------------------------------------------------------
  // MFA enrolment
  // ---------------------------------------------------------------------------
  async mfaSetup(): Promise<{ secret: string; otpauthUri: string }> {
    const actor = requestContext.tenantActor();
    return this.db.platform(async (tx) => {
      const user = await tx.collection('users').findOne({ id: actor.userId });
      if (user!.mfa_enabled) throw Errors.conflict('mfa_already_enabled', 'Multi-factor authentication is already on');
      const secret = generateMfaSecret();
      await tx.collection('users').updateOne({ id: actor.userId }, { $set: { mfa_secret_enc: encryptField(secret, this.config.fieldKeys) } });
      return { secret, otpauthUri: mfaUri(user!.email, secret) };
    });
  }

  /** Confirms enrolment with a first code and upgrades the current session to MFA-verified. */
  async mfaEnable(code: string): Promise<TokenPair> {
    const actor = requestContext.tenantActor();
    return this.db.platform(async (tx) => {
      const user = await tx.collection('users').findOne({ id: actor.userId });
      if (!user?.mfa_secret_enc) throw Errors.badRequest('mfa_not_started', 'Start MFA setup first');
      if (!verifyTotp(decryptField(user.mfa_secret_enc, this.config.fieldKeys), code)) throw Errors.badRequest('invalid_code', 'That code is not valid');
      await tx.collection('users').updateOne({ id: actor.userId }, { $set: { mfa_enabled: true } });
      await tx.collection('sessions').updateOne({ id: actor.sessionId }, { $set: { revoked_at: new Date(), revoked_reason: 'mfa_upgraded' } });
      await this.audit.record(tx, { tenantId: actor.tenantId, action: 'auth.mfa_enabled', resourceType: 'user', resourceId: actor.userId });
      return this.issueSession(tx, { userId: actor.userId, tenantId: actor.tenantId, membershipId: actor.membershipId, mfa: true, client: 'web' });
    });
  }

  async changePassword(currentPassword: string, newPassword: string) {
    const actor = requestContext.tenantActor();
    const user = await this.db.platform((tx) => tx.collection('users').findOne({ id: actor.userId }));
    if (!(await verifyPassword(user?.password_hash ?? null, currentPassword))) throw Errors.badRequest('wrong_password', 'Your current password is incorrect');
    const hash = await hashPassword(newPassword);
    await this.db.platform(async (tx) => {
      await tx.collection('users').updateOne({ id: actor.userId }, { $set: { password_hash: hash, must_change_password: false } });
      // Sign out every other session.
      await tx.collection('sessions').update({ user_id: actor.userId, id: { $ne: actor.sessionId }, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'password_changed' } });
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
      const user = await this.db.platform((tx) => tx.collection('users').findOne({ id: inv.user_id }));
      if (!(await verifyPassword(user!.password_hash, password))) throw Errors.unauthorized('You already have a SampCrew account. Enter its password to join this workspace.');
    } else {
      newHash = await hashPassword(password);
    }
    return this.db.platform(async (tx) => {
      if (newHash) await tx.collection('users').updateOne({ id: inv.user_id }, { $set: { password_hash: newHash, full_name: fullName, email_verified_at: new Date() } });
      await tx.collection('memberships').updateOne({ id: inv.membership_id }, { $set: { status: 'active', joined_at: new Date() } });
      await tx.collection('invitations').updateOne({ id: inv.id }, { $set: { accepted_at: new Date() } });
      await this.audit.record(tx, { tenantId: inv.tenant_id, action: 'membership.activated', resourceType: 'membership', resourceId: inv.membership_id, metadata: { via: 'invitation' } });
      await this.outbox.publish(tx, inv.tenant_id, 'membership.activated', { membershipId: inv.membership_id, userId: inv.user_id });
      return this.issueSession(tx, { userId: inv.user_id, tenantId: inv.tenant_id, membershipId: inv.membership_id, mfa: false, client });
    });
  }

  private async findInvitation(token: string) {
    const inv = await this.db.platform(async (tx) => {
      const i = await tx.collection('invitations').findOne({ token_hash: sha256(token), accepted_at: null, revoked_at: null, expires_at: { $gt: new Date() } });
      const t = i && (await tx.collection('tenants').findOne({ id: i.tenant_id, status: 'active' }));
      const m = t && (await tx.collection('memberships').findOne({ id: i.membership_id, status: 'invited' }));
      const u = m && (await tx.collection('users').findOne({ id: m.user_id }));
      if (!u) return undefined;
      return { id: i!.id as string, tenant_id: i!.tenant_id as string, membership_id: i!.membership_id as string, email: i!.email as string, tenant_name: t!.name as string, full_name: u.full_name as string, user_id: u.id as string, has_password: !!u.password_hash };
    });
    if (!inv) throw Errors.notFound('Invitation (it may have expired or already been used)');
    return inv;
  }
}

/** A user's active memberships in active workspaces, by workspace name (the workspace picker and switcher). */
async function activeMembershipsOf(tx: PlatformTx, userId: string) {
  const user = await tx.collection('users').findOne({ id: userId }, { projection: { status: 1 } });
  const memberships = await tx.collection('memberships').find({ user_id: userId, status: 'active' });
  const tenants = new Map((await tx.collection('tenants').find({ id: { $in: memberships.map((m) => m.tenant_id) }, status: 'active' })).map((t) => [t.id as string, t]));
  return memberships
    .filter((m) => tenants.has(m.tenant_id))
    .map((m) => ({ membership_id: m.id as string, tenant_id: m.tenant_id as string, name: tenants.get(m.tenant_id)!.name as string, slug: tenants.get(m.tenant_id)!.slug as string, user_active: user?.status === 'active' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
