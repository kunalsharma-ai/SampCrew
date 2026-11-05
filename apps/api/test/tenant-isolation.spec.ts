import type { INestApplication } from '@nestjs/common';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, type TestTenant } from './helpers';

/**
 * Tenant isolation is the most important property of CREW. These tests check it at two layers:
 * directly against PostgreSQL Row-Level Security, and through the HTTP API.
 */
describe('tenant isolation', () => {
  let app: INestApplication;
  let pool: Pool;
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
    for (const t of [a, b]) {
      await pool.query(`select set_config('app.tenant_id', $1, false)`, [t.id]);
      await pool.query(`insert into audit_events (tenant_id, actor_type, action, resource_type) values ($1, 'system', 'test.seeded', 'tenant')`, [t.id]);
    }
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('database layer (RLS)', () => {
    const asApp = async <T>(tenantId: string, fn: (c: Client) => Promise<T>) => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        await c.query('begin');
        await c.query('set local role crew_app');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
        return await fn(c);
      } finally {
        await c.query('rollback');
        await c.end();
      }
    };

    const tables = ['legal_entities', 'departments', 'memberships', 'roles', 'role_permissions', 'role_assignments', 'subscriptions', 'audit_events'];

    it.each(tables)('%s: tenant B sees none of tenant A rows', async (table) => {
      const rows = await asApp(b.id, (c) => c.query(`select tenant_id from ${table}`));
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.tenant_id === b.id)).toBe(true);
    });

    it('cannot read another tenant by primary key even when the id is known', async () => {
      const r = await asApp(b.id, (c) => c.query('select * from departments where id = $1', [deptA]));
      expect(r.rowCount).toBe(0);
    });

    it('cannot write rows into another tenant', async () => {
      await expect(asApp(b.id, (c) => c.query(`insert into departments (tenant_id, name) values ($1, 'Injected')`, [a.id]))).rejects.toThrow(/row-level security/);
    });

    it('cannot update or delete another tenant\'s rows', async () => {
      const r = await asApp(b.id, async (c) => {
        const u = await c.query(`update departments set name = 'pwned' where id = $1`, [deptA]);
        const d = await c.query(`delete from role_assignments where tenant_id = $1`, [a.id]);
        return [u.rowCount, d.rowCount];
      });
      expect(r).toEqual([0, 0]);
    });

    it('sees nothing at all without a tenant context', async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      await c.query('begin');
      await c.query('set local role crew_app');
      const r = await c.query('select count(*)::int as n from departments');
      await c.query('rollback');
      await c.end();
      expect(r.rows[0].n).toBe(0);
    });

    it('the API login role has no table access unless it assumes a scoped role', async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      await expect(c.query('select * from departments')).rejects.toThrow(/permission denied/);
      await c.end();
    });

    it('the tenant role cannot read password hashes or MFA secrets', async () => {
      await expect(asApp(a.id, (c) => c.query('select password_hash from users'))).rejects.toThrow(/permission denied/);
      await expect(asApp(a.id, (c) => c.query('select mfa_secret_enc from users'))).rejects.toThrow(/permission denied/);
    });

    it('composite foreign keys stop cross-tenant references', async () => {
      const deptB = await department(pool, b, 'B dept');
      await expect(pool.query('update memberships set department_id = $1 where id = $2', [deptB, memberA.membershipId])).rejects.toThrow(/foreign key/);
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

    it('lists only contain the caller\'s tenant', async () => {
      const { accessToken } = await login(app, b.ownerEmail);
      const res = await api(app, accessToken).get('/members?limit=200');
      expect(res.status).toBe(200);
      expect(res.body.items.some((m: { id: string }) => m.id === memberA.membershipId)).toBe(false);
      const depts = await api(app, accessToken).get('/org/departments');
      expect(depts.body.some((d: { id: string }) => d.id === deptA)).toBe(false);
    });

    it('cannot reference another tenant\'s records when writing', async () => {
      const { accessToken } = await login(app, b.ownerEmail);
      const res = await api(app, accessToken).post('/org/departments').send({ name: 'Child', parentId: deptA });
      expect(res.status).toBe(400);
      const loc = await api(app, accessToken).post('/org/locations').send({ name: 'Sneaky', legalEntityId: a.legalEntityId, timezone: 'Asia/Kolkata', countryCode: 'IN' });
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
