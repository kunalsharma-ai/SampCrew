import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, loginWithMfa, type TestTenant } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Workforce Universe: placement history for replaying the organization over time, scoped like the directory. */
describe('workforce universe', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  let assembly = '';
  let quality = '';
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    assembly = await department(pool, t, 'Assembly');
    quality = await department(pool, t, 'Quality');
    const hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    const sup = await addMember(pool, t, { roles: ['department_manager'], departmentId: assembly, name: 'Sam Supervisor' });
    const op = await addMember(pool, t, { departmentId: assembly, managerId: sup.membershipId, name: 'Olu Operator' });
    const stranger = await addMember(pool, other, { roles: ['hr_admin'], name: 'Other HR' });
    tokens.hr = (await loginWithMfa(app, pool, hr.email)).accessToken;
    tokens.sup = (await loginWithMfa(app, pool, sup.email)).accessToken;
    tokens.op = (await loginWithMfa(app, pool, op.email)).accessToken;
    tokens.stranger = (await loginWithMfa(app, pool, stranger.email, other.slug)).accessToken;

    const hire = async (body: Record<string, unknown>) => {
      const res = await api(app, tokens.hr).post('/employees').send({ legalEntityId: t.legalEntityId, probationMonths: 0, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.employee.id as string;
    };
    ids.sup = await hire({ firstName: 'Sam', lastName: 'Supervisor', departmentId: assembly, dateOfJoining: '2021-03-01', membershipId: sup.membershipId });
    ids.op = await hire({ firstName: 'Olu', lastName: 'Operator', departmentId: assembly, managerEmployeeId: ids.sup, dateOfJoining: '2022-06-01', membershipId: op.membershipId });
    ids.qa = await hire({ firstName: 'Quinn', lastName: 'Inspector', departmentId: quality, dateOfJoining: '2023-01-09' });
    ids.leaver = await hire({ firstName: 'Lee', lastName: 'Leaver', departmentId: assembly, managerEmployeeId: ids.sup, dateOfJoining: '2022-02-01' });
    // Quinn moves from Quality to Assembly, under Sam, a month ago; Lee left yesterday.
    const move = await api(app, tokens.hr).post(`/employees/${ids.qa}/job-changes`).send({ effectiveFrom: plus(today(), -30), reason: 'transfer', departmentId: assembly, managerEmployeeId: ids.sup });
    expect(move.status, JSON.stringify(move.body)).toBeLessThan(300);
    const exit = await api(app, tokens.hr).post(`/employees/${ids.leaver}/exit`).send({ exitType: 'resignation', resignationDate: plus(today(), -30), lastWorkingDay: plus(today(), -1) });
    expect(exit.body.status, JSON.stringify(exit.body)).toBe('exited');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('returns everyone HR can see with their placement history, so any date can be rebuilt', async () => {
    const res = await api(app, tokens.hr).get('/insights/universe');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const u = res.body;
    expect(u.asOf).toBe(today());
    expect(u.start).toBe('2021-03-01');
    expect(u.departments.map((d: { name: string }) => d.name).sort()).toEqual(['Assembly', 'Quality']);
    expect(u.people).toHaveLength(4);
    const leaver = u.people.find((p: { id: string }) => p.id === ids.leaver);
    expect(leaver).toMatchObject({ status: 'exited', leftOn: plus(today(), -1), joined: '2022-02-01' });
    const quinn = u.records.filter((r: { employeeId: string }) => r.employeeId === ids.qa);
    expect(quinn.map((r: { reason: string; departmentId: string }) => [r.reason, r.departmentId])).toEqual([['hire', quality], ['transfer', assembly]]);
    expect(quinn[0].to).toBe(plus(today(), -31));
    expect(quinn[1]).toMatchObject({ from: plus(today(), -30), to: null, managerId: ids.sup });
    // On a date before the transfer Quinn sat in Quality; today in Assembly. The record ranges make that unambiguous.
    const at = (d: string) => quinn.find((r: { from: string; to: string | null }) => r.from <= d && (!r.to || r.to >= d));
    expect(at('2023-06-01').departmentId).toBe(quality);
    expect(at(today()).departmentId).toBe(assembly);
  });

  it('shows a manager only their team, an employee only themselves, and nothing across workspaces', async () => {
    const sup = await api(app, tokens.sup).get('/insights/universe');
    expect(sup.status).toBe(200);
    // A department manager sees their department: Sam, Olu, Quinn (moved in) and Lee.
    expect(sup.body.people.map((p: { name: string }) => p.name).sort()).toEqual(['Lee Leaver', 'Olu Operator', 'Quinn Inspector', 'Sam Supervisor']);
    const op = await api(app, tokens.op).get('/insights/universe');
    expect(op.status).toBe(200);
    expect(op.body.people.map((p: { id: string }) => p.id)).toEqual([ids.op]);
    expect(op.body.records.every((r: { employeeId: string }) => r.employeeId === ids.op)).toBe(true);
    const stranger = await api(app, tokens.stranger).get('/insights/universe');
    expect(stranger.status).toBe(200);
    expect(stranger.body.people).toEqual([]);
    expect(stranger.body.departments).toEqual([]);
  });
});
