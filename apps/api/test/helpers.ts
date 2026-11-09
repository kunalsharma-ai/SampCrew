import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mongo } from '@crew/db';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { hashPassword, sha256 } from '../src/platform/auth/crypto';
import type { AppConfig } from '../src/platform/config/config';
import { MongoService, type PlatformTx, type TenantTx } from '../src/platform/database/mongo.service';

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

/**
 * Direct access to the test database, for arranging data and checking what the API stored. Each call runs in its
 * own unrestricted (platform) transaction unless it is given one.
 */
export class TestDb {
  readonly svc = new MongoService({ MONGODB_URL: process.env.MONGODB_URL, MONGODB_POOL_MAX: 4 } as AppConfig);

  platform<T>(fn: (tx: PlatformTx) => Promise<T>): Promise<T> {
    return this.svc.platform(fn);
  }

  tenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.svc.tenant(fn, { tenantId });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  one<T = Record<string, any>>(table: string, filter: Record<string, unknown> = {}, options: { sort?: Record<string, 1 | -1> } = {}): Promise<T | undefined> {
    return this.platform((tx) => tx.collection(table).findOne(filter, options) as Promise<T | undefined>);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  find<T = Record<string, any>>(table: string, filter: Record<string, unknown> = {}, options: { sort?: Record<string, 1 | -1>; limit?: number } = {}): Promise<T[]> {
    return this.platform((tx) => tx.collection(table).find(filter, options) as Promise<T[]>);
  }

  count(table: string, filter: Record<string, unknown> = {}): Promise<number> {
    return this.platform((tx) => tx.collection(table).count(filter));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(table: string, row: Record<string, unknown>): Promise<Record<string, any>> {
    return this.platform((tx) => tx.collection(table).insert(row));
  }

  update(table: string, filter: Record<string, unknown>, update: Record<string, unknown>): Promise<number> {
    return this.platform((tx) => tx.collection(table).update(filter, update));
  }

  delete(table: string, filter: Record<string, unknown>): Promise<number> {
    return this.platform((tx) => tx.collection(table).delete(filter));
  }

  /** The raw database, for writes the data rules would refuse (e.g. tampering with the audit trail in a test). */
  database() {
    return this.svc.database();
  }

  end(): Promise<void> {
    return this.svc.onModuleDestroy();
  }
}

export const adminPool = () => new TestDb();

export interface TestTenant {
  id: string;
  slug: string;
  legalEntityId: string;
  ownerEmail: string;
  ownerMembershipId: string;
}

export async function createTenant(db: TestDb, opts: { plan?: string; trialDays?: number } = {}): Promise<TestTenant> {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const ownerEmail = `owner@${slug}.test`;
  const owner = { email: ownerEmail, fullName: 'Owner Person', passwordHash: await passwordHash() };
  const t = await db.platform((tx) =>
    mongo.provisionTenantMongo(tx, {
      name: `Tenant ${slug}`,
      slug,
      countryCode: 'IN',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      owner,
      plan: { key: opts.plan ?? 'business', seats: 50, billingCycle: 'monthly', trialDays: opts.trialDays ?? 0 },
    }),
  );
  return { id: t.tenantId, slug, legalEntityId: t.legalEntityId, ownerEmail, ownerMembershipId: t.ownerMembershipId };
}

export async function addMember(
  db: TestDb,
  tenant: TestTenant,
  opts: { roles?: string[]; departmentId?: string | null; managerId?: string | null; legalEntityId?: string | null; constraints?: Record<string, unknown>; name?: string } = {},
): Promise<{ email: string; membershipId: string; userId: string }> {
  const email = `${randomUUID().slice(0, 8)}@${tenant.slug}.test`;
  const hash = await passwordHash();
  return db.platform(async (tx) => {
    const u = await tx.collection('users').insert({ email, full_name: opts.name ?? 'Member Person', password_hash: hash });
    const m = await tx.collection('memberships').insert({
      tenant_id: tenant.id,
      user_id: u.id,
      status: 'active',
      legal_entity_id: opts.legalEntityId === undefined ? tenant.legalEntityId : opts.legalEntityId,
      department_id: opts.departmentId ?? null,
      manager_membership_id: opts.managerId ?? null,
      joined_at: new Date(),
    });
    for (const key of ['employee', ...(opts.roles ?? [])]) {
      const role = await tx.collection('roles').findOne({ tenant_id: tenant.id, key });
      if (role) await tx.collection('role_assignments').insert({ tenant_id: tenant.id, membership_id: m.id, role_id: role.id, constraints: key === 'employee' ? {} : (opts.constraints ?? {}) });
    }
    return { email, membershipId: m.id as string, userId: u.id as string };
  });
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

export async function department(db: TestDb, tenant: TestTenant, name: string, parentId: string | null = null) {
  return (await db.insert('departments', { tenant_id: tenant.id, name, parent_id: parentId, legal_entity_id: tenant.legalEntityId })).id as string;
}

/**
 * Signs in and upgrades the session to MFA-verified, as if the user had completed a TOTP challenge.
 * (The real TOTP flow is covered in auth.spec.ts; this keeps other tests focused on what they test.)
 */
export async function loginWithMfa(app: INestApplication, db: TestDb, email: string, tenantSlug?: string) {
  const s = await login(app, email, PASSWORD, tenantSlug);
  await db.update('sessions', { refresh_token_hash: sha256(s.refreshToken) }, { $set: { mfa_verified: true } });
  const res = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken });
  return res.body as { accessToken: string; refreshToken: string };
}
