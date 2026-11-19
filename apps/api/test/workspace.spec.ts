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

  it('HR turns a reward into extra leave for the winners: credited once, audited, told, and taken back with a reason', async () => {
    // No rule pays anything yet: nothing to grant.
    expect(ok(await api(app, hr).post('/workspace/reward-winners/grant').send({ month: lastMonth }), 201)).toMatchObject({ granted: 0 });
    const rules = ok(await api(app, hr).get('/workspace/reward-rules')) as unknown as Record<string, unknown>[];
    const perfect = rules.find((x) => x.kind === 'perfect_attendance')!;
    expect(perfect.payoutType).toBe('none');
    const bad = await api(app, hr).put(`/workspace/reward-rules/${perfect.id}`).send({ ...perfect, id: undefined, payoutType: 'leave_credit', payoutDays: '1' });
    expect(bad.status).toBe(422);
    ok(await api(app, hr).put(`/workspace/reward-rules/${perfect.id}`).send({ ...perfect, id: undefined, payoutType: 'leave_credit', payoutDays: '1', payoutLeaveTypeId: casual }));
    let w = ok(await api(app, hr).get(`/workspace/reward-winners?month=${lastMonth}`));
    let rule = w.rules.find((x: { kind: string }) => x.kind === 'perfect_attendance');
    expect(rule).toMatchObject({ payout: { type: 'leave_credit', label: '1 day of Casual leave' }, toGrant: 1 });
    expect((await api(app, emp).post('/workspace/reward-winners/grant').send({ month: lastMonth })).status).toBe(403);
    expect((await api(app, hr).post('/workspace/reward-winners/grant').send({ month: thisMonth })).body.error.code).toBe('month_not_finished');

    const g = ok(await api(app, hr).post('/workspace/reward-winners/grant').send({ month: lastMonth }), 201);
    expect(g).toMatchObject({ granted: 1, grants: [{ employeeId, status: 'credited', days: '1.00', leaveTypeName: 'Casual leave', label: '1 day of Casual leave' }] });
    const grantId = g.grants[0].id as string;
    const credit = await pool.one('leave_ledger', { tenant_id: t.id, accrual_key: `RWD:${grantId}` });
    expect(credit).toMatchObject({ employee_id: employeeId, leave_type_id: casual, kind: 'adjustment', quantity: '1.00', note: `Reward: Perfect attendance for ${lastMonth}` });
    // Granting again pays nobody twice.
    expect(ok(await api(app, hr).post('/workspace/reward-winners/grant').send({ month: lastMonth }), 201)).toMatchObject({ granted: 0 });
    w = ok(await api(app, hr).get(`/workspace/reward-winners?month=${lastMonth}`));
    rule = w.rules.find((x: { kind: string }) => x.kind === 'perfect_attendance');
    expect(rule.toGrant).toBe(0);
    expect(rule.winners[0].grant).toMatchObject({ id: grantId, status: 'credited' });
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'attendance_reward.granted' })).toBe(1);
    const note = await pool.one('notifications', { tenant_id: t.id, kind: 'attendance.reward_granted' });
    expect(note).toMatchObject({ title: `You earned Perfect attendance for ${lastMonth}`, body: '1 day of Casual leave were added to your leave balance.' });
    // The employee sees what the reward pays and that it was granted.
    const mine = ok(await api(app, emp).get(`/workspace/rewards?month=${lastMonth}`));
    expect(mine.rewards.find((x: { kind: string }) => x.kind === 'perfect_attendance')).toMatchObject({ payout: '1 day of Casual leave', grant: { status: 'credited' } });

    // Taken back: a reason is needed, the day comes off again, and it cannot be taken back twice.
    expect((await api(app, hr).post(`/workspace/reward-grants/${grantId}/revoke`).send({ reason: 'no' })).status).toBe(422);
    expect((await api(app, emp).post(`/workspace/reward-grants/${grantId}/revoke`).send({ reason: 'Granted by mistake' })).status).toBe(403);
    expect(ok(await api(app, hr).post(`/workspace/reward-grants/${grantId}/revoke`).send({ reason: 'Granted by mistake' }), 201)).toMatchObject({ status: 'revoked', revokeReason: 'Granted by mistake' });
    expect(await pool.one('leave_ledger', { tenant_id: t.id, accrual_key: `RWD-REV:${grantId}` })).toMatchObject({ quantity: '-1.00' });
    expect((await api(app, hr).post(`/workspace/reward-grants/${grantId}/revoke`).send({ reason: 'Granted by mistake' })).status).toBe(409);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'attendance_reward.revoked' })).toBe(1);
  });

  it('a bonus reward waits for the next payroll run; a paid one cannot be taken back', async () => {
    const r = ok(await api(app, hr).post('/workspace/reward-rules').send({ name: 'Star month', kind: 'perfect_attendance', maxLateDays: 2, excusedLeaveTypeIds: [sick], minWorkingDays: 10, payoutType: 'bonus', payoutAmount: '500' }), 201);
    expect(r).toMatchObject({ payoutType: 'bonus', payoutAmount: '500.00', payoutLeaveTypeId: null, payoutDays: null });
    const g = ok(await api(app, hr).post('/workspace/reward-winners/grant').send({ month: lastMonth, ruleId: r.id }), 201);
    expect(g).toMatchObject({ granted: 1, grants: [{ employeeId, status: 'granted', amount: '500.00', currency: 'INR', payrollRunId: null }] });
    const note = (await pool.find('notifications', { tenant_id: t.id, kind: 'attendance.reward_granted' })).find((n) => n.title.startsWith('You earned Star month'))!;
    expect(note.body).toMatch(/^You get a bonus of INR 500\.00, paid with your next salary\.$/);
    await pool.update('attendance_reward_grants', { id: g.grants[0].id }, { $set: { status: 'paid', paid_at: new Date() } });
    expect((await api(app, hr).post(`/workspace/reward-grants/${g.grants[0].id}/revoke`).send({ reason: 'Changed our mind' })).body.error.code).toBe('already_paid');
    ok(await api(app, hr).delete(`/workspace/reward-rules/${r.id}`));
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
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'attendance_reward.updated' })).toBe(3);
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
