import { Inject, Injectable } from '@nestjs/common';
import {
  applyScimPatch, parseScimFilter, parseScimToken, SCIM_LIST_SCHEMA, SCIM_TOKEN_PREFIX, SCIM_USER_SCHEMA, type ScimPatchInput, scimEmail, scimFullName,
  type ScimUserInput,
} from '@crew/contracts';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { randomToken, safeEqual, sha256 } from '../../platform/auth/crypto';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { AppError, Errors } from '../../platform/http/errors';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';

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

/** Memberships with the person's email and name, as SCIM resources are built from them. */
async function memberRows(tx: TenantTx, filter: Record<string, unknown>, options: { sort?: Record<string, 1 | -1>; skip?: number; limit?: number } = {}): Promise<MemberRow[]> {
  const memberships = await tx.collection('memberships').find(filter, { sort: options.sort, skip: options.skip, limit: options.limit });
  const users = new Map((await (await tx.users()).find({ id: { $in: memberships.map((m) => m.user_id) } })).map((u) => [u.id as string, u]));
  return memberships.map((m) => ({
    id: m.id,
    email: users.get(m.user_id)?.email,
    full_name: users.get(m.user_id)?.full_name,
    status: m.status,
    scim_external_id: m.scim_external_id ?? null,
    created_at: m.created_at,
    updated_at: m.updated_at,
  }));
}

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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // Tokens (managed by owners in Settings) ------------------------------------------------------------------------

  async status() {
    return this.db.tenant(async (tx) => ({
      baseUrl: `${this.config.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/scim/v2`,
      token: await (async () => {
        const t = await tx.collection('scim_tokens').findOne({ revoked_at: null });
        if (!t) return undefined;
        const creator = await tx.collection('memberships').findOne({ id: t.created_by_membership_id });
        const user = creator && (await (await tx.users()).findOne({ id: creator.user_id }));
        if (!user) return undefined;
        return { id: t.id, prefix: t.prefix, lastUsedAt: t.last_used_at ?? null, useCount: t.use_count, createdAt: t.created_at, createdBy: user.full_name };
      })(),
      provisioned: await tx.collection('memberships').count({ provisioned_by: 'scim', status: 'active' }),
      events: (await tx.collection('scim_events').find({}, { sort: { created_at: -1 }, limit: 50 })).map((e) => ({ method: e.method, path: e.path, status: e.status, detail: e.detail ?? null, createdAt: e.created_at })),
    }));
  }

  /** Creates a token, replacing any current one (which stops working at once). Returned this once. */
  async createToken() {
    const actor = requestContext.tenantActor();
    const prefix = newPrefix();
    const secret = randomToken(32);
    await this.db.tenant(async (tx) => {
      const old = await tx.collection('scim_tokens').updateAndGet({ revoked_at: null }, { $set: { revoked_at: new Date() } });
      const r = await tx.collection('scim_tokens').insert({ prefix, secret_hash: sha256(secret), created_by_membership_id: actor.membershipId });
      await this.audit.record(tx, { action: 'scim.token_created', resourceType: 'scim_token', resourceId: r.id, metadata: { prefix, replaced: old?.id ?? null } });
    });
    return { token: `${SCIM_TOKEN_PREFIX}${prefix}_${secret}`, prefix };
  }

  async revokeToken() {
    await this.db.tenant(async (tx) => {
      const old = await tx.collection('scim_tokens').updateAndGet({ revoked_at: null }, { $set: { revoked_at: new Date() } });
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
      const token = await tx.collection('scim_tokens').findOne({ prefix: parsed.prefix });
      const m = token && (await tx.collection('memberships').findOne({ id: token.created_by_membership_id, tenant_id: token.tenant_id }));
      const u = m && (await tx.collection('users').findOne({ id: m.user_id }));
      const tn = u && (await tx.collection('tenants').findOne({ id: token!.tenant_id }));
      const t = tn && {
        id: token!.id as string,
        tenant_id: token!.tenant_id as string,
        secret_hash: token!.secret_hash as string,
        membership_id: m!.id as string,
        user_id: m!.user_id as string,
        full_name: u!.full_name as string,
        tenant_status: tn.status as string,
        ok: !token!.revoked_at && m!.status === 'active' && u!.status === 'active',
        stale: !token!.last_used_at || token!.last_used_at < new Date(Date.now() - 60_000),
      };
      const match = safeEqual(sha256(parsed.secret), t?.secret_hash ?? '0'.repeat(64));
      if (!t || !match || !t.ok) return null;
      await tx.collection('scim_tokens').updateOne({ id: t.id }, { $inc: { use_count: 1 }, ...(t.stale ? { $set: { last_used_at: new Date() } } : {}) });
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

  private async log(tx: TenantTx, method: string, path: string, status: number, membershipId: string | null, detail?: string) {
    await tx.collection('scim_events').insert({ method, path: path.slice(0, 300), status, membership_id: membershipId, detail: detail?.slice(0, 500) ?? null });
  }

  /** Records failed calls too, in their own transaction (the failing one is rolled back). */
  async logFailure(method: string, path: string, status: number, detail: string) {
    await this.db.tenant((tx) => this.log(tx, method, path, status, null, detail)).catch(() => undefined);
  }

  private async load(tx: TenantTx, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, undefined, 'User not found');
    const [r] = await memberRows(tx, { id });
    if (!r) throw new ScimError(404, undefined, 'User not found');
    return r;
  }

  async list(q: { filter?: string; startIndex?: number; count?: number }, base: string) {
    const f = parseScimFilter(q.filter);
    if (f === 'unsupported') throw new ScimError(400, 'invalidFilter', 'Only userName eq "…" and externalId eq "…" filters are supported');
    const start = Math.max(1, q.startIndex ?? 1);
    const count = Math.min(Math.max(0, q.count ?? 100), 200);
    return this.db.tenant(async (tx) => {
      let filter: Record<string, unknown> = {};
      if (f?.attr === 'userName') {
        const user = await (await tx.users()).findOne({ email: f.value });
        filter = { user_id: user?.id ?? null, ...(user ? {} : { _id: { $in: [] } }) };
      } else if (f) filter = { scim_external_id: f.value };
      const rows = await memberRows(tx, filter, { sort: { created_at: 1, _id: 1 }, skip: start - 1, limit: count });
      const total = await tx.collection('memberships').count(filter);
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
      // Identities are global: found or created outside the workspace, in this same transaction.
      const users = tx.unscoped('users');
      const userId = ((await users.findOne({ email }, { projection: { _id: 1 } })) ?? (await users.insert({ email, full_name: scimFullName(input) }))).id as string;
      if (await tx.collection('memberships').exists({ user_id: userId })) throw new ScimError(409, 'uniqueness', 'A user with this userName already exists in the workspace');
      if (input.externalId && (await tx.collection('memberships').exists({ scim_external_id: input.externalId }))) {
        throw new ScimError(409, 'uniqueness', 'A user with this externalId already exists');
      }
      if (input.active) {
        const n = await tx.collection('memberships').count({ status: { $ne: 'suspended' } });
        await this.entitlements.requireWithinLimit('max_employees', n, tx).catch(() => {
          throw new ScimError(409, undefined, 'The workspace has no seats left on its plan. Add seats in Plan and billing, then retry.');
        });
      }
      const legalEntity = await tx.collection('legal_entities').findOne({ archived_at: null }, { sort: { created_at: 1 } });
      const m = await tx.collection('memberships').insert({
        user_id: userId,
        status: input.active ? 'active' : 'suspended',
        legal_entity_id: legalEntity?.id ?? null,
        invited_by: actor.membershipId,
        scim_external_id: input.externalId ?? null,
        provisioned_by: 'scim',
        joined_at: null,
      });
      const role = (await tx.collection('roles').findOne({ key: 'employee' }))!;
      await tx.collection('role_assignments').insert({ membership_id: m.id, role_id: role.id, granted_by: actor.membershipId });
      // Connect the login to the person's employee record when HR already created one with this work email.
      const linked = await tx.collection('employees').updateAndGet({ work_email: email, membership_id: null, status: { $ne: 'exited' } }, { $set: { membership_id: m.id } });
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

  private async apply(tx: TenantTx, r: MemberRow, next: { active: boolean; givenName: string; familyName: string; externalId: string | null }, method: string, detail?: string, keepName = false) {
    const actor = requestContext.tenantActor();
    const ownerRole = await tx.collection('roles').findOne({ key: 'tenant_owner' });
    const owner = ownerRole && (await tx.collection('role_assignments').exists({ membership_id: r.id, role_id: ownerRole.id }));
    if (owner && !next.active) throw new ScimError(400, 'mutability', 'Workspace owners are not deactivated by provisioning. Change owners in SampCrew.');
    if (r.status === 'invited' && !next.active) throw new ScimError(400, 'mutability', 'This person has a pending invitation; revoke it in SampCrew');
    const status = r.status === 'invited' ? 'invited' : next.active ? 'active' : 'suspended';
    if (status === 'active' && r.status === 'suspended') {
      const n = await tx.collection('memberships').count({ status: { $ne: 'suspended' } });
      await this.entitlements.requireWithinLimit('max_employees', n, tx).catch(() => {
        throw new ScimError(409, undefined, 'The workspace has no seats left on its plan');
      });
    }
    if (next.externalId !== r.scim_external_id && next.externalId && (await tx.collection('memberships').exists({ scim_external_id: next.externalId, id: { $ne: r.id } }))) {
      throw new ScimError(409, 'uniqueness', 'Another user has this externalId');
    }
    await tx.collection('memberships').updateOne({ id: r.id }, { $set: { status, scim_external_id: next.externalId } });
    const fullName = `${next.givenName} ${next.familyName}`.trim();
    // The login's name is shared by all its workspaces, so provisioning only renames people who belong to this one.
    if (!keepName && fullName && fullName !== r.full_name) {
      // Memberships in other workspaces are invisible here, so this check reads past the workspace (same transaction).
      const user = await tx.unscoped('users').findOne({ email: r.email });
      if (user && (await tx.unscoped('memberships').count({ user_id: user.id })) === 1) await tx.unscoped('users').updateOne({ id: user.id }, { $set: { full_name: fullName.slice(0, 160) } });
    }
    if (status === 'suspended' && r.status !== 'suspended') {
      const user = await tx.unscoped('users').findOne({ email: r.email }, { projection: { _id: 1 } });
      if (user) await tx.unscoped('sessions').update({ user_id: user.id, tenant_id: actor.tenantId, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'scim_deactivated' } });
    }
    const changed = status !== r.status ? (status === 'suspended' ? 'membership.suspended' : 'membership.reactivated') : 'membership.updated';
    await this.audit.record(tx, { action: changed, resourceType: 'membership', resourceId: r.id, changes: { status: [r.status, status], externalId: next.externalId }, metadata: { via: 'scim' } });
    await this.outbox.publish(tx, actor.tenantId, 'membership.changed', { membershipId: r.id, fields: ['status'] });
    await this.log(tx, method, `/Users/${r.id}`, method === 'DELETE' ? 204 : 200, r.id, detail);
  }
}
