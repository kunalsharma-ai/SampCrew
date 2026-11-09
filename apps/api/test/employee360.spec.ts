import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Employee 360: each area of the summary appears only for people whose own access covers it. */
describe('employee 360', () => {
  let app: INestApplication;
  let pool: TestDb;
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
      await pool.insert('attendance_days', {
        tenant_id: t.id, employee_id: ids.olu, work_date: day(n), day_type: 'working', status, worked_minutes: status === 'present' ? 480 : 0, late_minutes: late, engine_version: 1,
      });
    }
    const goal = { tenant_id: t.id, employee_id: ids.olu, period_start: day(-60), period_end: day(120) };
    await pool.insert('goals', { ...goal, title: 'Cut changeover time by 20%', status: 'active', progress: 40, confidence: 'at_risk' });
    await pool.insert('goals', { ...goal, title: 'Train two new operators', status: 'active', progress: 80, confidence: 'on_track' });
    await pool.insert('goals', { ...goal, title: 'Finish forklift licence', status: 'completed', progress: 100, confidence: null });
    await pool.insert('recognitions', { tenant_id: t.id, from_employee_id: ids.boss, to_employee_id: ids.olu, message: 'Stayed late to fix line 2' });
    const st = await pool.insert('salary_structures', { tenant_id: t.id, name: 'Operators 360' });
    await pool.insert('employee_salaries', { tenant_id: t.id, employee_id: ids.olu, effective_from: day(-200), annual_ctc: '540000', currency: 'INR', structure_id: st.id });
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
