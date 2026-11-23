import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mongo } from '@crew/db';
import request from 'supertest';
import { expect } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { hashPassword, sha256 } from '../src/platform/auth/crypto';
import type { AppConfig } from '../src/platform/config/config';
import { MongoService, type PlatformTx, type TenantTx } from '../src/platform/database/mongo.service';
import { PlatformIntegrationsService } from '../src/platform/integrations/platform-integrations.service';
import { CONSOLE_DELETE_ACTIONS, DELETE_AREA_LIST, deleteActionFor, LEVEL_ROLE_KEY, WORKSPACE_DELETE_ACTIONS, mapLegacyAccess, SYSTEM_ROLES, type PlatformIntegrationKey, type Scope } from '@crew/contracts';

export const PASSWORD = 'Correct-Horse-42!';
let cachedHash: string | undefined;
export const passwordHash = async () => (cachedHash ??= await hashPassword(PASSWORD));

/**
 * Saves an installation-wide integration the way the Console does (encrypted, audited). Integrations live only in the
 * database, which every test file shares, so a file that sets one removes it again with clearIntegration.
 */
export async function setIntegration(app: INestApplication, key: PlatformIntegrationKey, values: Record<string, unknown>) {
  return app.get(PlatformIntegrationsService).save(key, values, { label: 'test setup' });
}

export async function clearIntegration(app: INestApplication, key: PlatformIntegrationKey) {
  await app.get(PlatformIntegrationsService).reset(key, { label: 'test setup' }).catch(() => undefined);
}

export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: process.env.TEST_LOGS ? ['error'] : false });
  configureApp(app);
  // Listening once for the whole file (closed by app.close()): the request helper sends the password confirmation of
  // a delete just before the delete, and supertest would otherwise stop its own server between the two requests.
  await app.listen(0, '127.0.0.1');
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

/** A test workspace. Leave types are left out unless asked for, so each test sets up exactly the ones it checks. */
/**
 * Delete permissions are switched on for HR Workspace (central) and Employee Workspace in every area unless
 * `deletes: false`, so tests of other features can delete; delete-permissions.spec.ts checks the refusals.
 */
export async function createTenant(db: TestDb, opts: { plan?: string; trialDays?: number; standardLeaveTypes?: boolean; deletes?: boolean } = {}): Promise<TestTenant> {
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
      leaveTypes: opts.standardLeaveTypes ? 'standard' : 'none',
    }),
  );
  const tenant = { id: t.tenantId, slug, legalEntityId: t.legalEntityId, ownerEmail, ownerMembershipId: t.ownerMembershipId };
  if (opts.deletes !== false) {
    for (const level of ['hr', 'employee'] as const) await allowDeletes(db, tenant, level, DELETE_AREA_LIST.filter((a) => (a.levels as readonly string[]).includes(level)).map((a) => a.key));
  }
  return tenant;
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
    // Tests name the roles of the time before the four access levels: they map to a level as the migration does.
    for (const { key, constraints } of accessRows(opts.roles ?? [], opts.constraints ?? {}, { legalEntityId: (m.legal_entity_id as string) ?? null, departmentId: opts.departmentId ?? null })) {
      const role = await tx.collection('roles').findOne({ tenant_id: tenant.id, key, is_system: true });
      if (role) await tx.collection('role_assignments').insert({ tenant_id: tenant.id, membership_id: m.id, role_id: role.id, constraints });
    }
    return { email, membershipId: m.id as string, userId: u.id as string };
  });
}

export async function login(app: INestApplication, email: string, password = PASSWORD, tenantSlug?: string) {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password, tenantSlug });
  if (res.body.status !== 'ok') throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { accessToken: string; refreshToken: string };
}

/**
 * Request helper. Every delete action needs the person's password typed just before it (contracts
 * delete-permissions.ts): like the apps, the helper confirms with the test password right before sending one, so the
 * tests of each module keep testing their module. Pass { confirmDelete: false } to send a delete without it (the
 * delete-permissions tests do). The level permission is never filled in: tests switch it on like the Super Workspace.
 */
export const api = (app: INestApplication, token?: string, opts: { confirmDelete?: boolean; password?: string } = {}) => {
  const agent = request(app.getHttpServer());
  const wrap = (method: 'get' | 'post' | 'put' | 'patch' | 'delete') => (path: string) => {
    const r = agent[method](`/api/v1${path}`);
    const out = token ? r.set('authorization', `Bearer ${token}`) : r;
    if (method === 'get' || !token || opts.confirmDelete === false) return out;
    const then = out.then.bind(out);
    (out as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const body = (out as unknown as { _data?: unknown })._data;
      const console = path.startsWith('/platform/');
      const action = deleteActionFor(console ? CONSOLE_DELETE_ACTIONS : WORKSPACE_DELETE_ACTIONS, path, method, body);
      const confirm = action
        ? request(app.getHttpServer()).post(console ? '/api/v1/platform/auth/delete-confirmation' : '/api/v1/me/delete-confirmation')
          .set('authorization', `Bearer ${token}`).send({ password: opts.password ?? PASSWORD }).then(() => undefined, () => undefined)
        : Promise.resolve();
      return confirm.then(() => then(resolve, reject));
    };
    return out;
  };
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
};

/** Settings > Workspace Permissions: the Super Workspace switches delete areas on for HR Workspace or Employee Workspace. */
export async function allowDeletes(db: TestDb, tenant: TestTenant, level: 'hr' | 'employee', areas: string[], groupId = level === 'hr' ? 'central' : 'all') {
  const subjectType = level === 'hr' ? 'hr_workspace' : 'employee_workspace';
  const existing = await db.one('level_permissions', { tenant_id: tenant.id, subject_type: subjectType, subject_id: groupId });
  const permissions = { ...((existing?.permissions ?? {}) as Record<string, boolean>), ...Object.fromEntries(areas.map((a) => [`delete.${a}`, true])) };
  if (existing) await db.update('level_permissions', { id: existing.id }, { $set: { permissions } });
  else await db.insert('level_permissions', { tenant_id: tenant.id, subject_type: subjectType, subject_id: groupId, permissions, scope_hr_workspace_ids: null });
}

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

/**
 * Checks that rows of `owner` in each table are invisible from another workspace's transaction (the database-level
 * check that row-level security made on PostgreSQL). Returns how many rows of the owner each table held.
 */
export async function expectHiddenFrom(db: TestDb, owner: TestTenant, viewer: TestTenant, tables: string[]): Promise<Record<string, number>> {
  const held: Record<string, number> = {};
  for (const table of tables) {
    const ids = (await db.find(table, { tenant_id: owner.id })).map((x) => x.id);
    held[table] = ids.length;
    expect(await db.tenant(viewer.id, (tx) => tx.collection(table).count({ id: { $in: ids } })), table).toBe(0);
  }
  return held;
}

/** The level assignments a list of role keys (old or new) gives: Employee Workspace plus the level they map to. */
export function accessRows(roles: string[], constraints: Record<string, unknown>, member: { legalEntityId: string | null; departmentId: string | null }) {
  const legacy = roles.map((key) => {
    const tpl = SYSTEM_ROLES.find((r) => r.key === key);
    return { key, isSystem: true, grants: Object.entries(tpl?.grants ?? {}).map(([permission, scope]) => ({ permission, scope: scope as Scope })), constraints };
  });
  const mapped = mapLegacyAccess(legacy, member);
  const rows: { key: string; constraints: Record<string, unknown> }[] = [{ key: 'employee_workspace', constraints: {} }];
  if (mapped.level !== 'employee') rows.push({ key: LEVEL_ROLE_KEY[mapped.level], constraints: mapped.constraints as Record<string, unknown> });
  return rows;
}

/**
 * A leave type made the way the Super Workspace makes one (visible to both workspaces unless the body says otherwise).
 * Since 2026-11-23 nothing is allocated or accrued: give people days with assignLeave.
 */
export async function leaveType(app: INestApplication, superToken: string, body: Record<string, unknown>): Promise<string> {
  const res = await api(app, superToken).post('/leave/types').send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** Sets, by hand, the days of a leave type an employee has for a year (the only way days are credited). */
export async function assignLeave(app: INestApplication, token: string, employeeId: string, leaveTypeId: string, quantity: string, year = new Date().getUTCFullYear()) {
  const res = await api(app, token).put('/leave/quantities').send({ employeeId, leaveTypeId, year, quantity });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}
