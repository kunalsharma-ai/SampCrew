import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PASSWORD_RESET_TTL_MINUTES,
  type PasswordResetComplete,
  type PasswordResetLevel,
  type PasswordResetList,
  type PasswordResetRow,
  type PasswordResetStatus,
  type passwordResetsQuery,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';

/** Emails one account may be sent in an hour; more requests are recorded but send nothing. */
const MAX_EMAILS_PER_HOUR = 3;
/** Wrong 6-digit codes before a request stops working. */
const MAX_CODE_ATTEMPTS = 5;

type Kind = 'user' | 'platform_admin';
type Client = 'web' | 'mobile' | 'api' | 'console';

interface ResetRow {
  id: string;
  account_kind: Kind;
  subject_id: string | null;
  email: string;
  full_name: string | null;
  level: PasswordResetLevel | null;
  tenant_ids: string[];
  tenants: { id: string; name: string; level: PasswordResetLevel }[];
  status: Exclude<PasswordResetStatus, 'expired'>;
  token_hash: string | null;
  code_hash: string | null;
  code_attempts: number;
  email_message_id: string | null;
  client: Client;
  ip: string | null;
  user_agent: string | null;
  expires_at: Date;
  completed_at: Date | null;
  completed_ip: string | null;
  sessions_revoked: number;
  created_at: Date;
}

/** The answer to every request, whatever the address: it never says whether an account exists. */
const SENT = {
  status: 'sent' as const,
  message: `If an account uses that email, a reset link and a 6-digit code are on their way. They work for ${PASSWORD_RESET_TTL_MINUTES} minutes. Check your spam folder if nothing arrives.`,
};

const LEVEL_RANK: Record<PasswordResetLevel, number> = { console: 4, super: 3, hr: 2, employee: 1 };

/**
 * "Forgot password" for every level. A person in a workspace (Super, HR or Employee Workspace, on the web or the phone
 * app) or a SAMPLEDGE Console admin asks with their email; SampCrew emails a single-use link and a 6-digit code through
 * the email settings in Console > Integrations. Setting the new password signs out every session, clears a sign-in
 * lock and keeps two-step verification as it was. Every request is recorded in password_resets, which the Console
 * reads in full and each Super Workspace reads for its own people, and in the audit trails.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordReset');

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly authz: AuthzService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Asking for a reset
  // ---------------------------------------------------------------------------
  async request(kind: Kind, email: string, client: Client) {
    const ctx = requestContext.get();
    const base = { account_kind: kind, email, client, ip: ctx?.ip ?? null, user_agent: ctx?.userAgent?.slice(0, 400) ?? null, expires_at: minutesFromNow(PASSWORD_RESET_TTL_MINUTES) };
    const token = randomToken(32);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const sent = await this.db.platform(async (tx) => {
      const account = await this.account(tx, kind, email);
      if (!account) {
        await tx.collection('password_resets').insert({ ...base, status: 'no_account', tenant_ids: [], tenants: [] });
        await this.audit.record(tx, { tenantId: null, action: 'auth.password_reset_unknown_email', resourceType: kind, actorLabel: 'Forgot password (no matching account)', metadata: { client } });
        return null;
      }
      const who = { subject_id: account.id, full_name: account.fullName, level: account.level, tenant_ids: account.tenants.map((t) => t.id), tenants: account.tenants };
      if (!account.active) {
        await tx.collection('password_resets').insert({ ...base, ...who, status: 'inactive' });
        await this.recordAudit(tx, account, 'auth.password_reset_refused', { reason: 'inactive', client });
        return null;
      }
      const resets = tx.collection<ResetRow>('password_resets');
      const recent = await resets.count({ account_kind: kind, subject_id: account.id, email_message_id: { $ne: null }, created_at: { $gt: minutesFromNow(-60) } });
      if (recent >= MAX_EMAILS_PER_HOUR) {
        await resets.insert({ ...base, ...who, status: 'limited' });
        await this.recordAudit(tx, account, 'auth.password_reset_refused', { reason: 'too_many_requests', client });
        return null;
      }
      // Only the newest link and code work.
      await resets.update({ account_kind: kind, subject_id: account.id, status: 'pending' }, { $set: { status: 'replaced' } });
      const row = await resets.insert({ ...base, ...who, status: 'pending', token_hash: sha256(token) });
      await resets.updateOne({ id: row.id }, { $set: { code_hash: codeHash(row.id as string, code) } });
      const link = `${kind === 'platform_admin' ? this.config.CONSOLE_PUBLIC_URL : this.config.WEB_PUBLIC_URL}/reset-password?token=${token}`;
      const where = kind === 'platform_admin' ? 'the SampCrew Console' : 'SampCrew';
      const messageId = await this.queue(
        tx,
        account.email,
        `Reset your ${kind === 'platform_admin' ? 'SampCrew Console' : 'SampCrew'} password`,
        [
          `Hello ${account.fullName ?? ''},`.replace(/ ,$/, ','),
          '',
          `Someone (we hope you) asked to reset the password for ${account.email} on ${where}.`,
          '',
          `Choose a new password here: ${link}`,
          '',
          kind === 'user' ? `Or, in the SampCrew phone app, tap "Forgot password?" and enter this code: ${code}` : `Or enter this code on the Console's reset page: ${code}`,
          '',
          `The link and the code work once, for ${PASSWORD_RESET_TTL_MINUTES} minutes. Setting a new password signs you out everywhere; two-step verification stays on if you use it.`,
          '',
          'If you did not ask for this, ignore this email: your password stays as it is.',
        ].join('\n'),
        'password_reset',
      );
      await resets.updateOne({ id: row.id }, { $set: { email_message_id: messageId } });
      await this.recordAudit(tx, account, 'auth.password_reset_requested', { client, resetId: row.id });
      return { link };
    });
    // Outside staging and production the link is logged, so the flow can be tried without a mail server.
    if (sent && !this.config.isProductionLike) this.logger.log(`Password reset link: ${sent.link} (code ${code})`);
    return SENT;
  }

  /** Whether a link from the email still works, for the reset page to show the form or say it expired. */
  async check(kind: Kind, token: string) {
    const row = await this.db.platform((tx) => tx.collection<ResetRow>('password_resets').findOne({ account_kind: kind, token_hash: sha256(token) }));
    if (!row || row.status !== 'pending' || row.expires_at <= new Date()) return { valid: false as const };
    return { valid: true as const, email: maskEmail(row.email), expiresAt: row.expires_at.toISOString() };
  }

  // ---------------------------------------------------------------------------
  // Setting the new password
  // ---------------------------------------------------------------------------
  async complete(kind: Kind, input: PasswordResetComplete) {
    const row = await this.findUsable(kind, input);
    const table = kind === 'platform_admin' ? 'platform_admins' : 'users';
    const current = await this.db.platform((tx) => tx.collection(table).findOne({ id: row.subject_id }, { projection: { password_hash: 1, status: 1 } }));
    if (!current || current.status !== 'active') throw invalidLink();
    if (await verifyPassword((current.password_hash as string | null) ?? null, input.newPassword)) {
      throw Errors.badRequest('same_password', 'Choose a password different from your current one');
    }
    const hash = await hashPassword(input.newPassword);
    const ip = requestContext.get()?.ip ?? null;
    return this.db.platform(async (tx) => {
      const resets = tx.collection<ResetRow>('password_resets');
      // Marking it used in the same transaction as the password change: two uses of one link cannot both win.
      const used = await resets.update({ id: row.id, status: 'pending' }, { $set: { status: 'completed', completed_at: new Date(), completed_ip: ip } }, { limit: 1 });
      if (!used) throw invalidLink();
      const now = new Date();
      let revoked: number;
      if (kind === 'platform_admin') {
        await tx.collection('platform_admins').updateOne({ id: row.subject_id }, { $set: { password_hash: hash, must_change_password: false, failed_login_count: 0, locked_until: null } });
        revoked = await tx.collection('platform_sessions').update({ admin_id: row.subject_id, revoked_at: null }, { $set: { revoked_at: now } });
      } else {
        const user = await tx.collection('users').findOne({ id: row.subject_id }, { projection: { email_verified_at: 1 } });
        await tx.collection('users').updateOne({ id: row.subject_id }, { $set: { password_hash: hash, must_change_password: false, failed_login_count: 0, locked_until: null, email_verified_at: user?.email_verified_at ?? now } });
        revoked = await tx.collection('sessions').update({ user_id: row.subject_id, revoked_at: null }, { $set: { revoked_at: now, revoked_reason: 'password_reset' } });
      }
      await resets.updateOne({ id: row.id }, { $set: { sessions_revoked: revoked } });
      await resets.update({ account_kind: kind, subject_id: row.subject_id, status: 'pending' }, { $set: { status: 'replaced' } });
      // The emailed link is spent: keep it out of the stored copy of the message once that has gone out.
      if (row.email_message_id) await tx.collection('email_messages').updateOne({ id: row.email_message_id, status: { $ne: 'queued' } }, { $set: { text_body: '[Password reset email. The link and code in it were used and no longer work.]' } });
      await this.queue(
        tx,
        row.email,
        `Your ${kind === 'platform_admin' ? 'SampCrew Console' : 'SampCrew'} password was changed`,
        `The password for ${row.email} was just changed with a reset link or code, and every device was signed out.\n\nIf this was not you, reset your password again straight away and tell your ${kind === 'platform_admin' ? 'Console super admin' : 'Super Workspace'}.`,
        'password_reset_done',
      );
      await this.recordAudit(tx, { kind, id: row.subject_id!, email: row.email, fullName: row.full_name, tenants: row.tenants }, 'auth.password_reset_completed', { resetId: row.id, sessionsRevoked: revoked, client: row.client });
      return { status: 'ok' as const, message: 'Your password is changed and every device was signed out. Sign in with the new password.' };
    });
  }

  /** The pending request a link or an email + code points to. Wrong codes count, and stop the request after five. */
  private async findUsable(kind: Kind, input: PasswordResetComplete): Promise<ResetRow> {
    const now = new Date();
    if (input.token) {
      const row = await this.db.platform((tx) => tx.collection<ResetRow>('password_resets').findOne({ account_kind: kind, token_hash: sha256(input.token!) }));
      if (!row || row.status !== 'pending' || row.expires_at <= now || !row.subject_id) throw invalidLink();
      return row;
    }
    const row = await this.db.platform((tx) => tx.collection<ResetRow>('password_resets').findOne({ account_kind: kind, email: input.email!, status: 'pending' }, { sort: { created_at: -1 } }));
    if (!row || row.expires_at <= now || !row.subject_id || !row.code_hash) throw invalidCode();
    if (safeEqual(row.code_hash, codeHash(row.id, input.code!))) return row;
    await this.db.platform(async (tx) => {
      const resets = tx.collection<{ code_attempts: number }>('password_resets');
      const after = await resets.updateAndGet({ id: row.id }, { $inc: { code_attempts: 1 } });
      if ((after?.code_attempts ?? 0) >= MAX_CODE_ATTEMPTS) {
        await resets.updateOne({ id: row.id }, { $set: { status: 'locked' } });
        await this.recordAudit(tx, { kind, id: row.subject_id!, email: row.email, fullName: row.full_name, tenants: row.tenants }, 'auth.password_reset_locked', { resetId: row.id });
      }
    });
    throw invalidCode();
  }

  // ---------------------------------------------------------------------------
  // The record: Console (everyone) and Super Workspace (its own people)
  // ---------------------------------------------------------------------------
  /** Console > Password resets: every request at every level, newest first. */
  async platformList(q: z.infer<typeof passwordResetsQuery>): Promise<PasswordResetList> {
    return this.db.platform((tx) => this.list(tx, q, q.tenantId ? { tenant_ids: q.tenantId } : {}));
  }

  /**
   * Super Workspace: resets by the people of this company (HR Workspace and Employee Workspace included), as they
   * happen. Only the Super Workspace level sees it, and only the company's own rows; addresses with no account are
   * never shown to a workspace.
   */
  async workspaceList(q: z.infer<typeof passwordResetsQuery>): Promise<PasswordResetList> {
    const actor = requestContext.tenantActor();
    const subject = await this.authz.subject();
    if (!subject.grants.some((g) => g.roleKey === 'super_workspace')) throw Errors.forbidden('Only the Super Workspace sees password resets');
    const { tenantId: _ignored, ...rest } = q;
    if (rest.level === 'console') return { items: [], total: 0, summary: { requested: 0, completed: 0, pending: 0, failedDelivery: 0 } };
    const result = await this.db.platform((tx) => this.list(tx, rest, { tenant_ids: actor.tenantId, account_kind: 'user' }));
    // A person's other companies are not this workspace's business.
    result.items = result.items.map((r) => ({ ...r, workspaces: r.workspaces.filter((w) => w.id === actor.tenantId), level: r.workspaces.find((w) => w.id === actor.tenantId)?.level ?? r.level, ip: r.ip }));
    return result;
  }

  private async list(tx: PlatformTx, q: Omit<z.infer<typeof passwordResetsQuery>, 'tenantId'>, scope: Record<string, unknown>): Promise<PasswordResetList> {
    const resets = tx.collection<ResetRow>('password_resets');
    const now = new Date();
    const filter: Record<string, unknown> = { ...scope };
    if (q.level) {
      if (scope.tenant_ids && typeof scope.tenant_ids === 'string') filter.tenants = { $elemMatch: { id: scope.tenant_ids, level: q.level } };
      else filter.level = q.level;
    }
    if (q.status === 'expired') Object.assign(filter, { status: 'pending', expires_at: { $lte: now } });
    else if (q.status === 'pending') Object.assign(filter, { status: 'pending', expires_at: { $gt: now } });
    else if (q.status) filter.status = q.status;
    if (q.q) {
      const re = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ email: re }, { full_name: re }];
    }
    // One transaction runs one operation at a time.
    const rows = await resets.find(filter, { sort: { created_at: -1 }, limit: q.limit, skip: q.offset });
    const total = await resets.count(filter);
    const since = minutesFromNow(-30 * 24 * 60);
    const recent = await resets.find({ ...scope, created_at: { $gt: since } }, { projection: { status: 1, expires_at: 1, email_message_id: 1 } });
    const messageIds = [...new Set([...rows, ...recent].map((r) => r.email_message_id).filter((x): x is string => !!x))];
    const messages = new Map((await tx.collection('email_messages').find({ id: { $in: messageIds } }, { projection: { status: 1, last_error: 1 } })).map((m) => [m.id as string, m]));
    const tenantIds = [...new Set(rows.flatMap((r) => r.tenant_ids ?? []))];
    const names = new Map((await tx.collection('tenants').find({ id: { $in: tenantIds } }, { projection: { name: 1 } })).map((t) => [t.id as string, t.name as string]));
    const items: PasswordResetRow[] = rows.map((r) => {
      const m = r.email_message_id ? messages.get(r.email_message_id) : undefined;
      return {
        id: r.id,
        email: r.email,
        fullName: r.full_name ?? null,
        level: r.level ?? null,
        workspaces: (r.tenants ?? []).map((t) => ({ id: t.id, name: names.get(t.id) ?? t.name, level: t.level })),
        status: shownStatus(r, now),
        delivery: (m?.status as PasswordResetRow['delivery']) ?? null,
        deliveryError: (m?.last_error as string | null) ?? null,
        client: r.client,
        ip: r.ip ?? null,
        requestedAt: r.created_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        completedAt: r.completed_at?.toISOString() ?? null,
        sessionsRevoked: r.sessions_revoked ?? 0,
      };
    });
    const summary = {
      requested: recent.length,
      completed: recent.filter((r) => r.status === 'completed').length,
      pending: recent.filter((r) => shownStatus(r as ResetRow, now) === 'pending').length,
      failedDelivery: recent.filter((r) => {
        const s = r.email_message_id ? messages.get(r.email_message_id as string)?.status : undefined;
        return s === 'failed' || s === 'skipped';
      }).length,
    };
    return { items, total, summary };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  /** The account an email belongs to, with its level in each workspace (or "console" for an admin). */
  private async account(tx: PlatformTx, kind: Kind, email: string) {
    if (kind === 'platform_admin') {
      const a = await tx.collection('platform_admins').findOne({ email });
      if (!a) return null;
      return { kind, id: a.id as string, email: a.email as string, fullName: (a.full_name as string) ?? null, level: 'console' as PasswordResetLevel, tenants: [] as ResetRow['tenants'], active: a.status === 'active' };
    }
    const u = await tx.collection('users').findOne({ email });
    if (!u) return null;
    const memberships = await tx.collection('memberships').find({ user_id: u.id, status: 'active' });
    const tenants = new Map((await tx.collection('tenants').find({ id: { $in: memberships.map((m) => m.tenant_id) }, status: 'active' }, { projection: { name: 1 } })).map((t) => [t.id as string, t.name as string]));
    const live = memberships.filter((m) => tenants.has(m.tenant_id));
    const assignments = await tx.collection('role_assignments').find({ membership_id: { $in: live.map((m) => m.id) } }, { projection: { membership_id: 1, role_id: 1 } });
    const roles = new Map((await tx.collection('roles').find({ id: { $in: assignments.map((a) => a.role_id) }, is_system: true }, { projection: { key: 1 } })).map((r) => [r.id as string, r.key as string]));
    const levelOf = (membershipId: string): PasswordResetLevel => {
      const keys = assignments.filter((a) => a.membership_id === membershipId).map((a) => roles.get(a.role_id as string));
      return keys.includes('super_workspace') ? 'super' : keys.includes('hr_workspace') ? 'hr' : 'employee';
    };
    const list = live.map((m) => ({ id: m.tenant_id as string, name: tenants.get(m.tenant_id)!, level: levelOf(m.id as string) }));
    const level = list.reduce<PasswordResetLevel | null>((best, t) => (!best || LEVEL_RANK[t.level] > LEVEL_RANK[best] ? t.level : best), null);
    // A reset is only useful to someone who can sign in somewhere afterwards.
    return { kind, id: u.id as string, email: u.email as string, fullName: (u.full_name as string) ?? null, level: level ?? 'employee', tenants: list, active: u.status === 'active' && list.length > 0 };
  }

  /** One audit entry in each workspace the person belongs to (their Super Workspace's audit trail), plus the platform's. */
  private async recordAudit(tx: PlatformTx, who: { kind: Kind; id: string; email: string; fullName: string | null; tenants: { id: string }[] }, action: string, metadata: Record<string, unknown>) {
    const actorLabel = `${who.fullName ?? who.email} (forgot password)`;
    const resourceType = who.kind === 'platform_admin' ? 'platform_admin' : 'user';
    await this.audit.record(tx, { tenantId: null, action, resourceType, resourceId: who.id, actorLabel, metadata: { ...metadata, email: who.email } });
    for (const t of who.tenants) await this.audit.record(tx, { tenantId: t.id, action, resourceType, resourceId: who.id, actorLabel, metadata: { ...metadata, email: who.email } });
  }

  private async queue(tx: PlatformTx, to: string, subject: string, text: string, template: string): Promise<string> {
    const m = await tx.collection('email_messages').insert({ tenant_id: null, to_email: to, subject, text_body: `${text}\n\n--\nSampCrew by SAMPLEDGE. You received this because of a password request for your account.`, template });
    return m.id as string;
  }
}

function shownStatus(r: Pick<ResetRow, 'status' | 'expires_at'>, now: Date): PasswordResetStatus {
  return r.status === 'pending' && r.expires_at <= now ? 'expired' : r.status;
}

const codeHash = (resetId: string, code: string) => sha256(`${resetId}:${code}`);
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
const invalidLink = () => Errors.badRequest('reset_link_invalid', 'This reset link has expired or was already used. Ask for a new one.');
const invalidCode = () => Errors.badRequest('reset_code_invalid', 'That code is not right, or it expired. Check the newest email, or ask for a new code.');

/** "k****@example.com": enough for the person to recognise, not enough to read someone else's address. */
export function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  return `${local!.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(6, local!.length - 1)))}@${domain}`;
}
