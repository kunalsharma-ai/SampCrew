import { Injectable } from '@nestjs/common';
import type { ConsoleAuditQuery, ConsoleAuditRow, ConsoleLoginRow, ConsoleSessionRow, SecurityOverview } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { canSeePii, maskEmail } from './companies.service';
import { ConsoleSettingsService } from './console-settings.service';
import { tableFile } from './table-file';

const DAY = 86_400_000;

interface AuditDoc {
  id: string; tenant_id: string | null; actor_type: string; actor_id: string | null; actor_label: string | null; action: string; resource_type: string; resource_id: string | null;
  changes: Record<string, unknown> | null; metadata: Record<string, unknown> | null; ip: string | null; user_agent: string | null; created_at: Date;
}

/** Which Console area an audit action belongs to, from its name. */
export function auditArea(action: string, resourceType: string): string {
  const a = action.replace(/^platform\./, '');
  if (/^(company|clients?_)|^clients_/.test(a) || resourceType === 'company') return 'companies';
  if (/^(tenant|workspace|hr_workspace|support_access)/.test(a) || resourceType === 'tenant') return 'workspaces';
  if (/^(membership|invitation|user|access_user)/.test(a)) return 'users';
  if (/^plan/.test(a) || resourceType === 'plan') return 'plans';
  if (/^(subscription|invoice|payment|refund|credit|billing|coupon|deal|addon)/.test(a)) return 'billing';
  if (/^(admin|role)/.test(a) || resourceType === 'platform_admin' || resourceType === 'platform_role') return /^(login|mfa|password|admin_locked|session)/.test(a) ? 'security' : 'admins';
  if (/^(login|mfa|password|session|permission_denied|admin_locked)/.test(a)) return 'security';
  if (/^(support|help|conversation|communication)/.test(a)) return 'communication';
  if (/^(settings|integration|statutory|feature)/.test(a)) return 'settings';
  return 'other';
}

export function auditStatus(action: string): ConsoleAuditRow['status'] {
  if (/permission_denied|_refused$|\.denied$/.test(action)) return 'denied';
  if (/_failed$|\.failed$/.test(action)) return 'failed';
  return 'success';
}

/** "platform.plan_retired" -> "Plan retired". */
export function auditLabel(action: string): string {
  const t = action.replace(/^platform\./, '').replace(/[._]/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** A short device name from a browser's user agent: "Chrome on Windows". */
export function deviceOf(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici|okhttp|python/i.test(ua) ? 'Script' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

const AREA_ACTIONS: Record<string, RegExp> = {
  companies: /^platform\.(company|clients?_)/,
  workspaces: /^(platform\.(tenant|workspace)|hr_workspace\.|support_access\.)/,
  users: /^(membership\.|invitation\.|platform\.(user|access_user))/,
  plans: /^platform\.plan/,
  billing: /^(platform\.)?(subscription|invoice|payment|refund|credit|billing|coupon|deal|addon)/,
  admins: /^platform\.(admin_(created|updated|disabled|enabled|password_reset|mfa_reset|unlocked)|role_)/,
  security: /^platform\.(login|mfa|password|session|permission_denied|admin_locked)/,
  communication: /^(platform\.)?(support|help|conversation)/,
  settings: /^platform\.(settings|integration|statutory|feature)/,
};

/**
 * The Console audit log and security screens. The audit log reads the hash-chained audit trail: Console actions
 * (tenant_id null) and, with scope "all", the events of client workspaces too. Before and after values come from
 * the recorded diff; IP and device from the request that made the change. Changes inside client workspaces show
 * their values only to admins with users:pii, so an audit:read role cannot read employee data through the log.
 */
@Injectable()
export class ConsoleAuditService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly settings: ConsoleSettingsService) {}

  private filter(q: ConsoleAuditQuery) {
    const f: Record<string, unknown> = {};
    if (q.scope === 'platform') f.tenant_id = null;
    if (q.tenantId) f.tenant_id = q.tenantId;
    if (q.actorType) f.actor_type = q.actorType;
    if (q.actorId) f.actor_id = q.actorId;
    const and: Record<string, unknown>[] = [];
    if (q.action) and.push({ action: q.action.includes('.') ? q.action : ilike(q.action) });
    if (q.area && q.area !== 'other') and.push({ action: { $regex: AREA_ACTIONS[q.area]!.source } });
    if (q.status === 'denied') and.push({ action: { $regex: 'permission_denied|_refused$|\\.denied$' } });
    if (q.status === 'failed') and.push({ action: { $regex: '_failed$|\\.failed$' } });
    if (q.status === 'success') and.push({ action: { $not: /permission_denied|_refused$|\.denied$|_failed$|\.failed$/ } });
    if (q.q) and.push({ $or: [{ action: ilike(q.q) }, { actor_label: ilike(q.q) }, { resource_type: ilike(q.q) }, { resource_id: q.q }, { ip: q.q }] });
    const created: Record<string, Date> = {};
    if (q.from) created.$gte = new Date(`${q.from}T00:00:00Z`);
    if (q.to) created.$lt = new Date(new Date(`${q.to}T00:00:00Z`).getTime() + DAY);
    if (q.cursor) {
      const [at, id] = q.cursor.split('|');
      const d = new Date(at ?? '');
      if (!Number.isNaN(d.getTime())) and.push({ $or: [{ created_at: { $lt: d } }, { created_at: d, id: { $lt: id } }] });
    }
    if (Object.keys(created).length) f.created_at = created;
    if (and.length) f.$and = and;
    return f;
  }

  private async rows(tx: PlatformTx, docs: AuditDoc[]): Promise<ConsoleAuditRow[]> {
    const tenantIds = [...new Set(docs.map((d) => d.tenant_id).filter((x): x is string => !!x))];
    const tenants = tenantIds.length ? await tx.collection<{ id: string; name: string; company_id: string | null }>('tenants').find({ id: { $in: tenantIds } }, { projection: { name: 1, company_id: 1 } }) : [];
    const companies = new Map((await tx.collection<{ id: string; name: string }>('companies').find({ id: { $in: tenants.map((t) => t.company_id).filter(Boolean) } }, { projection: { name: 1 } })).map((c) => [c.id, c.name]));
    const tenantName = new Map(tenants.map((t) => [t.id, (t.company_id && companies.get(t.company_id)) || t.name]));
    const pii = canSeePii();
    return docs.map((e) => {
      const hide = !!e.tenant_id && !pii;
      const changes = (e.changes ?? {}) as Record<string, { from?: unknown; to?: unknown } | unknown>;
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      let isDiff = false;
      const isPair = (v: unknown): v is { from?: unknown; to?: unknown } => !!v && typeof v === 'object' && !Array.isArray(v) && ('from' in v || 'to' in v);
      for (const [k, v] of Object.entries(changes)) {
        if (isPair(v)) {
          isDiff = true;
          before[k] = v.from ?? null;
          after[k] = v.to ?? null;
        } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).length && Object.values(v).every(isPair)) {
          // A section diff ({ workspaceDefaults: { trialDays: { from, to } } }): before and after per field.
          isDiff = true;
          before[k] = Object.fromEntries(Object.entries(v).map(([f, p]) => [f, (p as { from?: unknown }).from ?? null]));
          after[k] = Object.fromEntries(Object.entries(v).map(([f, p]) => [f, (p as { to?: unknown }).to ?? null]));
        }
      }
      return {
        id: e.id, at: e.created_at.toISOString(), action: e.action, label: auditLabel(e.action), area: auditArea(e.action, e.resource_type), status: auditStatus(e.action),
        actorType: e.actor_type, actor: e.actor_label ?? null, actorId: e.actor_id ?? null, tenantId: e.tenant_id ?? null, company: e.tenant_id ? tenantName.get(e.tenant_id) ?? null : null,
        resourceType: e.resource_type, resourceId: e.resource_id ?? null,
        before: hide ? null : isDiff ? before : null, after: hide ? null : isDiff ? after : null,
        changes: hide ? (Object.keys(changes).length ? { hidden: Object.keys(changes) } : null) : Object.keys(changes).length ? changes : null,
        metadata: hide ? null : e.metadata && Object.keys(e.metadata).length ? e.metadata : null,
        ip: e.ip ?? null, device: deviceOf(e.user_agent),
      };
    });
  }

  list(q: ConsoleAuditQuery) {
    return this.db.platform(async (tx) => {
      const docs = await tx.collection<AuditDoc>('audit_events').find({ ...this.filter(q), pending: { $exists: false } }, { sort: { created_at: -1, id: -1 }, limit: q.limit + 1 });
      const page = docs.slice(0, q.limit);
      const last = page.at(-1);
      return { items: await this.rows(tx, page), next: docs.length > q.limit && last ? `${last.created_at.toISOString()}|${last.id}` : null };
    });
  }

  async export(q: ConsoleAuditQuery, format: 'csv' | 'xlsx' | 'pdf') {
    const items = await this.db.platform(async (tx) => this.rows(tx, await tx.collection<AuditDoc>('audit_events').find({ ...this.filter({ ...q, cursor: undefined }), pending: { $exists: false } }, { sort: { created_at: -1 }, limit: 10_000 })));
    await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'platform.audit_exported', resourceType: 'audit_events', resourceId: null, metadata: { format, rows: items.length, filters: { ...q, cursor: undefined } } }));
    const json = (v: unknown) => (v == null ? '' : JSON.stringify(v));
    const rows = [
      ['Time (UTC)', 'Action', 'Area', 'Status', 'By', 'Company', 'Resource', 'Before', 'After', 'IP', 'Device'],
      ...items.map((r) => [r.at.replace('T', ' ').slice(0, 19), r.label, r.area, r.status, r.actor, r.company, `${r.resourceType}${r.resourceId ? ` ${r.resourceId}` : ''}`, json(r.before), json(r.after ?? (r.before ? null : r.metadata)), r.ip, r.device]),
    ];
    return tableFile('sampcrew-audit', 'SampCrew audit log', `${items.length} events`, rows, format);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Security
  // ---------------------------------------------------------------------------------------------------------------

  security(): Promise<SecurityOverview> {
    const me = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      const { security } = await this.settings.read(tx);
      const admins = await tx.collection<{ id: string; email: string; full_name: string; mfa_enabled: boolean; status: string; locked_until: Date | null; role: string }>('platform_admins').find({});
      const byId = new Map(admins.map((a) => [a.id, a]));
      const now = new Date();
      const sessions = await tx.collection<{ id: string; admin_id: string; created_at: Date; expires_at: Date; revoked_at: Date | null; ip: string | null; user_agent: string | null; mfa_verified: boolean }>('platform_sessions')
        .find({ $or: [{ revoked_at: null, expires_at: { $gt: now } }, { created_at: { $gt: new Date(now.getTime() - 7 * DAY) } }] }, { sort: { created_at: -1 }, limit: 200 });
      const sessionRows: ConsoleSessionRow[] = sessions.map((s) => {
        const a = byId.get(s.admin_id);
        return {
          id: s.id, adminId: s.admin_id, admin: a?.full_name ?? 'Removed admin', email: a?.email ?? '', createdAt: s.created_at.toISOString(), expiresAt: s.expires_at.toISOString(),
          revokedAt: s.revoked_at?.toISOString() ?? null, ip: s.ip ?? null, device: deviceOf(s.user_agent), mfa: s.mfa_verified, current: s.id === me.sessionId, active: !s.revoked_at && s.expires_at > now,
        };
      });
      const logins = await this.logins(tx, byId, 100);
      const suspicious: SecurityOverview['suspicious'] = [];
      const since = new Date(now.getTime() - DAY);
      const failed = logins.filter((l) => !l.ok && new Date(l.at) > since);
      if (failed.length >= security.suspiciousFailedLogins) {
        suspicious.push({ key: 'failed_logins', level: 'critical', title: `${failed.length} failed Console sign-ins in 24 hours`, detail: `More than the ${security.suspiciousFailedLogins} set in Settings > Security. Most from ${topOf(failed.map((f) => f.ip ?? 'unknown IP'))}.`, at: failed[0]!.at });
      }
      const unknown = failed.filter((f) => !f.adminId);
      if (unknown.length >= 3) suspicious.push({ key: 'unknown_emails', level: 'warning', title: `${unknown.length} sign-ins with addresses that are not Console admins`, detail: `Someone may be guessing addresses. Most from ${topOf(unknown.map((f) => f.ip ?? 'unknown IP'))}.`, at: unknown[0]!.at });
      for (const a of admins.filter((x) => x.locked_until && x.locked_until > now)) {
        suspicious.push({ key: `locked:${a.id}`, level: 'warning', title: `${a.full_name} is locked out`, detail: `Too many wrong passwords or codes. The lock ends ${a.locked_until!.toISOString().slice(11, 16)} UTC, or unlock it under Admins.`, at: now.toISOString() });
      }
      // A sign-in from an IP this admin had not used in the 30 days before.
      const recentOk = await tx.collection<AuditDoc>('audit_events').find({ tenant_id: null, action: 'platform.login', created_at: { $gt: new Date(now.getTime() - 30 * DAY) } }, { sort: { created_at: -1 }, limit: 2000, projection: { resource_id: 1, ip: 1, created_at: 1 } });
      const seen = new Map<string, Date>();
      for (const l of [...recentOk].reverse()) {
        if (!l.ip || !l.resource_id) continue;
        const k = `${l.resource_id}|${l.ip}`;
        const first = !seen.has(k) && recentOk.some((o) => o.resource_id === l.resource_id && o.created_at < l.created_at);
        if (!seen.has(k)) seen.set(k, l.created_at);
        if (first && l.created_at > new Date(now.getTime() - 7 * DAY)) {
          const a = byId.get(l.resource_id);
          suspicious.push({ key: `new_ip:${k}`, level: 'warning', title: `${a?.full_name ?? 'An admin'} signed in from a new address`, detail: `${l.ip}, first time in 30 days. If this was not them, revoke the session below.`, at: l.created_at.toISOString() });
        }
      }
      const denied = await tx.collection<AuditDoc>('audit_events').aggregate<{ id: string; n: number; last: Date }>([
        { $match: { tenant_id: null, action: 'platform.permission_denied', created_at: { $gt: since } } },
        { $group: { _id: '$actor_id', n: { $sum: 1 }, last: { $max: '$created_at' } } },
        { $match: { n: { $gte: 5 } } },
      ]);
      for (const d of denied) suspicious.push({ key: `denied:${d.id}`, level: 'warning', title: `${byId.get(d.id)?.full_name ?? 'An admin'} was refused ${d.n} times today`, detail: 'They tried actions their role does not allow. Check the audit log, or their role.', at: d.last.toISOString() });
      const exports = await tx.collection<AuditDoc>('audit_events').aggregate<{ id: string; n: number; last: Date }>([
        { $match: { tenant_id: null, action: { $regex: '_exported$' }, created_at: { $gt: since } } },
        { $group: { _id: '$actor_id', n: { $sum: 1 }, last: { $max: '$created_at' } } },
        { $match: { n: { $gte: 10 } } },
      ]);
      for (const d of exports) suspicious.push({ key: `exports:${d.id}`, level: 'warning', title: `${byId.get(d.id)?.full_name ?? 'An admin'} exported ${d.n} files today`, detail: 'Exports take client data out of the Console. Check that this was expected.', at: d.last.toISOString() });
      const active = admins.filter((a) => a.status === 'active');
      const noMfa = active.filter((a) => !a.mfa_enabled);
      if (noMfa.length) suspicious.push({ key: 'no_mfa', level: 'warning', title: `${noMfa.length} active admin${noMfa.length === 1 ? ' has' : 's have'} not set up two-step verification`, detail: `${noMfa.map((a) => a.full_name).join(', ')} must enrol at their next sign-in before they can do anything.`, at: now.toISOString() });
      return {
        sessions: sessionRows,
        logins,
        suspicious: suspicious.sort((a, b) => (a.level === b.level ? b.at.localeCompare(a.at) : a.level === 'critical' ? -1 : 1)),
        admins: { total: admins.length, withoutMfa: noMfa.length, locked: admins.filter((a) => a.locked_until && a.locked_until > now).length, disabled: admins.filter((a) => a.status !== 'active').length },
      };
    });
  }

  private async logins(tx: PlatformTx, byId: Map<string, { full_name: string; email: string }>, limit: number): Promise<ConsoleLoginRow[]> {
    const docs = await tx.collection<AuditDoc>('audit_events').find({ tenant_id: null, action: { $in: ['platform.login', 'platform.login_failed', 'platform.admin_locked'] } }, { sort: { created_at: -1 }, limit });
    const pii = canSeePii();
    return docs.map((d) => {
      const a = d.resource_id ? byId.get(d.resource_id) : undefined;
      const typed = typeof d.metadata?.email === 'string' ? (pii ? d.metadata.email : maskEmail(d.metadata.email)) : null;
      return {
        at: d.created_at.toISOString(), adminId: a ? d.resource_id : null, admin: a?.full_name ?? (typed ? `Unknown address ${typed}` : null), ok: d.action === 'platform.login', ip: d.ip ?? null, device: deviceOf(d.user_agent),
        detail: d.action === 'platform.login' ? (d.metadata?.mfa ? 'Signed in with two-step verification' : 'Signed in, two-step verification not set up yet') : d.action === 'platform.admin_locked' ? 'Locked after too many attempts' : `Wrong password or code${d.metadata?.attempt ? ` (attempt ${String(d.metadata.attempt)})` : ''}`,
      };
    });
  }

  /** Ends one Console session at once (the admin must sign in again on that device). */
  revokeSession(id: string) {
    const me = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      const s = await tx.collection<{ id: string; admin_id: string; revoked_at: Date | null }>('platform_sessions').findOne({ id });
      if (!s) throw Errors.notFound('Session');
      if (s.id === me.sessionId) throw Errors.badRequest('own_session', 'This is your own session. Sign out instead.');
      if (!s.revoked_at) await tx.collection('platform_sessions').updateOne({ id }, { $set: { revoked_at: new Date() } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.session_revoked', resourceType: 'platform_session', resourceId: id, metadata: { adminId: s.admin_id } });
      return { revoked: true };
    });
  }

  /** Ends every session of one admin except the caller's own. */
  revokeAdminSessions(adminId: string) {
    const me = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      if (!(await tx.collection('platform_admins').exists({ id: adminId }))) throw Errors.notFound('Admin');
      const n = await tx.collection('platform_sessions').update({ admin_id: adminId, revoked_at: null, id: { $ne: me.sessionId } }, { $set: { revoked_at: new Date() } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.sessions_revoked', resourceType: 'platform_admin', resourceId: adminId, metadata: { sessions: n } });
      return { revoked: n };
    });
  }
}

function topOf(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [top] = [...counts].sort((a, b) => b[1] - a[1]);
  return top ? `${top[0]} (${top[1]})` : 'several addresses';
}
