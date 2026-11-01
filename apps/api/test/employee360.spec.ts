import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, loginWithMfa, type TestTenant } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Employee 360: each area of the summary appears only for people whose own access covers it. */
describe('employee 360', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const get = (who: string, id = ids.olu!) => api(app, tokens[who]).get(`/employees/${id}/360`);

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    const ops = await department(pool, t, 'Operations');
    const sales = await department(pool, t, 'Sales');
    const people = {
      hr: await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' }),
      payroll: await addMember(pool, t, { roles: ['payroll_admin'], name: 'Pat Payroll' }),
      boss: await addMember(pool, t, { roles: ['department_manager'], departmentId: ops, name: 'Sam Supervisor' }),
      olu: await addMember(pool, t, { departmentId: ops, name: 'Olu Operator' }),
      peer: await addMember(pool, t, { departmentId: sales, name: 'Pia Peer' }),
      stranger: await addMember(pool, other, { roles: ['hr_admin'], name: 'Other HR' }),
    };
    for (const [k, p] of Object.entries(people)) tokens[k] = (await loginWithMfa(app, pool, p.email, k === 'stranger' ? other.slug : t.slug)).accessToken;
    const hire = async (body: Record<string, unknown>) => {
      const res = await api(app, tokens.hr).post('/employees').send({ legalEntityId: t.legalEntityId, probationMonths: 0, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.employee.id as string;
    };
    ids.boss = await hire({ firstName: 'Sam', lastName: 'Supervisor', departmentId: ops, dateOfJoining: '2021-03-01', membershipId: people.boss.membershipId });
    ids.olu = await hire({ firstName: 'Olu', lastName: 'Operator', departmentId: ops, managerEmployeeId: ids.boss, dateOfJoining: '2022-06-01', membershipId: people.olu.membershipId });
    ids.peer = await hire({ firstName: 'Pia', lastName: 'Peer', departmentId: sales, dateOfJoining: '2023-01-09', membershipId: people.peer.membershipId });

    // Olu's month: 3 days present (one late), 1 absent, 1 missing punch.
    const statuses: [number, string, number][] = [[-5, 'present', 0], [-4, 'present', 12], [-3, 'absent', 0], [-2, 'missing_punch', 0], [-1, 'present', 0]];
    for (const [n, status, late] of statuses) {
      await pool.query(
        `insert into attendance_days (tenant_id, employee_id, work_date, day_type, status, worked_minutes, late_minutes, engine_version) values ($1, $2, $3, 'working', $4, $5, $6, 1)`,
        [t.id, ids.olu, day(n), status, status === 'present' ? 480 : 0, late],
      );
    }
    await pool.query(
      `insert into goals (tenant_id, employee_id, title, period_start, period_end, status, progress, confidence) values
         ($1, $2, 'Cut changeover time by 20%', $3, $4, 'active', 40, 'at_risk'), ($1, $2, 'Train two new operators', $3, $4, 'active', 80, 'on_track'),
         ($1, $2, 'Finish forklift licence', $3, $4, 'completed', 100, null)`,
      [t.id, ids.olu, day(-60), day(120)],
    );
    await pool.query(`insert into recognitions (tenant_id, from_employee_id, to_employee_id, message) values ($1, $2, $3, 'Stayed late to fix line 2')`, [t.id, ids.boss, ids.olu]);
    const st = await pool.query<{ id: string }>(`insert into salary_structures (tenant_id, name) values ($1, 'Operators 360') returning id`, [t.id]);
    await pool.query(
      `insert into employee_salaries (tenant_id, employee_id, effective_from, annual_ctc, currency, structure_id) values ($1, $2, $3, 540000, 'INR', $4)`,
      [t.id, ids.olu, day(-200), st.rows[0]!.id],
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('gives HR the full picture except pay', async () => {
    const res = await get('hr');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = res.body;
    expect(s).toMatchObject({ employeeId: ids.olu, isSelf: false, joinedOn: '2022-06-01' });
    expect(s.attendance).toMatchObject({ present: 3, absent: 1, missingPunch: 1, late: 1, workingDays: 5, avgWorkedMinutes: 480 });
    expect(s.performance).toMatchObject({ activeGoals: 2, completedGoals: 1, atRisk: 1, averageProgress: '60', latestReview: null });
    expect(s.performance.goals.map((g: { title: string }) => g.title).sort()).toEqual(['Cut changeover time by 20%', 'Train two new operators']);
    expect(s.recognition).toMatchObject({ last90Days: 1, recent: [expect.objectContaining({ from: 'Sam Supervisor', message: 'Stayed late to fix line 2' })] });
    expect(s.leave).toMatchObject({ pending: 0, takenThisYear: '0' });
    expect(s.requests).toMatchObject({ open: 0 });
    expect(s.documents).toMatchObject({ count: 0 });
    // HR admins do not have payroll access, so salary is not shown to them.
    expect(s.pay).toBeNull();
    const kinds = s.timeline.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['job', 'goal', 'recognition']));
    const times = s.timeline.map((e: { at: string }) => new Date(e.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('shows salary to payroll, and to the employee only their own payslips', async () => {
    expect((await get('payroll')).body.pay).toMatchObject({ salary: { annualCtc: '540000.00', currency: 'INR', effectiveFrom: day(-200) }, lastPayslip: null });
    const self = (await get('olu')).body;
    expect(self.isSelf).toBe(true);
    expect(self.pay).toEqual({ salary: null, lastPayslip: null });
    expect(self.attendance.present).toBe(3);
    expect(self.requests).toMatchObject({ open: 0 });
  });

  it('gives a manager their team, and hides areas a colleague has no access to', async () => {
    const boss = (await get('boss')).body;
    expect(boss.attendance.present).toBe(3);
    expect(boss.performance.activeGoals).toBe(2);
    expect(boss.pay).toBeNull();
    // A colleague in another department cannot open Olu at all; another workspace cannot either.
    expect((await get('peer')).status).toBe(404);
    expect((await get('stranger')).status).toBe(404);
    // Pia sees her own summary, without anyone else's goals.
    const own = (await get('peer', ids.peer)).body;
    expect(own).toMatchObject({ isSelf: true, performance: { activeGoals: 0 }, attendance: { present: 0 } });
  });
});
