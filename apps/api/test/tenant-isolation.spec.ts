import type { INestApplication } from '@nestjs/common';
import { ScopeViolationError } from '../src/platform/database/mongo-scope';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, type TestDb, type TestTenant } from './helpers';

/**
 * Tenant isolation is the most important property of SampCrew. These tests check it at two layers:
 * directly against the MongoDB workspace scope (the data rules every query goes through), and through the HTTP API.
 */
describe('tenant isolation', () => {
  let app: INestApplication;
  let pool: TestDb;
  let a: TestTenant;
  let b: TestTenant;
  let deptA: string;
  let memberA: { membershipId: string };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    a = await createTenant(pool);
    b = await createTenant(pool);
    deptA = await department(pool, a, 'Secret Projects');
    memberA = await addMember(pool, a, { departmentId: deptA });
    await department(pool, b, 'B operations');
    for (const t of [a, b])
      await pool.tenant(t.id, async (tx) =>
        tx.audit({
          actor_type: 'system',
          actor_id: null,
          actor_label: null,
          action: 'test.seeded',
          resource_type: 'tenant',
          resource_id: null,
          changes: {},
          metadata: {},
          ip: null,
          user_agent: null,
          request_id: null,
        }),
      );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('database layer (workspace scope)', () => {
    const tables = ['legal_entities', 'departments', 'memberships', 'roles', 'role_permissions', 'role_assignments', 'subscriptions', 'audit_events'];

    it.each(tables)('%s: tenant B sees none of tenant A rows', async (table) => {
      const rows = await pool.tenant(b.id, (tx) => tx.collection(table).find({}));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === b.id)).toBe(true);
    });

    it('cannot read another tenant by primary key even when the id is known', async () => {
      expect(await pool.tenant(b.id, (tx) => tx.collection('departments').findOne({ id: deptA }))).toBeUndefined();
    });

    it('cannot read or write rows that name another tenant', async () => {
      await expect(pool.tenant(b.id, (tx) => tx.collection('departments').find({ tenant_id: a.id }))).rejects.toThrow(ScopeViolationError);
      await expect(pool.tenant(b.id, (tx) => tx.collection('departments').insert({ tenant_id: a.id, name: 'Injected' }))).rejects.toThrow(ScopeViolationError);
      await expect(pool.tenant(b.id, (tx) => tx.collection('departments').update({}, { $set: { tenant_id: a.id } }))).rejects.toThrow(ScopeViolationError);
      expect(await pool.count('departments', { name: 'Injected' })).toBe(0);
    });

    it("cannot update or delete another tenant's rows", async () => {
      const r = await pool.tenant(b.id, async (tx) => [
        await tx.collection('departments').update({ id: deptA }, { $set: { name: 'pwned' } }),
        await tx.collection('role_assignments').delete({ membership_id: memberA.membershipId }),
      ]);
      expect(r).toEqual([0, 0]);
      expect((await pool.one('departments', { id: deptA }))!.name).toBe('Secret Projects');
    });

    it('needs a tenant in context for a workspace transaction', async () => {
      expect(() => pool.svc.tenant(async () => 1)).toThrow(/without a tenant/);
    });

    it('keeps platform-only tables out of a workspace', async () => {
      for (const table of ['sessions', 'users', 'platform_admins', 'platform_sessions']) {
        await expect(pool.tenant(a.id, async (tx) => tx.collection(table))).rejects.toThrow(/not reachable|Unknown collection/);
      }
    });

    it('shows a workspace only its own tenant record', async () => {
      const rows = await pool.tenant(b.id, (tx) => tx.collection('tenants').find({}));
      expect(rows.map((r) => r.id)).toEqual([b.id]);
    });

    it('lets a workspace see its members but not their password hashes or MFA secrets', async () => {
      const users = await pool.tenant(a.id, async (tx) => (await tx.users()).find({}));
      expect(users.length).toBeGreaterThan(0);
      for (const u of users) {
        expect(u).not.toHaveProperty('password_hash');
        expect(u).not.toHaveProperty('mfa_secret_enc');
      }
      await expect(pool.tenant(a.id, async (tx) => (await tx.users()).find({ password_hash: { $exists: true } }))).rejects.toThrow(/hidden columns/);
      await expect(pool.tenant(a.id, async (tx) => (await tx.users()).update({}, { $set: { full_name: 'x' } }))).rejects.toThrow(/not allowed/);
      const other = await pool.tenant(b.id, async (tx) => (await tx.users()).find({}));
      expect(other.some((u) => u.email === a.ownerEmail)).toBe(false);
    });

    it('foreign keys stop cross-tenant references', async () => {
      const deptB = await department(pool, b, 'B dept');
      await expect(pool.update('memberships', { id: memberA.membershipId }, { $set: { department_id: deptB } })).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('API layer', () => {
    it('a tenant B admin cannot fetch tenant A records by id', async () => {
      const { accessToken } = await login(app, b.ownerEmail);
      const http = api(app, accessToken);
      expect((await http.get(`/org/departments/${deptA}`)).status).toBe(404);
      expect((await http.get(`/members/${memberA.membershipId}`)).status).toBe(404);
      expect((await http.patch(`/org/departments/${deptA}`).send({ name: 'pwned' })).status).toBe(404);
    });

    it("lists only contain the caller's tenant", async () => {
      const { accessToken } = await login(app, b.ownerEmail);
      const res = await api(app, accessToken).get('/members?limit=200');
      expect(res.status).toBe(200);
      expect(res.body.items.some((m: { id: string }) => m.id === memberA.membershipId)).toBe(false);
      const depts = await api(app, accessToken).get('/org/departments');
      expect(depts.body.some((d: { id: string }) => d.id === deptA)).toBe(false);
    });

    it("cannot reference another tenant's records when writing", async () => {
      const { accessToken } = await login(app, b.ownerEmail);
      const res = await api(app, accessToken).post('/org/departments').send({ name: 'Child', parentId: deptA });
      expect(res.status).toBe(400);
      const loc = await api(app, accessToken).post('/org/locations').send({
        name: 'Sneaky',
        legalEntityId: a.legalEntityId,
        timezone: 'Asia/Kolkata',
        countryCode: 'IN',
      });
      expect(loc.status).toBe(422);
      expect(loc.body.error.code).toBe('invalid_reference');
    });

    it('a token for tenant A cannot be replayed against a tenant it does not belong to', async () => {
      const { accessToken } = await login(app, a.ownerEmail);
      const res = await api(app, accessToken).post('/auth/switch-tenant').send({ tenantId: b.id });
      expect(res.status).toBe(403);
    });
  });
});
