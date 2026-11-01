import { Injectable } from '@nestjs/common';
import { API_KEY_PREFIX, type ApiKeyInput, parseApiKey } from '@crew/contracts';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { randomToken, safeEqual, sha256 } from '../../platform/auth/crypto';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { BY, WHO } from './common';

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
    return this.db.tenant((tx) =>
      many(
        tx,
        `select k.id, k.name, k.prefix, k.scopes, k.expires_at as "expiresAt", k.last_used_at as "lastUsedAt", k.last_used_ip::text as "lastUsedIp",
                k.use_count::int as "useCount", k.revoked_at as "revokedAt", k.created_at as "createdAt", ${WHO('cu', 'ce')} as "createdBy",
                case when k.revoked_at is not null then 'revoked' when k.expires_at is not null and k.expires_at <= now() then 'expired'
                     when cm.status <> 'active' then 'owner_inactive' else 'active' end as status
           from api_keys k ${BY('k.created_by_membership_id', 'c')}
          order by k.revoked_at is not null, k.created_at desc`,
      ),
    );
  }

  async create(input: ApiKeyInput) {
    const actor = requestContext.tenantActor();
    const prefix = newPrefix();
    const secret = randomToken(32);
    const token = `${API_KEY_PREFIX}${prefix}_${secret}`;
    const row = await this.db.tenant(async (tx) => {
      const r = (await one<{ id: string; expires_at: string | null }>(
        tx,
        `insert into api_keys (tenant_id, name, prefix, secret_hash, scopes, created_by_membership_id, expires_at)
         values (app_tenant_id(), $1, $2, $3, $4, $5, case when $6::int is null then null else now() + make_interval(days => $6::int) end) returning id, expires_at`,
        [input.name, prefix, sha256(secret), input.scopes, actor.membershipId, input.expiresInDays],
      ))!;
      await this.audit.record(tx, { action: 'api_key.created', resourceType: 'api_key', resourceId: r.id, metadata: { name: input.name, prefix, scopes: input.scopes, expiresAt: r.expires_at } });
      return r;
    });
    // The full key is returned this once and never again.
    return { id: row.id, name: input.name, prefix, scopes: input.scopes, expiresAt: row.expires_at, key: token };
  }

  async revoke(id: string) {
    return this.db.tenant(async (tx) => {
      const k = await one<{ revoked_at: string | null; prefix: string }>(tx, 'select revoked_at, prefix from api_keys where id = $1', [id]);
      if (!k) throw Errors.notFound('API key');
      if (k.revoked_at) throw Errors.conflict('already_revoked', 'This key is already revoked.');
      await tx.query('update api_keys set revoked_at = now(), revoked_by_membership_id = $2 where id = $1', [id, requestContext.tenantActor().membershipId]);
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
      const k = await one<{ id: string; name: string; tenant_id: string; secret_hash: string; scopes: string[]; membership_id: string; user_id: string; ok: boolean; tenant_status: string; full_name: string; stale: boolean }>(
        tx,
        `select k.id, k.name, k.tenant_id, k.secret_hash, k.scopes, m.id as membership_id, m.user_id, t.status as tenant_status, u.full_name,
                (k.revoked_at is null and (k.expires_at is null or k.expires_at > now()) and m.status = 'active' and u.status = 'active') as ok,
                (k.last_used_at is null or k.last_used_at < now() - interval '1 minute') as stale
           from api_keys k join memberships m on m.id = k.created_by_membership_id and m.tenant_id = k.tenant_id
           join users u on u.id = m.user_id join tenants t on t.id = k.tenant_id
          where k.prefix = $1`,
        [parsed.prefix],
      );
      // Compare hashes in constant time whether or not the prefix matched, so timing does not reveal valid prefixes.
      const match = safeEqual(sha256(parsed.secret), k?.secret_hash ?? '0'.repeat(64));
      if (!k || !match || !k.ok) return null;
      if (k.stale) await tx.query('update api_keys set last_used_at = now(), last_used_ip = $2, use_count = use_count + 1 where id = $1', [k.id, ip ?? null]);
      else await tx.query('update api_keys set use_count = use_count + 1 where id = $1', [k.id]);
      return { id: k.id, name: k.name, prefix: parsed.prefix, tenantId: k.tenant_id, membershipId: k.membership_id, userId: k.user_id, scopes: k.scopes, tenantStatus: k.tenant_status, label: `API key "${k.name}" (${parsed.prefix}, created by ${k.full_name})` };
    });
  }
}
