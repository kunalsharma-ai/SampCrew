import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { provisionTenant } from '@crew/db';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { hashPassword } from '../src/platform/auth/crypto';

export const PASSWORD = 'Correct-Horse-42!';
let cachedHash: string | undefined;
const passwordHash = async () => (cachedHash ??= await hashPassword(PASSWORD));

export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

export const adminPool = () => new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 4 });

export interface TestTenant {
  id: string;
  slug: string;
  legalEntityId: string;
  ownerEmail: string;
  ownerMembershipId: string;
}

export async function createTenant(pool: Pool, opts: { plan?: string; trialDays?: number } = {}): Promise<TestTenant> {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `owner@${slug}.test`;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const t = await provisionTenant(client, {
      name: `Tenant ${slug}`,
      slug,
      countryCode: 'IN',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      owner: { email: ownerEmail, fullName: 'Owner Person', passwordHash: await passwordHash() },
      plan: { key: opts.plan ?? 'business', seats: 50, billingCycle: 'monthly', trialDays: opts.trialDays ?? 0 },
    });
    await client.query('commit');
    return { id: t.tenantId, slug, legalEntityId: t.legalEntityId, ownerEmail, ownerMembershipId: t.ownerMembershipId };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function addMember(
  pool: Pool,
  tenant: TestTenant,
  opts: { roles?: string[]; departmentId?: string | null; managerId?: string | null; legalEntityId?: string | null; constraints?: Record<string, unknown>; name?: string } = {},
): Promise<{ email: string; membershipId: string; userId: string }> {
  const email = `${randomUUID().slice(0, 8)}@${tenant.slug}.test`;
  const u = await pool.query<{ id: string }>(`insert into users (email, full_name, password_hash) values ($1, $2, $3) returning id`, [email, opts.name ?? 'Member Person', await passwordHash()]);
  const m = await pool.query<{ id: string }>(
    `insert into memberships (tenant_id, user_id, status, legal_entity_id, department_id, manager_membership_id, joined_at)
     values ($1, $2, 'active', $3, $4, $5, now()) returning id`,
    [tenant.id, u.rows[0]!.id, opts.legalEntityId === undefined ? tenant.legalEntityId : opts.legalEntityId, opts.departmentId ?? null, opts.managerId ?? null],
  );
  for (const key of ['employee', ...(opts.roles ?? [])]) {
    await pool.query(
      `insert into role_assignments (tenant_id, membership_id, role_id, constraints) select $1, $2, id, $4 from roles where tenant_id = $1 and key = $3`,
      [tenant.id, m.rows[0]!.id, key, JSON.stringify(key === 'employee' ? {} : (opts.constraints ?? {}))],
    );
  }
  return { email, membershipId: m.rows[0]!.id, userId: u.rows[0]!.id };
}

export async function login(app: INestApplication, email: string, password = PASSWORD, tenantSlug?: string) {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password, tenantSlug });
  if (res.body.status !== 'ok') throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { accessToken: string; refreshToken: string };
}

export const api = (app: INestApplication, token?: string) => {
  const agent = request(app.getHttpServer());
  const wrap = (method: 'get' | 'post' | 'put' | 'patch' | 'delete') => (path: string) => {
    const r = agent[method](`/api/v1${path}`);
    return token ? r.set('authorization', `Bearer ${token}`) : r;
  };
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
};

export async function department(pool: Pool, tenant: TestTenant, name: string, parentId: string | null = null) {
  const r = await pool.query<{ id: string }>(`insert into departments (tenant_id, name, parent_id, legal_entity_id) values ($1, $2, $3, $4) returning id`, [tenant.id, name, parentId, tenant.legalEntityId]);
  return r.rows[0]!.id;
}

/**
 * Signs in and upgrades the session to MFA-verified, as if the user had completed a TOTP challenge.
 * (The real TOTP flow is covered in auth.spec.ts; this keeps other tests focused on what they test.)
 */
export async function loginWithMfa(app: INestApplication, pool: Pool, email: string, tenantSlug?: string) {
  const s = await login(app, email, PASSWORD, tenantSlug);
  await pool.query(`update sessions set mfa_verified = true where refresh_token_hash = encode(sha256($1::bytea), 'hex')`, [s.refreshToken]);
  const res = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
  return res.body as { accessToken: string; refreshToken: string };
}
