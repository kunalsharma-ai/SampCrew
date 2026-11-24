import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, leaveType, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * What people see after asking for something: a leave request says who it waits for, the asker is told, the leave
 * calendar shows it; HR's helpdesk queue counts employees' questions; announcements reach members who have no
 * employee record (the owner); and a workspace starts with leave types (or gets them in one step).
 */
describe('requests feedback, HR helpdesk, announcements and the leave calendar', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const year = new Date().getUTCFullYear() + 1;
  const day = (md: string) => `${year}-${md}`;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { standardLeaveTypes: true });
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.mgr = await addMember(pool, t, { roles: ['department_manager'], name: 'Mona Manager' });
    people.emp = await addMember(pool, t, { managerId: people.mgr.membershipId, name: 'Eli Employee' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    const hire = async (who: string, first: string, extra: Record<string, unknown> = {}) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0,
        membershipId: people[who]!.membershipId, onboardingTemplateId: null, ...extra,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('hr', 'Hana');
    await hire('mgr', 'Mona');
    await hire('emp', 'Eli', { managerEmployeeId: people.mgr.employeeId });
    tokens.emp = (await login(app, people.emp.email)).accessToken;
    tokens.mgr = (await login(app, people.mgr.email)).accessToken;
    tokens.owner = (await login(app, t.ownerEmail)).accessToken;
    tokens.super = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    // Leave without pay, reviewed by the manager and then HR.
    await leaveType(app, tokens.super, { code: 'LWP', name: 'Leave without pay', paid: false, category: 'unpaid', policy: { accrualMethod: 'none', annualEntitlement: '0' }, approval: { managerFirst: true, routes: ['hr'] } });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('shows the example leave types as Not Assigned: nothing is credited to new employees by itself', async () => {
    const b = ok(await as('emp').get('/leave/balances'));
    expect(b.balances.map((x: { code: string }) => x.code).sort()).toEqual(['CL', 'LWP', 'PL', 'SL']);
    expect(ok(await as('emp').get('/leave/types')).find((x: { code: string }) => x.code === 'PL')).toMatchObject({ name: 'Permanent Leave' });
    expect(b.balances.find((x: { code: string }) => x.code === 'CL')).toMatchObject({ notAssigned: true, assigned: null, available: null });
  });

  it('tells the person who their leave request waits for, and shows it on their calendar', async () => {
    // Leave without pay has no balance, so a date next year works whenever the test runs.
    const lwp = ok(await as('emp').get('/leave/balances')).balances.find((x: { code: string }) => x.code === 'LWP');
    const r = ok(await as('emp').post('/leave/requests').set('idempotency-key', crypto.randomUUID()).send({ leaveTypeId: lwp.leaveTypeId, startDate: day('03-03'), endDate: day('03-03') }), 201);
    expect(r.status).toBe('pending');
    expect(r.waitingOn).toBe('Mona Manager');
    const list = ok(await as('emp').get('/leave/requests?scope=mine'));
    expect(list.find((x: { id: string }) => x.id === r.id).waitingOn).toBe('Mona Manager');
    // The asker sees who it waits for on the request itself and gets no notice about their own action (issue #83);
    // the approver is asked.
    expect(await pool.count('notifications', { membership_id: people.emp.membershipId, kind: 'approval.submitted' })).toBe(0);
    expect(await pool.count('notifications', { membership_id: people.mgr.membershipId, kind: 'approval.requested' })).toBe(1);

    const calendars = ok(await as('hr').get('/leave/calendars'));
    const def = calendars.find((c: { isDefault: boolean }) => c.isDefault);
    ok(await as('hr').post(`/leave/calendars/${def.id}/holidays`).send({ date: day('03-10'), name: 'Founders Day' }), 201);
    const cal = ok(await as('emp').get(`/leave/calendar?from=${day('03-01')}&to=${day('03-31')}`));
    expect(cal.weeklyOffs).toEqual([0, 6]);
    expect(cal.holidays).toEqual([{ date: day('03-10'), name: 'Founders Day', optional: false }]);
    expect(cal.requests.map((x: { id: string; status: string; waitingOn: string }) => [x.id, x.status, x.waitingOn])).toEqual([[r.id, 'pending', 'Mona Manager']]);
    // Another month holds none of it, and nobody else's leave is ever on the calendar.
    expect(ok(await as('emp').get(`/leave/calendar?from=${day('04-01')}&to=${day('04-30')}`)).requests).toEqual([]);
    expect(ok(await as('mgr').get(`/leave/calendar?from=${day('03-01')}&to=${day('03-31')}`)).requests).toEqual([]);

    // Once decided by the manager and then HR, it no longer says it is waiting.
    const inbox = ok(await as('mgr').get('/approvals/inbox'));
    ok(await as('mgr').post(`/approvals/${inbox[0].id}/approve`).send({}));
    expect(ok(await as('emp').get(`/leave/requests/${r.id}`)).waitingOn).toBe('Hana HR');
    ok(await as('hr').post(`/approvals/${inbox[0].id}/approve`).send({}));
    const after = ok(await as('emp').get(`/leave/calendar?from=${day('03-01')}&to=${day('03-31')}`)).requests[0];
    expect([after.status, after.waitingOn]).toEqual(['approved', null]);
  });

  it('counts employees’ questions for HR, who handle them in the queue rather than asking', async () => {
    const cats = ok(await as('emp').get('/helpdesk/categories'));
    const c = ok(await as('emp').post('/helpdesk/cases').send({ categoryId: cats[0].id, subject: 'Where is my payslip?', description: 'I cannot find my October payslip anywhere.', priority: 'normal' }), 201);
    const summary = ok(await as('hr').get('/helpdesk/summary'));
    expect(summary.queue).toEqual({ awaitingHr: 1, unassigned: 1 });
    expect(ok(await as('emp').get('/helpdesk/summary')).queue).toBeNull();
    const queue = ok(await as('hr').get('/helpdesk/cases?view=queue&status=active'));
    expect(queue.map((x: { id: string }) => x.id)).toContain(c.id);
    expect((await pool.find('notifications', { membership_id: people.hr.membershipId, kind: 'helpdesk.case_new' })).length).toBe(1);
    // A closed case still shows with status=all.
    await pool.update('helpdesk_cases', { id: c.id }, { $set: { status: 'closed' } });
    expect(ok(await as('emp').get('/helpdesk/cases?view=mine&status=active')).length).toBe(0);
    expect(ok(await as('emp').get('/helpdesk/cases?view=mine&status=all')).map((x: { id: string }) => x.id)).toEqual([c.id]);
  });

  it('shows announcements to the owner, who has no employee record', async () => {
    expect(await pool.count('employees', { tenant_id: t.id, membership_id: t.ownerMembershipId })).toBe(0);
    const a = ok(await as('hr').post('/announcements').send({ title: 'Office closed Friday', body: 'The office is closed this Friday for maintenance.', requiresAck: true, pinned: false }), 201);
    const published = ok(await as('hr').post(`/announcements/${a.id}/publish`).send({}));
    expect(published.audience).toBe(4);
    expect(await pool.count('notifications', { membership_id: t.ownerMembershipId, kind: 'announcement' })).toBe(1);
    const feed = ok(await as('owner').get('/announcements'));
    expect(feed.map((x: { id: string }) => x.id)).toEqual([a.id]);
    const read = ok(await as('owner').get(`/announcements/${a.id}`));
    expect(read.inAudience).toBe(true);
    ok(await as('owner').post(`/announcements/${a.id}/acknowledge`).send({}));
    const detail = ok(await as('hr').get(`/announcements/manage/${a.id}`));
    const owner = detail.people.find((p: { membershipId: string }) => p.membershipId === t.ownerMembershipId);
    expect(owner.name).toBe('Owner Person');
    expect(owner.acknowledgedAt).toBeTruthy();
  });

  it('starts a workspace with no leave types; a type the Super Workspace creates reaches people as Not Assigned', async () => {
    const bare = await createTenant(pool);
    const hr = await addMember(pool, bare, { roles: ['hr_admin'], name: 'Bea HR' });
    const token = (await loginWithMfa(app, pool, hr.email)).accessToken;
    const sup = (await loginWithMfa(app, pool, bare.ownerEmail)).accessToken;
    ok(await api(app, token).post('/employees').send({ legalEntityId: bare.legalEntityId, firstName: 'Bea', lastName: 'HR', dateOfJoining: '2024-01-01', membershipId: hr.membershipId, onboardingTemplateId: null }), 201);
    expect(ok(await api(app, token).get('/leave/balances')).balances).toEqual([]);
    // The old starter and template endpoints are gone.
    expect((await api(app, sup).post('/leave/types/starter').send({})).status).toBe(404);
    const sl = ok(await api(app, sup).post('/leave/types').send({ name: 'Sick Leave', visibility: 'both' }), 201);
    expect(sl).toMatchObject({ code: 'SL', visibility: 'both' });
    expect(ok(await api(app, token).get('/leave/balances')).balances.find((x: { code: string }) => x.code === 'SL')).toMatchObject({ notAssigned: true, available: null });
  });
});
