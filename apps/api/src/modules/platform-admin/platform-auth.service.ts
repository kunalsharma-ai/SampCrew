import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField, hashPassword, randomToken, sha256, verifyPassword } from '../../platform/auth/crypto';
import { generateMfaSecret, mfaUri, verifyTotp } from '../../platform/auth/mfa';
import { TokenService } from '../../platform/auth/token.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx as Tx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

interface AdminRow {
  id: string;
  email: string;
  full_name: string;
  role: string;
  password_hash: string;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  status: string;
  locked_until: Date | null;
  must_change_password: boolean | null;
}

/** Authentication for SAMPLEDGE staff. Separate table, signing key and sessions from tenant users. */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(email: string, password: string, code?: string) {
    const admin = await this.db.platform((tx) => tx.collection<AdminRow>('platform_admins').findOne({ email }));
    if (admin?.locked_until && admin.locked_until > new Date()) throw Errors.tooMany();
    const ok = await verifyPassword(admin?.password_hash ?? null, password);
    if (!admin || !ok || admin.status !== 'active') {
      if (admin) await this.failed(admin.id);
      throw Errors.unauthorized('Email or password is incorrect');
    }
    let mfa = false;
    if (admin.mfa_enabled) {
      if (!code) return { status: 'mfa_required' as const };
      if (!verifyTotp(decryptField(admin.mfa_secret_enc!, this.config.fieldKeys), code)) {
        await this.failed(admin.id);
        throw Errors.unauthorized('That code is not valid');
      }
      mfa = true;
    }
    return this.db.platform(async (tx) => {
      await tx.collection('platform_admins').updateOne({ id: admin.id }, { $set: { failed_login_count: 0, locked_until: null, last_login_at: new Date() } });
      const pair = await this.issue(tx, admin, mfa);
      await this.audit.record(tx, { tenantId: null, action: 'platform.login', resourceType: 'platform_admin', resourceId: admin.id, metadata: { mfa } });
      return { status: 'ok' as const, ...pair, mfaEnrolmentRequired: !admin.mfa_enabled, passwordChangeRequired: admin.must_change_password === true };
    });
  }

  private async failed(id: string) {
    await this.db.platform(async (tx) => {
      const admins = tx.collection<{ failed_login_count: number }>('platform_admins');
      const a = await admins.updateAndGet({ id }, { $inc: { failed_login_count: 1 } });
      if ((a?.failed_login_count ?? 0) >= 5) await admins.updateOne({ id }, { $set: { locked_until: new Date(Date.now() + 15 * 60_000) } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.login_failed', resourceType: 'platform_admin', resourceId: id });
    });
  }

  private async issue(tx: Tx, admin: Pick<AdminRow, 'id' | 'role'>, mfa: boolean) {
    const refreshToken = randomToken(32);
    const ctx = requestContext.get();
    const s = await tx.collection<{ id: string }>('platform_sessions').insert({
      admin_id: admin.id, refresh_token_hash: sha256(refreshToken), mfa_verified: mfa,
      ip: ctx?.ip ?? null, user_agent: ctx?.userAgent?.slice(0, 400) ?? null, expires_at: new Date(Date.now() + 12 * 3_600_000),
    });
    const accessToken = await this.tokens.signPlatform({ sub: admin.id, role: admin.role, sid: s.id, mfa });
    return { accessToken, refreshToken, expiresIn: this.tokens.accessTtl };
  }

  async refresh(refreshToken: string) {
    return this.db.platform(async (tx) => {
      const sessions = tx.collection<{ id: string; admin_id: string; mfa_verified: boolean; revoked_at: Date | null; expires_at: Date }>('platform_sessions');
      const s = await sessions.findOne({ refresh_token_hash: sha256(refreshToken) });
      if (!s || s.revoked_at || s.expires_at <= new Date()) throw Errors.unauthorized();
      const a = await tx.collection<AdminRow>('platform_admins').findOne({ id: s.admin_id });
      if (!a || a.status !== 'active') throw Errors.unauthorized();
      // Revoking only an unrevoked session makes a second use of the same token lose the race.
      if (!(await sessions.update({ id: s.id, revoked_at: null }, { $set: { revoked_at: new Date() } }, { limit: 1 }))) throw Errors.unauthorized();
      return this.issue(tx, { id: s.admin_id, role: a.role }, s.mfa_verified);
    });
  }

  async logout() {
    const a = requestContext.platformActor();
    await this.db.platform((tx) => tx.collection('platform_sessions').updateOne({ id: a.sessionId }, { $set: { revoked_at: new Date() } }));
  }

  async me() {
    const a = requestContext.platformActor();
    const r = await this.db.platform((tx) => tx.collection<AdminRow>('platform_admins').findOne({ id: a.adminId }));
    const row = r ? { id: r.id, email: r.email, fullName: r.full_name, role: r.role, mfaEnabled: r.mfa_enabled, mustChangePassword: r.must_change_password === true } : undefined;
    return { ...row, session: { mfa: a.mfa } };
  }

  async mfaSetup() {
    const a = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      const admin = (await tx.collection<AdminRow>('platform_admins').findOne({ id: a.adminId }))!;
      if (admin.mfa_enabled) throw Errors.conflict('mfa_already_enabled', 'MFA is already enabled');
      const secret = generateMfaSecret();
      await tx.collection('platform_admins').updateOne({ id: a.adminId }, { $set: { mfa_secret_enc: encryptField(secret, this.config.fieldKeys) } });
      return { secret, otpauthUri: mfaUri(admin.email, secret, 'SampCrew Console (SAMPLEDGE)') };
    });
  }

  async mfaEnable(code: string) {
    const a = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      const admin = (await tx.collection<AdminRow>('platform_admins').findOne({ id: a.adminId }))!;
      if (!admin.mfa_secret_enc) throw Errors.badRequest('mfa_not_started', 'Start MFA setup first');
      if (!verifyTotp(decryptField(admin.mfa_secret_enc, this.config.fieldKeys), code)) throw Errors.badRequest('invalid_code', 'That code is not valid');
      await tx.collection('platform_admins').updateOne({ id: a.adminId }, { $set: { mfa_enabled: true } });
      await tx.collection('platform_sessions').updateOne({ id: a.sessionId }, { $set: { revoked_at: new Date() } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.mfa_enabled', resourceType: 'platform_admin', resourceId: a.adminId });
      return this.issue(tx, { id: a.adminId, role: admin.role }, true);
    });
  }

  /**
   * The signed-in admin changes their own password (also how a temporary one is replaced). Needs the current password
   * and an MFA-verified session; every other console session of theirs is signed out.
   */
  async changePassword(currentPassword: string, newPassword: string) {
    const a = requestContext.platformActor();
    const admin = await this.db.platform((tx) => tx.collection<AdminRow>('platform_admins').findOne({ id: a.adminId }));
    if (!admin || !(await verifyPassword(admin.password_hash, currentPassword))) {
      if (admin) await this.failed(admin.id);
      throw Errors.badRequest('wrong_password', 'Your current password is not right');
    }
    if (await verifyPassword(admin.password_hash, newPassword)) throw Errors.badRequest('same_password', 'Choose a password you have not just used');
    const hash = await hashPassword(newPassword);
    await this.db.platform(async (tx) => {
      await tx.collection('platform_admins').updateOne({ id: a.adminId }, { $set: { password_hash: hash, must_change_password: false, failed_login_count: 0 } });
      await tx.collection('platform_sessions').update({ admin_id: a.adminId, revoked_at: null, id: { $ne: a.sessionId } }, { $set: { revoked_at: new Date() } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.password_changed', resourceType: 'platform_admin', resourceId: a.adminId, metadata: { wasTemporary: admin.must_change_password === true } });
    });
  }
}
