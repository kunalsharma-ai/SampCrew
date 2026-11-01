import { Injectable } from '@nestjs/common';
import {
  applyScimPatch, parseScimFilter, parseScimToken, SCIM_LIST_SCHEMA, SCIM_TOKEN_PREFIX, SCIM_USER_SCHEMA, type ScimPatchInput, scimEmail, scimFullName,
  type ScimUserInput,
} from '@crew/contracts';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { randomToken, safeEqual, sha256 } from '../../platform/auth/crypto';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { AppError, Errors } from '../../platform/http/errors';

/** A SCIM error (RFC 7644 section 3.12). Rendered by ScimExceptionFilter. */
export class ScimError extends AppError {
  constructor(status: number, public readonly scimType: string | undefined, detail: string) {
    super(status, scimType ?? 'scim_error', detail);
  }
}

interface MemberRow {
  id: string;
  email: string;
  full_name: string;
  status: string;
  scim_external_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newPrefix = () => Array.from(randomBytes(10), (b) => ALPHA[b % ALPHA.length]).join('');

const MEMBER_SQL = `select m.id, u.email::text, u.full_name, m.status, m.scim_external_id, m.created_at, m.updated_at
                      from memberships m join users u on u.id = m.user_id`;

/**
 * SCIM 2.0 user provisioning (RFC 7643/7644) for Okta, Microsoft Entra ID and other identity providers. A SCIM
 * user is a workspace membership: creating one gives the person the Employee role and they sign in through
 * single sign-on; deactivating suspends the membership and signs them out everywhere. Groups are not supported.
 */
@Injectable()
export class ScimService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly outbox: OutboxService,
  ) {}

  // Tokens (managed by owners in Settings) ------------------------------------------------------------------------

  async status() {
    return this.db.tenant(async (tx) => ({
      token: await one(
        tx,
        `select t.id, t.prefix, t.last_used_at as "lastUsedAt", t.use_count::int as "useCount", t.created_at as "createdAt", u.full_name as "createdBy"
           from scim_tokens t join memberships m on m.id = t.created_by_membership_id join users u on u.id = m.user_id
          where t.revoked_at is null`,
      ),
      provisioned: (await one<{ n: number }>(tx, `select count(*)::int as n from memberships where provisioned_by = 'scim' and status = 'active'`))!.n,
      events: await many(tx, `select method, path, status, detail, created_at as "createdAt" from scim_events order by created_at desc limit 50`),
    }));
  }

  /** Creates a token, replacing any current one (which stops working at once). Returned this once. */
  async createToken() {
    const actor = requestContext.tenantActor();
    const prefix = newPrefix();
    const secret = randomToken(32);
    await this.db.tenant(async (tx) => {
      const old = await one<{ id: string }>(tx, 'update scim_tokens set revoked_at = now() where revoked_at is null returning id');
      const r = (await one<{ id: string }>(
        tx,
        'insert into scim_tokens (tenant_id, prefix, secret_hash, created_by_membership_id) values (app_tenant_id(), $1, $2, $3) returning id',
        [prefix, sha256(secret), actor.membershipId],
      ))!;
      await this.audit.record(tx, { action: 'scim.token_created', resourceType: 'scim_token', resourceId: r.id, metadata: { prefix, replaced: old?.id ?? null } });
    });
    return { token: `${SCIM_TOKEN_PREFIX}${prefix}_${secret}`, prefix };
  }

  async revokeToken() {
    await this.db.tenant(async (tx) => {
      const old = await one<{ id: string; prefix: string }>(tx, 'update scim_tokens set revoked_at = now() where revoked_at is null returning id, prefix');
      if (!old) throw Errors.notFound('SCIM token');
      await this.audit.record(tx, { action: 'scim.token_revoked', resourceType: 'scim_token', resourceId: old.id, metadata: { prefix: old.prefix } });
    });
    return { ok: true };
  }

  /** Checks a presented token (before the workspace is known, so with the platform role). */
  async authenticate(token: string) {
    const parsed = parseScimToken(token);
    if (!parsed) return null;
    return this.db.platform(async (tx) => {
      const t = await one<{ id: string; tenant_id: string; secret_hash: string; membership_id: string; user_id: string; full_name: string; tenant_status: string; ok: boolean; stale: boolean }>(
        tx,
        `select t.id, t.tenant_id, t.secret_hash, m.id as membership_id, m.user_id, u.full_name, tn.status as tenant_status,
                (t.revoked_at is null and m.status = 'active' and u.status = 'active') as ok,
                (t.last_used_at is null or t.last_used_at < now() - interval '1 minute') as stale
           from scim_tokens t join memberships m on m.id = t.created_by_membership_id and m.tenant_id = t.tenant_id
           join users u on u.id = m.user_id join tenants tn on tn.id = t.tenant_id
          where t.prefix = $1`,
        [parsed.prefix],
      );
      const match = safeEqual(sha256(parsed.secret), t?.secret_hash ?? '0'.repeat(64));
      if (!t || !match || !t.ok) return null;
      await tx.query(`update scim_tokens set use_count = use_count + 1${t.stale ? ', last_used_at = now()' : ''} where id = $1`, [t.id]);
      return { id: t.id, prefix: parsed.prefix, tenantId: t.tenant_id, membershipId: t.membership_id, userId: t.user_id, createdBy: t.full_name, tenantStatus: t.tenant_status };
    });
  }

  // SCIM resources -------------------------------------------------------------------------------------------------

  private resource(r: MemberRow, base: string) {
    const parts = r.full_name.trim().split(/\s+/);
    const familyName = parts.length > 1 ? parts.pop()! : '';
    const givenName = parts.join(' ');
    return {
      schemas: [SCIM_USER_SCHEMA],
      id: r.id,
      ...(r.scim_external_id ? { externalId: r.scim_external_id } : {}),
      userName: r.email,
      name: { givenName, familyName, formatted: r.full_name },
      displayName: r.full_name,
      emails: [{ value: r.email, type: 'work', primary: true }],
      active: r.status === 'active',
      meta: { resourceType: 'User', created: r.created_at.toISOString(), lastModified: r.updated_at.toISOString(), location: `${base}/Users/${r.id}` },
    };
  }

  private async log(tx: Tx, method: string, path: string, status: number, membershipId: string | null, detail?: string) {
    await tx.query('insert into scim_events (tenant_id, method, path, status, membership_id, detail) values (app_tenant_id(), $1, $2, $3, $4, $5)', [
      method, path.slice(0, 300), status, membershipId, detail?.slice(0, 500) ?? null,
    ]);
  }

  /** Records failed calls too, in their own transaction (the failing one is rolled back). */
  async logFailure(method: string, path: string, status: number, detail: string) {
    await this.db.tenant((tx) => this.log(tx, method, path, status, null, detail)).catch(() => undefined);
  }

  private async load(tx: Tx, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, undefined, 'User not found');
    const r = await one<MemberRow>(tx, `${MEMBER_SQL} where m.id = $1`, [id]);
    if (!r) throw new ScimError(404, undefined, 'User not found');
    return r;
  }

  async list(q: { filter?: string; startIndex?: number; count?: number }, base: string) {
    const f = parseScimFilter(q.filter);
    if (f === 'unsupported') throw new ScimError(400, 'invalidFilter', 'Only userName eq "…" and externalId eq "…" filters are supported');
    const start = Math.max(1, q.startIndex ?? 1);
    const count = Math.min(Math.max(0, q.count ?? 100), 200);
    return this.db.tenant(async (tx) => {
      const where = !f ? '' : f.attr === 'userName' ? 'where u.email = $3' : 'where m.scim_external_id = $3';
      const params: unknown[] = [count, start - 1, ...(f ? [f.value] : [])];
      const rows = await many<MemberRow>(tx, `${MEMBER_SQL} ${where} order by m.created_at, m.id limit $1 offset $2`, params);
      const total = (await one<{ n: number }>(tx, `select count(*)::int as n from memberships m join users u on u.id = m.user_id ${where.replace('$3', '$1')}`, f ? [f.value] : []))!.n;
      await this.log(tx, 'GET', `/Users${q.filter ? `?filter=${q.filter}` : ''}`, 200, null);
      return { schemas: [SCIM_LIST_SCHEMA], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: rows.map((r) => this.resource(r, base)) };
    });
  }

  async get(id: string, base: string) {
    return this.db.tenant(async (tx) => this.resource(await this.load(tx, id), base));
  }

  async create(input: ScimUserInput, base: string) {
    const email = scimEmail(input);
    if (!email) throw new ScimError(400, 'invalidValue', 'userName or a primary email must be an email address');
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const userId = await this.db.platform(async (ptx) => {
        const existing = await one<{ id: string }>(ptx, 'select id from users where email = $1', [email]);
        if (existing) return existing.id;
        return (await one<{ id: string }>(ptx, 'insert into users (email, full_name) values ($1, $2) returning id', [email, scimFullName(input)]))!.id;
      });
      if (await one(tx, 'select 1 from memberships where user_id = $1', [userId])) throw new ScimError(409, 'uniqueness', 'A user with this userName already exists in the workspace');
      if (input.externalId && (await one(tx, 'select 1 from memberships where scim_external_id = $1', [input.externalId]))) {
        throw new ScimError(409, 'uniqueness', 'A user with this externalId already exists');
      }
      if (input.active) {
        const { n } = (await one<{ n: number }>(tx, `select count(*)::int as n from memberships where status <> 'suspended'`))!;
        await this.entitlements.requireWithinLimit('max_employees', n, tx).catch(() => {
          throw new ScimError(409, undefined, 'The workspace has no seats left on its plan. Add seats in Plan and billing, then retry.');
        });
      }
      const legalEntity = await one<{ id: string }>(tx, 'select id from legal_entities where archived_at is null order by created_at limit 1');
      const m = (await one<{ id: string }>(
        tx,
        `insert into memberships (tenant_id, user_id, status, legal_entity_id, invited_by, scim_external_id, provisioned_by, joined_at)
         values (app_tenant_id(), $1, $2, $3, $4, $5, 'scim', null) returning id`,
        [userId, input.active ? 'active' : 'suspended', legalEntity?.id ?? null, actor.membershipId, input.externalId ?? null],
      ))!;
      const role = (await one<{ id: string }>(tx, `select id from roles where key = 'employee'`))!;
      await tx.query('insert into role_assignments (tenant_id, membership_id, role_id, granted_by) values (app_tenant_id(), $1, $2, $3)', [m.id, role.id, actor.membershipId]);
      // Connect the login to the person's employee record when HR already created one with this work email.
      const linked = await one<{ id: string }>(tx, `update employees set membership_id = $1 where id = (select id from employees where work_email = $2 and membership_id is null and status <> 'exited' limit 1) returning id`, [m.id, email]);
      await this.audit.record(tx, { action: 'membership.provisioned', resourceType: 'membership', resourceId: m.id, changes: { email, active: input.active, externalId: input.externalId ?? null, employeeId: linked?.id ?? null } });
      await this.outbox.publish(tx, actor.tenantId, 'membership.invited', { membershipId: m.id, email });
      await this.log(tx, 'POST', '/Users', 201, m.id, email);
      return this.resource(await this.load(tx, m.id), base);
    });
  }

  async replace(id: string, input: ScimUserInput, base: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.load(tx, id);
      const email = scimEmail(input);
      if (email && email !== r.email.toLowerCase()) throw new ScimError(400, 'mutability', 'Changing a user\'s email is not supported; deactivate this user and create a new one');
      const [givenName, ...rest] = scimFullName(input).split(' ');
      await this.apply(tx, r, { active: input.active, givenName: givenName ?? '', familyName: rest.join(' '), externalId: input.externalId ?? r.scim_external_id }, 'PUT');
      return this.resource(await this.load(tx, id), base);
    });
  }

  async patch(id: string, input: ScimPatchInput, base: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.load(tx, id);
      const parts = r.full_name.trim().split(/\s+/);
      const familyName = parts.length > 1 ? parts.pop()! : '';
      const { next, ignored } = applyScimPatch({ active: r.status === 'active', givenName: parts.join(' '), familyName, externalId: r.scim_external_id }, input.Operations);
      await this.apply(tx, r, next, 'PATCH', ignored.length ? `ignored: ${ignored.join(', ')}` : undefined);
      return this.resource(await this.load(tx, id), base);
    });
  }

  /** DELETE deactivates: the membership and its history are kept (payroll, audit), and the person is signed out. */
  async remove(id: string) {
    await this.db.tenant(async (tx) => {
      const r = await this.load(tx, id);
      await this.apply(tx, r, { active: false, givenName: '', familyName: '', externalId: r.scim_external_id }, 'DELETE', undefined, true);
    });
  }

  private async apply(tx: Tx, r: MemberRow, next: { active: boolean; givenName: string; familyName: string; externalId: string | null }, method: string, detail?: string, keepName = false) {
    const actor = requestContext.tenantActor();
    const owner = await one(tx, `select 1 from role_assignments ra join roles ro on ro.id = ra.role_id where ra.membership_id = $1 and ro.key = 'tenant_owner'`, [r.id]);
    if (owner && !next.active) throw new ScimError(400, 'mutability', 'Workspace owners are not deactivated by provisioning. Change owners in CREW.');
    if (r.status === 'invited' && !next.active) throw new ScimError(400, 'mutability', 'This person has a pending invitation; revoke it in CREW');
    const status = r.status === 'invited' ? 'invited' : next.active ? 'active' : 'suspended';
    if (status === 'active' && r.status === 'suspended') {
      const { n } = (await one<{ n: number }>(tx, `select count(*)::int as n from memberships where status <> 'suspended'`))!;
      await this.entitlements.requireWithinLimit('max_employees', n, tx).catch(() => {
        throw new ScimError(409, undefined, 'The workspace has no seats left on its plan');
      });
    }
    if (next.externalId !== r.scim_external_id && next.externalId && (await one(tx, 'select 1 from memberships where scim_external_id = $1 and id <> $2', [next.externalId, r.id]))) {
      throw new ScimError(409, 'uniqueness', 'Another user has this externalId');
    }
    await tx.query('update memberships set status = $2, scim_external_id = $3 where id = $1', [r.id, status, next.externalId]);
    const fullName = `${next.givenName} ${next.familyName}`.trim();
    // The login's name is shared by all its workspaces, so provisioning only renames people who belong to this one.
    if (!keepName && fullName && fullName !== r.full_name) {
      // Memberships in other workspaces are invisible here, so this check uses the platform role.
      await this.db.platform((ptx) =>
        ptx.query(
          `update users u set full_name = $2 where u.email = $1 and (select count(*) from memberships o where o.user_id = u.id) = 1`,
          [r.email, fullName.slice(0, 160)],
        ),
      );
    }
    if (status === 'suspended' && r.status !== 'suspended') {
      await this.db.platform((ptx) => ptx.query(`update sessions set revoked_at = now(), revoked_reason = 'scim_deactivated' where user_id = (select id from users where email = $1) and tenant_id = $2 and revoked_at is null`, [r.email, actor.tenantId]));
    }
    const changed = status !== r.status ? (status === 'suspended' ? 'membership.suspended' : 'membership.reactivated') : 'membership.updated';
    await this.audit.record(tx, { action: changed, resourceType: 'membership', resourceId: r.id, changes: { status: [r.status, status], externalId: next.externalId }, metadata: { via: 'scim' } });
    await this.outbox.publish(tx, actor.tenantId, 'membership.changed', { membershipId: r.id, fields: ['status'] });
    await this.log(tx, method, `/Users/${r.id}`, method === 'DELETE' ? 204 : 200, r.id, detail);
  }
}
