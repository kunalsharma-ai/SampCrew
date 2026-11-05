import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField, randomToken, sha256, verifyPassword } from '../../platform/auth/crypto';
import { generateMfaSecret, mfaUri, verifyTotp } from '../../platform/auth/mfa';
import { TokenService } from '../../platform/auth/token.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, one, type Tx } from '../../platform/database/database.service';
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
    const admin = await this.db.platform((tx) => one<AdminRow>(tx, 'select * from platform_admins where email = $1', [email]));
    if (admin?.locked_until && admin.locked_until > new Date()) throw Errors.tooMany();
    const ok = await verifyPassword(admin?.password_hash ?? null, password);
    if (!admin || !ok || admin.status !== 'active') {
      if (admin) await this.failed(admin.id);
      throw Errors.unauthorized('Email or password is incorrect');
    }
    let mfa = false;
    if (admin.mfa_enabled) {
      if (!code) return { status: 'mfa_required' as const };
      if (!verifyTotp(decryptField(admin.mfa_secret_enc!, this.config.FIELD_ENCRYPTION_KEY), code)) {
        await this.failed(admin.id);
        throw Errors.unauthorized('That code is not valid');
      }
      mfa = true;
    }
    return this.db.platform(async (tx) => {
      await tx.query('update platform_admins set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1', [admin.id]);
      const pair = await this.issue(tx, admin, mfa);
      await this.audit.record(tx, { tenantId: null, action: 'platform.login', resourceType: 'platform_admin', resourceId: admin.id, metadata: { mfa } });
      return { status: 'ok' as const, ...pair, mfaEnrolmentRequired: !admin.mfa_enabled };
    });
  }

  private async failed(id: string) {
    await this.db.platform(async (tx) => {
      await tx.query(
        `update platform_admins set failed_login_count = failed_login_count + 1,
           locked_until = case when failed_login_count + 1 >= 5 then now() + interval '15 minutes' else locked_until end where id = $1`,
        [id],
      );
      await this.audit.record(tx, { tenantId: null, action: 'platform.login_failed', resourceType: 'platform_admin', resourceId: id });
    });
  }

  private async issue(tx: Tx, admin: Pick<AdminRow, 'id' | 'role'>, mfa: boolean) {
    const refreshToken = randomToken(32);
    const ctx = requestContext.get();
    const s = (await one<{ id: string }>(
      tx,
      `insert into platform_sessions (admin_id, refresh_token_hash, mfa_verified, ip, user_agent, expires_at) values ($1, $2, $3, $4, $5, now() + interval '12 hours') returning id`,
      [admin.id, sha256(refreshToken), mfa, ctx?.ip ?? null, ctx?.userAgent?.slice(0, 400) ?? null],
    ))!;
    const accessToken = await this.tokens.signPlatform({ sub: admin.id, role: admin.role, sid: s.id, mfa });
    return { accessToken, refreshToken, expiresIn: this.tokens.accessTtl };
  }

  async refresh(refreshToken: string) {
    return this.db.platform(async (tx) => {
      const s = await one<{ id: string; admin_id: string; mfa_verified: boolean; role: string; ok: boolean }>(
        tx,
        `select s.id, s.admin_id, s.mfa_verified, a.role, (s.revoked_at is null and s.expires_at > now() and a.status = 'active') as ok
           from platform_sessions s join platform_admins a on a.id = s.admin_id where s.refresh_token_hash = $1 for update of s`,
        [sha256(refreshToken)],
      );
      if (!s?.ok) throw Errors.unauthorized();
      await tx.query('update platform_sessions set revoked_at = now() where id = $1', [s.id]);
      return this.issue(tx, { id: s.admin_id, role: s.role }, s.mfa_verified);
    });
  }

  async logout() {
    const a = requestContext.platformActor();
    await this.db.platform((tx) => tx.query('update platform_sessions set revoked_at = now() where id = $1', [a.sessionId]));
  }

  async me() {
    const a = requestContext.platformActor();
    const row = await this.db.platform((tx) => one<{ id: string; email: string; fullName: string; role: string; mfaEnabled: boolean }>(
      tx,
      `select id, email::text, full_name as "fullName", role, mfa_enabled as "mfaEnabled" from platform_admins where id = $1`,
      [a.adminId],
    ));
    return { ...row, session: { mfa: a.mfa } };
  }

  async mfaSetup() {
    const a = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      const admin = (await one<{ email: string; mfa_enabled: boolean }>(tx, 'select email::text, mfa_enabled from platform_admins where id = $1', [a.adminId]))!;
      if (admin.mfa_enabled) throw Errors.conflict('mfa_already_enabled', 'MFA is already enabled');
      const secret = generateMfaSecret();
      await tx.query('update platform_admins set mfa_secret_enc = $2 where id = $1', [a.adminId, encryptField(secret, this.config.FIELD_ENCRYPTION_KEY)]);
      return { secret, otpauthUri: mfaUri(admin.email, secret, 'CREW Console (SAMPLEDGE)') };
    });
  }

  async mfaEnable(code: string) {
    const a = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      const admin = (await one<{ mfa_secret_enc: string | null; role: string }>(tx, 'select mfa_secret_enc, role from platform_admins where id = $1', [a.adminId]))!;
      if (!admin.mfa_secret_enc) throw Errors.badRequest('mfa_not_started', 'Start MFA setup first');
      if (!verifyTotp(decryptField(admin.mfa_secret_enc, this.config.FIELD_ENCRYPTION_KEY), code)) throw Errors.badRequest('invalid_code', 'That code is not valid');
      await tx.query('update platform_admins set mfa_enabled = true where id = $1', [a.adminId]);
      await tx.query('update platform_sessions set revoked_at = now() where id = $1', [a.sessionId]);
      await this.audit.record(tx, { tenantId: null, action: 'platform.mfa_enabled', resourceType: 'platform_admin', resourceId: a.adminId });
      return this.issue(tx, { id: a.adminId, role: admin.role }, true);
    });
  }
}
