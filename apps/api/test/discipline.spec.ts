import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekend = (d: string) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
/** Today, or the last weekday before it at a weekend (leave on a weekly off has no working days). */
const lastWeekday = () => {
  let d = istToday();
  while (weekend(d)) d = plus(d, -1);
  return d;
};
const weekdayIn = (n: number) => {
  let d = plus(istToday(), n);
  while (weekend(d)) d = plus(d, 1);
  return d;
};
/** A month fully in the past, for manual reminders and payroll. */
const MONTH = '2026-09';
const SEPT_WEEKDAYS = Array.from({ length: 30 }, (_, i) => `${MONTH}-${String(i + 1).padStart(2, '0')}`).filter((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));

/**
 * Late-coming reminders (automatic and by hand, in-app and email), the deduction tiers they reach, same-day leave
 * penalties (automatic and by the manager), and payroll deducting both.
 */
describe('late coming and attendance penalties', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let engineering: string;
  let pune: string;
  let gen: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return res.body as Record<string, any>;
  };
  const punch = (who: string, date: string, time: string, direction: 'in' | 'out') =>
    pool.insert('attendance_events', { tenant_id: t.id, employee_id: people[who]!.employeeId, source: 'import', source_event_id: randomUUID(), captured_at: new Date(`${date}T${time}:00+05:30`), direction });
  const notes = (who: string, kind: string) => pool.count('notifications', { tenant_id: t.id, membership_id: people[who]!.membershipId, kind });
  const lateMonth = async (who: string, month: string, employee?: string) => ok(await as(who).get(`/attendance/late/month?month=${month}${employee ? `&employeeId=${people[employee]!.employeeId}` : ''}`));
  const POLICY = { enabled: true, autoReminders: true, minLateMinutes: 15, email: true, notifyManager: true, tiers: [{ reminders: 5, basis: 'days', value: '1' }, { reminders: 3, basis: 'percent', value: '5' }] };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    engineering = await department(pool, t, 'Engineering');
    pune = (await pool.insert('locations', { tenant_id: t.id, legal_entity_id: t.legalEntityId, name: 'Pune office', timezone: 'Asia/Kolkata', city: 'Pune', region: 'Maharashtra', country_code: 'IN' })).id;
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.payroll = await addMember(pool, t, { roles: ['payroll_admin'], name: 'Pat Payroll' });
    people.manager = await addMember(pool, t, { roles: ['department_manager'], departmentId: engineering, name: 'Manu Manager' });
    people.asha = await addMember(pool, t, { departmentId: engineering, name: 'Asha Rao' });
    people.bala = await addMember(pool, t, { departmentId: engineering, name: 'Bala Iyer' });
    people.other = await addMember(pool, t, { name: 'Oz Other' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    tokens.payroll = (await loginWithMfa(app, pool, people.payroll.email)).accessToken;
    const hire = async (who: string, first: string, last: string, managerEmployeeId?: string, departmentId: string | null = engineering) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: last, dateOfJoining: '2025-01-01', probationMonths: 0, membershipId: people[who]!.membershipId,
        departmentId, locationId: pune, managerEmployeeId, onboardingTemplateId: null,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('hr', 'Hana', 'HR', undefined, null);
    await hire('manager', 'Manu', 'Manager');
    await hire('asha', 'Asha', 'Rao', people.manager.employeeId);
    await hire('bala', 'Bala', 'Iyer', people.manager.employeeId);
    await hire('other', 'Oz', 'Other', undefined, null);
    for (const who of ['manager', 'asha', 'bala', 'other']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
    gen = (ok(await as('hr').get('/shifts/templates')) as unknown as { id: string; code: string }[]).find((s) => s.code === 'GEN')!.id;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('rules', () => {
    it('are off until saved, readable by everyone, and changed only by attendance and leave configurers', async () => {
      const p = await lateMonth('asha', MONTH);
      expect(p.policy.late.enabled).toBe(false);
      expect(ok(await as('asha').get('/attendance/late/policy')).late.enabled).toBe(false);
      expect((await as('manager').put('/attendance/late/policy').send(POLICY)).status).toBe(403);
      expect((await as('manager').put('/leave/same-day-policy').send({ enabled: true })).status).toBe(403);
      // Two tiers at the same count, a percentage above 100 and quarter days are refused.
      expect((await as('hr').put('/attendance/late/policy').send({ ...POLICY, tiers: [{ reminders: 3, basis: 'percent', value: '5' }, { reminders: 3, basis: 'days', value: '1' }] })).status).toBe(422);
      expect((await as('hr').put('/attendance/late/policy').send({ ...POLICY, tiers: [{ reminders: 3, basis: 'percent', value: '120' }] })).status).toBe(422);
      expect((await as('hr').put('/attendance/late/policy').send({ ...POLICY, tiers: [{ reminders: 3, basis: 'days', value: '1.25' }] })).status).toBe(422);
      const saved = ok(await as('hr').put('/attendance/late/policy').send(POLICY));
      // Tiers come back in order; automatic reminders start today, never for older days.
      expect(saved.late.tiers.map((x: { reminders: number }) => x.reminders)).toEqual([3, 5]);
      expect(saved.lateSince).toBe(istToday());
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'discipline.late_policy_updated' })).toBe(1);
    });
  });

  describe('automatic reminders', () => {
    const d1 = plus(istToday(), -1);
    const d2 = plus(istToday(), -2);
    const old = plus(istToday(), -3);

    beforeAll(async () => {
      // Work days whatever the weekday, so the test does not depend on the calendar.
      ok(await as('hr').put('/shifts/assignments').send({ assignments: [d1, d2, old].map((workDate) => ({ employeeId: people.asha.employeeId, workDate, shiftTemplateId: gen })) }));
      // Pretend the rules were switched on three days ago for the next test, after checking the switch-on date is kept.
      await pool.update('discipline_policies', { tenant_id: t.id }, { $set: { late_since: d2 } });
    });

    it('remind an employee who arrived late, in-app and by email, once per day, and tell their manager', async () => {
      await punch('asha', d2, '09:40', 'in');
      await punch('asha', d2, '18:30', 'out');
      await punch('asha', d1, '09:20', 'in'); // 20 minutes late: over the 15-minute threshold
      await punch('asha', d1, '18:30', 'out');
      await punch('asha', old, '10:00', 'in'); // before the rules applied: no reminder
      await punch('asha', old, '18:30', 'out');
      ok(await as('hr').post('/attendance/recompute').send({ employeeId: people.asha.employeeId, from: old, to: d1 }));
      ok(await as('asha').get(`/attendance/days?from=${old}&to=${d1}`));
      const m = await lateMonth('asha', d2.slice(0, 7), 'asha');
      const mine = m.reminders.filter((r: { status: string }) => r.status === 'sent');
      const expected = [d2, d1].filter((d) => d.slice(0, 7) === d2.slice(0, 7));
      expect(mine.map((r: { workDate: string }) => r.workDate).sort()).toEqual(expected.sort());
      expect(mine.every((r: { source: string; emailed: boolean }) => r.source === 'auto' && r.emailed)).toBe(true);
      expect(await notes('asha', 'attendance.late_reminder')).toBe(2);
      expect(await notes('manager', 'attendance.late_reminder_team')).toBe(2);
      const mail = await pool.find('email_messages', { tenant_id: t.id, to_email: people.asha.email, template: 'attendance.late_reminder' });
      expect(mail).toHaveLength(2);
      expect(mail.map((x) => x.text_body as string).join(' ')).toMatch(/40 minutes after your shift start of 09:00/);
      expect(mail[0]!.text_body).toMatch(/At 3 reminders, 5% of the month's gross pay is deducted/);
      // Computing the days again sends nothing new.
      ok(await as('hr').post('/attendance/recompute').send({ employeeId: people.asha.employeeId, from: old, to: d1 }));
      expect(await notes('asha', 'attendance.late_reminder')).toBe(2);
      expect(await pool.count('late_reminders', { tenant_id: t.id, work_date: old })).toBe(0);
      // The employee sees their own reminders; a colleague outside the team cannot look.
      expect((await as('other').get(`/attendance/late/month?month=${d2.slice(0, 7)}&employeeId=${people.asha.employeeId}`)).status).toBe(404);
    });

    it('are withdrawn when the day is corrected and no longer late', async () => {
      // The roster was wrong: Asha was on the 10:00 shift that day.
      const late = ok(await as('hr').post('/shifts/templates').send({ code: 'MID', name: 'Mid shift', startTime: '10:00', endTime: '19:00', breakMinutes: 60 }), 201);
      ok(await as('hr').put('/shifts/assignments').send({ assignments: [{ employeeId: people.asha.employeeId, workDate: d2, shiftTemplateId: late.id }] }));
      ok(await as('hr').post('/attendance/recompute').send({ employeeId: people.asha.employeeId, from: d2, to: d2 }));
      const r = (await pool.find('late_reminders', { tenant_id: t.id, employee_id: people.asha.employeeId, work_date: d2 }))[0]!;
      expect(r).toMatchObject({ status: 'withdrawn', source: 'auto' });
      expect(await notes('asha', 'attendance.late_reminder_withdrawn')).toBe(1);
    });
  });

  describe('manual reminders and late-coming deductions', () => {
    beforeAll(async () => {
      // Asha in September: late by 30 minutes on the first six weekdays, on time afterwards.
      for (const [i, d] of SEPT_WEEKDAYS.entries()) {
        await punch('asha', d, i < 6 ? '09:30' : '09:00', 'in');
        await punch('asha', d, '18:30', 'out');
      }
      ok(await as('hr').post('/attendance/recompute').send({ employeeId: people.asha.employeeId, from: `${MONTH}-01`, to: `${MONTH}-30` }));
    });

    it('lists the late days of the month with who can be reminded, and sends nothing automatically for old days', async () => {
      const m = await lateMonth('manager', MONTH);
      const asha = m.lateDays.filter((d: { employeeId: string }) => d.employeeId === people.asha.employeeId);
      expect(asha).toHaveLength(6);
      expect(asha.every((d: { lateMinutes: number; reminder: unknown; canRemind: boolean }) => d.lateMinutes === 30 && d.reminder === null && d.canRemind)).toBe(true);
      // Asha cannot remind herself.
      expect((await lateMonth('asha', MONTH, 'asha')).lateDays.every((d: { canRemind: boolean }) => !d.canRemind)).toBe(true);
    });

    it('lets the manager remind their team (not themselves, not other teams), once per day, with a note when the day was not late', async () => {
      const send = (who: string, employee: string, workDate: string, note?: string) => as(who).post('/attendance/late/reminders').send({ employeeId: people[employee]!.employeeId, workDate, note });
      expect((await send('asha', 'bala', SEPT_WEEKDAYS[0]!)).status).toBe(403);
      expect((await send('manager', 'other', SEPT_WEEKDAYS[0]!)).status).toBe(404);
      expect((await send('manager', 'manager', SEPT_WEEKDAYS[0]!)).status).toBe(403);
      const first = ok(await send('manager', 'asha', SEPT_WEEKDAYS[0]!), 201);
      expect(first).toMatchObject({ source: 'manual', sequence: 1, lateMinutes: 30, sentBy: 'Manu Manager' });
      expect((await send('manager', 'asha', SEPT_WEEKDAYS[0]!)).body.error.code).toBe('already_reminded');
      expect((await send('manager', 'asha', SEPT_WEEKDAYS[8]!)).body.error.code).toBe('not_late');
      ok(await send('manager', 'asha', SEPT_WEEKDAYS[1]!), 201);
      expect(await pool.count('attendance_penalties', { tenant_id: t.id, employee_id: people.asha.employeeId, month: MONTH })).toBe(0);
      const mail = await pool.find('email_messages', { tenant_id: t.id, to_email: people.asha.email, template: 'attendance.late_reminder' });
      expect(mail.at(-1)!.text_body).toMatch(/This is late reminder 2 this month/);
    });

    it('applies the 3-reminder tier, then the 5-reminder tier, and steps back when a reminder is withdrawn', async () => {
      const send = (i: number, note?: string) => as('manager').post('/attendance/late/reminders').send({ employeeId: people.asha.employeeId, workDate: SEPT_WEEKDAYS[i], note });
      const third = ok(await send(2), 201);
      expect(third.sequence).toBe(3);
      let p = (await lateMonth('hr', MONTH)).penalties.filter((x: { kind: string }) => x.kind === 'late_coming');
      expect(p).toHaveLength(1);
      expect(p[0]).toMatchObject({ status: 'active', basis: 'percent', value: '5', reminderCount: 3, deduction: "5% of the month's gross pay", canWaive: true });
      expect(await notes('asha', 'attendance.penalty_applied')).toBe(1);
      ok(await send(3), 201);
      ok(await send(4, 'Late again after a warning'), 201);
      p = (await lateMonth('hr', MONTH)).penalties.filter((x: { kind: string }) => x.kind === 'late_coming');
      expect(p[0]).toMatchObject({ status: 'active', basis: 'days', value: '1', tierReminders: 5 });
      expect(await notes('asha', 'attendance.penalty_applied')).toBe(2);
      // Withdrawing one reminder takes the month back to the 3-reminder tier.
      const m = await lateMonth('manager', MONTH);
      const fifth = m.reminders.find((r: { sequence: number; status: string }) => r.sequence === 5 && r.status === 'sent');
      expect((await as('manager').post(`/attendance/late/reminders/${fifth.id}/withdraw`).send({})).status).toBe(422);
      ok(await as('manager').post(`/attendance/late/reminders/${fifth.id}/withdraw`).send({ reason: 'Client visit on the way' }), 201);
      p = (await lateMonth('hr', MONTH)).penalties.filter((x: { kind: string }) => x.kind === 'late_coming');
      expect(p[0]).toMatchObject({ status: 'active', basis: 'percent', value: '5', reminderCount: 4 });
      expect((await lateMonth('manager', MONTH)).people.find((x: { employeeId: string }) => x.employeeId === people.asha.employeeId)).toMatchObject({ lateDays: 6, reminders: 4 });
    });

    it('lets a manager waive the deduction; it stays waived until a higher tier is reached', async () => {
      const p = (await lateMonth('manager', MONTH)).penalties.find((x: { kind: string }) => x.kind === 'late_coming');
      expect((await as('asha').post(`/attendance/penalties/${p.id}/waive`).send({ reason: 'Please' })).status).toBe(403);
      ok(await as('manager').post(`/attendance/penalties/${p.id}/waive`).send({ reason: 'Metro strike this month' }), 201);
      expect(await notes('asha', 'attendance.penalty_waived')).toBe(1);
      const r = (await lateMonth('manager', MONTH)).reminders.find((x: { status: string; sequence: number }) => x.status === 'sent' && x.sequence === 4);
      ok(await as('manager').post(`/attendance/late/reminders/${r.id}/withdraw`).send({ reason: 'Approved late start' }), 201);
      // Back to 3 reminders: still the waived tier, still waived.
      let pen = (await lateMonth('hr', MONTH)).penalties.find((x: { kind: string }) => x.kind === 'late_coming');
      expect(pen).toMatchObject({ status: 'waived', reminderCount: 3, statusReason: 'Metro strike this month', statusBy: 'Manu Manager' });
      // Reaching 5 again (two more late days) is a higher tier, so the deduction applies again.
      ok(await as('manager').post('/attendance/late/reminders').send({ employeeId: people.asha.employeeId, workDate: SEPT_WEEKDAYS[5] }), 201);
      ok(await as('manager').post('/attendance/late/reminders').send({ employeeId: people.asha.employeeId, workDate: SEPT_WEEKDAYS[9], note: 'Missed the 09:00 stand-up' }), 201);
      pen = (await lateMonth('hr', MONTH)).penalties.find((x: { kind: string }) => x.kind === 'late_coming');
      expect(pen).toMatchObject({ status: 'active', basis: 'days', value: '1', reminderCount: 5 });
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'late_reminder.sent' })).toBeGreaterThanOrEqual(9);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'attendance_penalty.waived' })).toBe(1);
    });
  });

  describe('same-day leave', () => {
    let casual: string;
    let sick: string;
    const apply = async (who: string, startDate: string, endDate = startDate, leaveTypeId = casual) => ok(await as(who).post('/leave/requests').send({ leaveTypeId, startDate, endDate }), 201);
    const inboxItem = async (who: string, requestId: string) => (ok(await as(who).get('/approvals/inbox')) as unknown as { id: string; resourceId: string; summary: string; details: any }[]).find((i) => i.resourceId === requestId)!;

    beforeAll(async () => {
      casual = ok(await as('hr').post('/leave/types').send({ code: 'CL', name: 'Casual leave' }), 201).id;
      sick = ok(await as('hr').post('/leave/types').send({ code: 'SL', name: 'Sick leave' }), 201).id;
      for (const id of [casual, sick]) ok(await as('hr').post('/leave/policies').send({ leaveTypeId: id, accrualMethod: 'none', annualEntitlement: '0' }), 201);
    });

    it('is marked on the request even with no penalty rule, and future leave is not', async () => {
      const future = await apply('bala', weekdayIn(20));
      expect(future).toMatchObject({ sameDay: false, penalty: null });
      const today = await apply('bala', lastWeekday());
      expect(today).toMatchObject({ sameDay: true, appliedOn: istToday(), penalty: null });
      const item = await inboxItem('manager', today.id);
      expect(item.details.sameDayLeave).toMatchObject({ sameDay: true, policyEnabled: false, suggestedDays: null });
      ok(await as('bala').post(`/leave/requests/${today.id}/cancel`).send({}), 201);
    });

    it('gets the automatic penalty, which the approver sees and can change, and rejection removes it', async () => {
      expect((await as('hr').put('/leave/same-day-policy').send({ enabled: true, mode: 'auto', penaltyDays: '2.3' })).status).toBe(422);
      ok(await as('hr').put('/leave/same-day-policy').send({ enabled: true, mode: 'auto', penaltyDays: 2, exemptLeaveTypeIds: [sick] }));
      const r = await apply('asha', `${MONTH}-24`);
      expect(r).toMatchObject({ sameDay: true, penalty: { days: '2', source: 'auto', status: 'active' } });
      expect(await notes('asha', 'leave.same_day_penalty')).toBe(1);
      const item = await inboxItem('manager', r.id);
      expect(item.summary).toMatch(/Same-day leave: 2 days' pay penalty applied automatically/);
      expect(item.details.sameDayLeave).toMatchObject({ mode: 'auto', suggestedDays: '2', penalty: { days: '2', source: 'auto' } });
      // The employee cannot change it; the manager can, in half days.
      expect((await as('asha').post(`/leave/requests/${r.id}/penalty`).send({ days: '0.5' })).status).toBe(403);
      expect((await as('manager').post(`/leave/requests/${r.id}/penalty`).send({ days: '1.2' })).status).toBe(422);
      const changed = ok(await as('manager').post(`/leave/requests/${r.id}/penalty`).send({ days: '3.5', reason: 'Third time this quarter' }), 201);
      expect(changed).toMatchObject({ value: '3.5', source: 'manual', status: 'active', deduction: "3.5 days' pay" });
      ok(await as('manager').post(`/approvals/${item.id}/approve`).send({}));
      // Sick leave is exempt; a rejected request loses its penalty.
      const s = await apply('asha', `${MONTH}-25`, `${MONTH}-25`, sick);
      expect(s).toMatchObject({ sameDay: true, penalty: null });
      const other = await apply('asha', `${MONTH}-28`);
      expect(other.penalty).toMatchObject({ days: '2', status: 'active' });
      ok(await as('manager').post(`/approvals/${(await inboxItem('manager', other.id)).id}/reject`).send({ comment: 'Not this time' }));
      expect((await pool.find('attendance_penalties', { tenant_id: t.id, leave_request_id: other.id }))[0]).toMatchObject({ status: 'cancelled' });
    });

    it('in manual mode only suggests a penalty, which the manager applies or leaves out', async () => {
      ok(await as('hr').put('/leave/same-day-policy').send({ enabled: true, mode: 'manual', penaltyDays: '1.5' }));
      const r = await apply('bala', lastWeekday());
      expect(r.penalty).toBeNull();
      const item = await inboxItem('manager', r.id);
      expect(item.summary).toMatch(/you can apply a penalty \(suggested 1.5 days' pay\)/);
      expect(item.details.sameDayLeave).toMatchObject({ mode: 'manual', suggestedDays: '1.5', penalty: null });
      const p = ok(await as('manager').post(`/leave/requests/${r.id}/penalty`).send({ days: '1.5' }), 201);
      ok(await as('manager').post(`/attendance/penalties/${p.id}/waive`).send({ reason: 'Family emergency' }), 201);
      expect((await as('manager').post(`/attendance/penalties/${p.id}/waive`).send({ reason: 'Again' })).body.error.code).toBe('invalid_state');
      expect(ok(await as('bala').get(`/leave/requests/${r.id}`)).penalty).toMatchObject({ status: 'waived', statusReason: 'Family emergency' });
    });
  });

  describe('payroll', () => {
    it('deducts the late-coming tier and the approved same-day leave penalty as payslip lines', async () => {
      const structureId = (ok(await as('payroll').get('/payroll/structures')) as unknown as { id: string; name: string }[]).find((s) => s.name === 'Standard')!.id;
      ok(await as('payroll').post(`/payroll/salaries/${people.asha.employeeId}`).send({ effectiveFrom: '2026-04-01', annualCtc: '600000', structureId }), 201);
      const starting = ok(await as('payroll').get('/payroll/statutory')).startingValues.settings;
      ok(await as('payroll').post('/payroll/statutory').send({ legalEntityId: t.legalEntityId, effectiveFrom: '2026-04-01', lopSource: 'attendance_and_leave', settings: starting }), 201);
      const runId = ok(await as('payroll').post('/payroll/runs').send({ legalEntityId: t.legalEntityId, month: MONTH, payDate: '2026-09-30' }), 201).id;
      ok(await as('payroll').post(`/payroll/runs/${runId}/compute`));
      const run = ok(await as('payroll').get(`/payroll/runs/${runId}`));
      const item = run.items.find((i: { name: string }) => i.name === 'Asha Rao');
      const detail = ok(await as('payroll').get(`/payroll/runs/${runId}/items/${item.id}`));
      const pen = detail.lines.filter((l: { code: string }) => l.code.startsWith('PEN'));
      // Monthly gross 48,200 (25,000 + 10,000 + 13,200): one day = 48,200 / 30 = 1,606.67, rounded to the rupee.
      expect(pen.map((l: { name: string; amount: string }) => [l.name, l.amount])).toEqual([
        ['Late-coming deduction (5 reminders)', '1607.00'],
        [`Same-day leave penalty (${MONTH}-24)`, '5623.00'],
      ]);
      expect(pen[1].explanation).toMatch(/x 3.5 day\(s\)\. Applied by a manager/);
      expect(detail.explanation.join(' ')).toMatch(/2 attendance penalties deducted this month/);
    });

    it('stops changes to a month that payroll has locked', async () => {
      await pool.insert('attendance_periods', { tenant_id: t.id, legal_entity_id: null, period_start: `${MONTH}-01`, period_end: `${MONTH}-30`, note: 'Locked by test' });
      const p = (await lateMonth('manager', MONTH)).penalties.find((x: { kind: string; status: string }) => x.kind === 'late_coming');
      expect((await as('manager').post(`/attendance/penalties/${p.id}/waive`).send({ reason: 'Too late' })).body.error.code).toBe('period_locked');
      expect((await as('manager').post('/attendance/late/reminders').send({ employeeId: people.asha.employeeId, workDate: SEPT_WEEKDAYS[11], note: 'x' })).body.error.code).toBe('period_locked');
    });
  });
});
