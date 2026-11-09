import { Injectable } from '@nestjs/common';
import { API_KEY_PREFIX, type ApiKeyInput, parseApiKey } from '@crew/contracts';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { randomToken, safeEqual, sha256 } from '../../platform/auth/crypto';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { membershipNames } from './common';

export interface ApiKeyIdentity {
  id: string;
  name: string;
  prefix: string;
  tenantId: string;
  membershipId: string;
  userId: string;
  scopes: string[];
  tenantStatus: string;
  label: string;
}

const PREFIX_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newPrefix = () => [...randomBytes(10)].map((b) => PREFIX_CHARS[b % PREFIX_CHARS.length]).join('');

/**
 * Workspace API keys. A key is shown once when created and only its SHA-256 hash is kept. It acts as the person
 * who created it, limited to the read-only scopes chosen, so it can never do more than that person can do now.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return this.db.tenant(async (tx) => {
      const now = new Date();
      const keys = await tx.collection('api_keys').find({}, { sort: { created_at: -1 } });
      const who = await membershipNames(tx, keys.map((k) => k.created_by_membership_id));
      const rows = keys.map((k) => {
        const creator = who.get(k.created_by_membership_id);
        const status = k.revoked_at ? 'revoked' : k.expires_at && k.expires_at <= now ? 'expired' : creator?.status !== 'active' ? 'owner_inactive' : 'active';
        return {
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          scopes: k.scopes,
          expiresAt: k.expires_at ?? null,
          lastUsedAt: k.last_used_at ?? null,
          lastUsedIp: k.last_used_ip ?? null,
          useCount: k.use_count,
          revokedAt: k.revoked_at ?? null,
          createdAt: k.created_at,
          createdBy: creator?.name ?? null,
          status,
        };
      });
      // Current keys first, newest first within each group.
      return [...rows.filter((k) => !k.revokedAt), ...rows.filter((k) => k.revokedAt)];
    });
  }

  async create(input: ApiKeyInput) {
    const actor = requestContext.tenantActor();
    const prefix = newPrefix();
    const secret = randomToken(32);
    const token = `${API_KEY_PREFIX}${prefix}_${secret}`;
    const row = await this.db.tenant(async (tx) => {
      const r = await tx.collection('api_keys').insert({
        name: input.name,
        prefix,
        secret_hash: sha256(secret),
        scopes: input.scopes,
        created_by_membership_id: actor.membershipId,
        expires_at: input.expiresInDays == null ? null : new Date(Date.now() + input.expiresInDays * 86_400_000),
      });
      await this.audit.record(tx, { action: 'api_key.created', resourceType: 'api_key', resourceId: r.id, metadata: { name: input.name, prefix, scopes: input.scopes, expiresAt: r.expires_at } });
      return r;
    });
    // The full key is returned this once and never again.
    return { id: row.id, name: input.name, prefix, scopes: input.scopes, expiresAt: row.expires_at, key: token };
  }

  async revoke(id: string) {
    return this.db.tenant(async (tx) => {
      const k = await tx.collection('api_keys').findOne({ id });
      if (!k) throw Errors.notFound('API key');
      if (k.revoked_at) throw Errors.conflict('already_revoked', 'This key is already revoked.');
      await tx.collection('api_keys').updateOne({ id }, { $set: { revoked_at: new Date(), revoked_by_membership_id: requestContext.tenantActor().membershipId } });
      await this.audit.record(tx, { action: 'api_key.revoked', resourceType: 'api_key', resourceId: id, metadata: { prefix: k.prefix } });
      return { ok: true };
    });
  }

  /**
   * Checks a presented key. Returns null for anything that is not a valid, current key of an active member in an
   * existing workspace. Runs before the workspace is known, so it uses the platform role for this one lookup.
   */
  async authenticate(token: string, ip: string | undefined): Promise<ApiKeyIdentity | null> {
    const parsed = parseApiKey(token);
    if (!parsed) return null;
    return this.db.platform(async (tx) => {
      const now = new Date();
      const key = await tx.collection('api_keys').findOne({ prefix: parsed.prefix });
      const m = key && (await tx.collection('memberships').findOne({ id: key.created_by_membership_id, tenant_id: key.tenant_id }));
      const u = m && (await tx.collection('users').findOne({ id: m.user_id }));
      const t = u && (await tx.collection('tenants').findOne({ id: key!.tenant_id }));
      const k = t && {
        id: key!.id as string,
        name: key!.name as string,
        tenant_id: key!.tenant_id as string,
        secret_hash: key!.secret_hash as string,
        scopes: key!.scopes as string[],
        membership_id: m!.id as string,
        user_id: m!.user_id as string,
        tenant_status: t.status as string,
        full_name: u!.full_name as string,
        ok: !key!.revoked_at && (!key!.expires_at || key!.expires_at > now) && m!.status === 'active' && u!.status === 'active',
        stale: !key!.last_used_at || key!.last_used_at < new Date(now.getTime() - 60_000),
      };
      // Compare hashes in constant time whether or not the prefix matched, so timing does not reveal valid prefixes.
      const match = safeEqual(sha256(parsed.secret), k?.secret_hash ?? '0'.repeat(64));
      if (!k || !match || !k.ok) return null;
      await tx.collection('api_keys').updateOne({ id: k.id }, { $inc: { use_count: 1 }, ...(k.stale ? { $set: { last_used_at: now, last_used_ip: ip ?? null } } : {}) });
      return { id: k.id, name: k.name, prefix: parsed.prefix, tenantId: k.tenant_id, membershipId: k.membership_id, userId: k.user_id, scopes: k.scopes, tenantStatus: k.tenant_status, label: `API key "${k.name}" (${parsed.prefix}, created by ${k.full_name})` };
    });
  }
}
