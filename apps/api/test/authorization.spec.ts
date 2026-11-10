import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, type TestDb, type TestTenant } from './helpers';

/** RBAC + ABAC through the API, using an org with a reporting line, a department tree and two legal entities. */
describe('authorization (RBAC + ABAC)', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let ukEntity: string;
  const p: Record<string, { email: string; membershipId: string }> = {};
  let mfg: string;
  let assembly: string;
  let hr: string;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    ukEntity = (await pool.insert('legal_entities', { tenant_id: t.id, name: 'UK Ltd', country_code: 'GB', currency: 'GBP', timezone: 'Europe/London' })).id;
    mfg = await department(pool, t, 'Manufacturing');
    assembly = await department(pool, t, 'Assembly', mfg);
    hr = await department(pool, t, 'HR');
    p.head = await addMember(pool, t, { roles: ['department_manager'], departmentId: mfg, name: 'Head' });
    p.supervisor = await addMember(pool, t, { roles: ['department_manager'], departmentId: assembly, managerId: p.head.membershipId, name: 'Supervisor' });
    p.operator = await addMember(pool, t, { departmentId: assembly, managerId: p.supervisor.membershipId, name: 'Operator' });
    p.hrPerson = await addMember(pool, t, { departmentId: hr, name: 'HR Person' });
    p.ukHr = await addMember(pool, t, { roles: ['hr_manager'], legalEntityId: ukEntity, constraints: { legalEntityIds: [ukEntity] }, name: 'UK HR' });
    p.ukStaff = await addMember(pool, t, { legalEntityId: ukEntity, managerId: null, name: 'UK Staff' });
    p.auditor = await addMember(pool, t, { roles: ['auditor'], name: 'Auditor' });
    p.hrAdmin = await addMember(pool, t, { roles: ['hr_admin'], departmentId: hr, name: 'HR Admin' });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const visible = async (who: string) => {
    const s = await login(app, p[who]!.email);
    const res = await api(app, s.accessToken).get('/members?limit=200');
    expect(res.status).toBe(200);
    return new Set<string>(res.body.items.map((m: { id: string }) => m.id));
  };

  it('employees see only themselves', async () => {
    const seen = await visible('operator');
    expect([...seen]).toEqual([p.operator!.membershipId]);
  });

  it('managers see their whole reporting line, not peers or other departments', async () => {
    const head = await visible('head');
    expect(head).toEqual(new Set([p.head!.membershipId, p.supervisor!.membershipId, p.operator!.membershipId]));
    const sup = await visible('supervisor');
    expect(sup).toEqual(new Set([p.supervisor!.membershipId, p.operator!.membershipId]));
  });

  it('entity-constrained HR managers see only their legal entity', async () => {
    const seen = await visible('ukHr');
    expect(seen).toEqual(new Set([p.ukHr!.membershipId, p.ukStaff!.membershipId]));
  });

  it('record-level checks return 404 for out-of-scope records (no existence leak)', async () => {
    const s = await login(app, p.supervisor!.email);
    expect((await api(app, s.accessToken).get(`/members/${p.operator!.membershipId}`)).status).toBe(200);
    expect((await api(app, s.accessToken).get(`/members/${p.hrPerson!.membershipId}`)).status).toBe(404);
  });

  it('HR managers can move people only within their scope', async () => {
    const s = await login(app, p.ukHr!.email);
    expect((await api(app, s.accessToken).patch(`/members/${p.ukStaff!.membershipId}`).send({ managerMembershipId: p.ukHr!.membershipId })).status).toBe(200);
    // Moving someone out of the UK entity would put them out of reach: refused.
    expect((await api(app, s.accessToken).patch(`/members/${p.ukStaff!.membershipId}`).send({ legalEntityId: t.legalEntityId })).status).toBe(404);
    // And an Indian employee is not visible at all.
    expect((await api(app, s.accessToken).patch(`/members/${p.operator!.membershipId}`).send({ departmentId: hr })).status).toBe(404);
  });

  it('auditors can read configuration and the audit trail but cannot change anything', async () => {
    const s = await login(app, p.auditor!.email);
    const http = api(app, s.accessToken);
    expect((await http.get('/audit-events')).status).toBe(200);
    expect((await http.get('/roles')).status).toBe(200);
    expect((await http.post('/org/departments').send({ name: 'Nope' })).status).toBe(403);
    expect((await http.post('/members/invite').send({ email: 'x@y.test', fullName: 'X', roleKeys: ['employee'] })).status).toBe(403);
  });

  it('prevents privilege escalation to owner', async () => {
    const s = await login(app, p.hrAdmin!.email);
    // HR admins can invite but cannot grant roles beyond Employee without roles:manage, and never owner.
    const res = await api(app, s.accessToken).post('/members/invite').send({ email: `esc-${Date.now()}@x.test`, fullName: 'Esc', roleKeys: ['tenant_owner'] });
    expect(res.status).toBe(403);
  });

  it('keeps at least one owner', async () => {
    const s = await login(app, t.ownerEmail);
    const res = await api(app, s.accessToken).patch(`/members/${t.ownerMembershipId}`).send({ status: 'suspended' });
    expect(res.status).toBe(400);
  });

  it('suspending a member ends their sessions', async () => {
    const victim = await addMember(pool, t, { departmentId: hr });
    const vs = await login(app, victim.email);
    const owner = await login(app, t.ownerEmail);
    expect((await api(app, owner.accessToken).patch(`/members/${victim.membershipId}`).send({ status: 'suspended' })).status).toBe(200);
    expect((await api(app, vs.accessToken).get('/me')).status).toBe(401);
    expect((await api(app).post('/auth/login').send({ email: victim.email, password: 'Correct-Horse-42!' })).status).toBe(403);
  });

  it('/me exposes effective permissions for building navigation', async () => {
    const s = await login(app, p.supervisor!.email);
    const me = await api(app, s.accessToken).get('/me');
    expect(me.body.permissions['leave:approve']).toBe('team');
    expect(me.body.permissions['payroll:approve']).toBeUndefined();
  });
});
