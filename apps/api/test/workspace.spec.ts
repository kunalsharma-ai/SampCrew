import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * Attendance rewards and the employee calendar: HR sets the rules; a finished month is earned or missed from the
 * attendance days (holidays and weekly offs never count, sick leave is excused); the calendar shows day types, leave
 * and deadlines.
 */
describe('employee workspace: attendance rewards and calendar', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let hr: string;
  let emp: string;
  let employeeId: string;
  let sick: string;
  let casual: string;
  const now = new Date(Date.now() + 330 * 60_000);
  const thisMonth = now.toISOString().slice(0, 7);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonth = last.toISOString().slice(0, 7);
  const lastDays = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)).getUTCDate();
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return res.body as Record<string, any>;
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    const h = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    const e = await addMember(pool, t, { name: 'Esha Employee' });
    hr = (await loginWithMfa(app, pool, h.email)).accessToken;
    const body = ok(await api(app, hr).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Esha', lastName: 'Test', dateOfJoining: '2025-01-01', probationMonths: 0, membershipId: e.membershipId, onboardingTemplateId: null }), 201);
    employeeId = body.employee.id;
    emp = (await login(app, e.email)).accessToken;
    sick = (await pool.insert('leave_types', { tenant_id: t.id, code: 'SL', name: 'Sick leave' })).id;
    casual = (await pool.insert('leave_types', { tenant_id: t.id, code: 'CL', name: 'Casual leave' })).id;

    // Last month: present on every working day, one late arrival, one day of sick leave; weekends off.
    for (let d = 1; d <= lastDays; d++) {
      const date = `${lastMonth}-${String(d).padStart(2, '0')}`;
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const off = weekday === 0 || weekday === 6;
      const status = off ? 'weekly_off' : d === 9 || d === 10 ? 'on_leave' : 'present';
      await pool.insert('attendance_days', {
        tenant_id: t.id, employee_id: employeeId, work_date: date, day_type: off ? 'weekly_off' : 'working', status, worked_minutes: status === 'present' ? 480 : 0,
        late_minutes: d === 14 && !off ? 7 : 0, engine_version: 1,
      });
    }
    await pool.insert('leave_requests', { tenant_id: t.id, employee_id: employeeId, leave_type_id: sick, start_date: `${lastMonth}-09`, end_date: `${lastMonth}-10`, days: '2', status: 'approved' });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('only HR sets the rules; the standard rules excuse sick leave', async () => {
    expect((await api(app, emp).post('/workspace/reward-rules/defaults')).status).toBe(403);
    const added = ok(await api(app, hr).post('/workspace/reward-rules/defaults'), 201) as unknown as Record<string, unknown>[];
    expect(added.map((r) => r.kind)).toEqual(['perfect_attendance', 'punctuality']);
    expect(added[0]!.excusedLeaveTypeIds).toEqual([sick]);
    expect(ok(await api(app, hr).post('/workspace/reward-rules/defaults'), 201)).toEqual([]);
    expect((await api(app, hr).post('/workspace/reward-rules').send({ name: 'X', kind: 'perfect_attendance', excusedLeaveTypeIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(400);
    expect(ok(await api(app, emp).get('/workspace/reward-rules'))).toHaveLength(2);
  });

  it('a finished month: perfect attendance earned (sick leave excused, weekends ignored), punctuality missed for one late day', async () => {
    const r = ok(await api(app, emp).get(`/workspace/rewards?month=${lastMonth}`));
    expect(r).toMatchObject({ month: lastMonth, complete: true });
    const perfect = r.rewards.find((x: { kind: string }) => x.kind === 'perfect_attendance');
    const punctual = r.rewards.find((x: { kind: string }) => x.kind === 'punctuality');
    expect(perfect).toMatchObject({ status: 'earned', reason: null });
    expect(perfect.total).toBeGreaterThan(15);
    expect(punctual).toMatchObject({ status: 'missed', reason: 'Late on 1 day' });
  });

  it('HR sees who earned each reward last month, and downloads it; employees cannot', async () => {
    expect((await api(app, emp).get('/workspace/reward-winners')).status).toBe(403);
    const w = ok(await api(app, hr).get(`/workspace/reward-winners?month=${lastMonth}`));
    expect(w.month).toBe(lastMonth);
    const perfect = w.rules.find((x: { kind: string }) => x.kind === 'perfect_attendance');
    const punctual = w.rules.find((x: { kind: string }) => x.kind === 'punctuality');
    expect(perfect.winners).toEqual([expect.objectContaining({ employeeId, name: 'Esha Test' })]);
    expect(punctual.winners).toEqual([]);
    // The current month is not finished, so it falls back to last month.
    expect(ok(await api(app, hr).get(`/workspace/reward-winners?month=${thisMonth}`)).month).toBe(lastMonth);
    const x = await api(app, hr).get(`/workspace/reward-winners/export.xlsx?month=${lastMonth}`);
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect(x.headers['content-disposition']).toContain(`attendance-rewards-${lastMonth}.xlsx`);
  });

  it('HR changes the rules: one late day allowed, and casual leave instead of sick is no longer excused', async () => {
    const rules = ok(await api(app, hr).get('/workspace/reward-rules')) as unknown as Record<string, unknown>[];
    const punctual = rules.find((x) => x.kind === 'punctuality')!;
    ok(await api(app, hr).put(`/workspace/reward-rules/${punctual.id}`).send({ ...punctual, id: undefined, maxLateDays: 1 }));
    const perfect = rules.find((x) => x.kind === 'perfect_attendance')!;
    ok(await api(app, hr).put(`/workspace/reward-rules/${perfect.id}`).send({ ...perfect, id: undefined, excusedLeaveTypeIds: [casual] }));
    const r = ok(await api(app, emp).get(`/workspace/rewards?month=${lastMonth}`));
    expect(r.rewards.find((x: { kind: string }) => x.kind === 'punctuality')).toMatchObject({ status: 'earned' });
    expect(r.rewards.find((x: { kind: string }) => x.kind === 'perfect_attendance')).toMatchObject({ status: 'missed', reason: `Leave on ${lastMonth}-09` });
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'attendance_reward.updated' })).toBe(2);
    // The current month is open: on track or missed, never earned yet; history lists earlier months.
    const cur = ok(await api(app, emp).get('/workspace/rewards'));
    expect(cur).toMatchObject({ month: thisMonth, complete: false });
    for (const x of cur.rewards) expect(['on_track', 'missed']).toContain(x.status);
    expect(cur.history[0]).toMatchObject({ month: lastMonth, earned: [expect.objectContaining({ name: 'Always on time' })] });
  });

  it('the calendar shows weekly offs, my leave and my deadlines', async () => {
    const due = `${thisMonth}-20`;
    const task = ok(await api(app, hr).post('/tasks').send({ category: 'hr', title: 'Submit Form 12BB', dueOn: due, employeeIds: [employeeId] }), 201) as unknown as { id: string }[];
    await pool.insert('leave_requests', { tenant_id: t.id, employee_id: employeeId, leave_type_id: casual, start_date: `${thisMonth}-21`, end_date: `${thisMonth}-21`, days: '1', status: 'pending' });
    const c = ok(await api(app, emp).get(`/workspace/calendar?month=${thisMonth}`));
    expect(c.month).toBe(thisMonth);
    const byDate = new Map(c.days.map((d: { date: string }) => [d.date, d]));
    expect(byDate.get(due)).toMatchObject({ events: [{ kind: 'task', title: 'Due: Submit Form 12BB', href: `/tasks/${task[0]!.id}` }] });
    expect(byDate.get(`${thisMonth}-21`)).toMatchObject({ events: [{ kind: 'leave', title: 'Casual leave (pending)', status: 'pending' }] });
    const sunday = c.days.find((d: { date: string }) => new Date(`${d.date}T00:00:00Z`).getUTCDay() === 0);
    expect(sunday.dayType).toBe('weekly_off');
  });

  it('HR removes a rule', async () => {
    const rules = ok(await api(app, hr).get('/workspace/reward-rules')) as unknown as { id: string }[];
    ok(await api(app, hr).delete(`/workspace/reward-rules/${rules[0]!.id}`));
    expect(ok(await api(app, emp).get('/workspace/reward-rules'))).toHaveLength(1);
  });
});
